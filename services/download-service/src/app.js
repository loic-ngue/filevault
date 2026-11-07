const express = require('express');
const helmet = require('helmet');
const client = require('prom-client');
const { createDecryptStream } = require('./crypto');

const MIME = /^[\w.+-]+\/[\w.+-]+$/;
const EXPIRED = 'Lien expiré ou invalide.'; // EF-06

// Réponses de link-service relayées telles quelles au destinataire.
const FORWARDED = new Set([401, 410, 429]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Nom ASCII pour les anciens navigateurs, nom UTF-8 complet pour les autres (RFC 6266).
function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Un formulaire du navigateur reçoit une page lisible, un appel fetch reçoit du JSON.
function sendError(req, res, status, message) {
  res.status(status);
  if (req.accepts(['json', 'html']) === 'html') {
    return res.type('html').send(
      `<!doctype html><html lang="fr"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1"><title>FileVault</title></head>` +
        `<body><main><h1>Téléchargement impossible</h1><p>${escapeHtml(message)}</p>` +
        `<p><a href="/">Retour à FileVault</a></p></main></body></html>`,
    );
  }
  res.json({ error: message });
}

function createApp({ config, storage, links, log = () => {} }) {
  const app = express();

  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const downloads = new client.Counter({
    name: 'filevault_downloads_total',
    help: 'Téléchargements par résultat',
    labelNames: ['result'],
    registers: [registry],
  });
  const downloadedBytes = new client.Counter({
    name: 'filevault_downloaded_bytes_total',
    help: 'Octets téléchargés (en clair)',
    registers: [registry],
  });

  app.disable('x-powered-by');
  app.use(helmet()); // ES-11 ; Referrer-Policy no-referrer : le jeton ne fuit pas vers d'autres sites.

  // Sonde de vie : ne teste que le processus. Si MinIO tombe, redémarrer ce service ne servirait à rien.
  app.get('/live', (req, res) => res.json({ status: 'ok' }));

  // Sonde de disponibilité : sans MinIO, le pod ne reçoit plus de trafic.
  app.get('/health', async (req, res) => {
    try {
      await storage.ready();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'stockage indisponible' });
    }
  });

  app.get('/metrics', async (req, res) => {
    res.type(registry.contentType).send(await registry.metrics());
  });

  // Le lien partagé ne télécharge rien : les aperçus de WhatsApp ou des messageries
  // ouvrent les liens en GET et videraient le compteur. Il renvoie vers la page du
  // frontend, qui affiche les informations du fichier (EF-10) et le bouton Télécharger.
  // Le jeton passe dans le fragment (#), jamais envoyé aux serveurs ni journalisé.
  app.get('/d/:token', (req, res) => {
    res.set('Cache-Control', 'no-store').redirect(302, `/#/d/${encodeURIComponent(req.params.token)}`);
  });

  // EF-05 : décompte un téléchargement puis envoie le fichier déchiffré, nom et type d'origine.
  app.post('/d/:token', express.urlencoded({ extended: false, limit: '2kb' }), express.json({ limit: '2kb' }), async (req, res) => {
    const password = req.body && typeof req.body.password === 'string' ? req.body.password : undefined;

    let result;
    try {
      result = await links.consume(req.params.token, password);
    } catch (err) {
      log({ event: 'link_service_error', message: err.message });
      throw new HttpError(502, 'Service des liens indisponible.');
    }
    if (FORWARDED.has(result.status)) {
      throw new HttpError(result.status, result.body.error || EXPIRED);
    }
    if (result.status !== 200) throw new HttpError(502, 'Service des liens indisponible.');

    const { fileId, name, size, mime, remainingDownloads } = result.body;
    let object;
    try {
      object = await storage.get(fileId);
    } catch (err) {
      log({ event: 'storage_error', fileId, message: err.message });
      throw new HttpError(502, 'Stockage indisponible.');
    }
    // Déjà supprimé par cleanup : le lien vient d'expirer.
    if (!object) throw new HttpError(410, EXPIRED);

    res.set({
      'Content-Type': MIME.test(mime) ? mime : 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'no-store',
      // Même un fichier HTML déposé ne peut pas s'exécuter dans le navigateur.
      'Content-Security-Policy': "sandbox; default-src 'none'",
    });

    const decrypt = createDecryptStream(config.masterKey, fileId);
    object.on('error', (err) => decrypt.destroy(err));
    res.on('close', () => {
      if (!res.writableFinished) object.destroy();
    });
    decrypt.on('error', (err) => {
      object.destroy();
      downloads.inc({ result: 'integrity_failed' });
      log({ event: 'integrity_failed', fileId, message: err.message });
      if (!res.headersSent) {
        for (const header of ['Content-Type', 'Content-Length', 'Content-Disposition', 'Content-Security-Policy']) {
          res.removeHeader(header);
        }
        return sendError(req, res, 500, 'Le fichier stocké est illisible.');
      }
      // Des octets sont déjà partis : on coupe la connexion. Le navigateur voit un
      // téléchargement incomplet (Content-Length non atteint) au lieu d'un fichier faux.
      res.destroy(err);
    });
    decrypt.on('end', () => {
      downloads.inc({ result: 'ok' });
      downloadedBytes.inc(size);
      // ES-12 : ni nom de fichier ni jeton dans les journaux.
      log({ event: 'downloaded', fileId, size, remaining: remainingDownloads });
    });
    object.pipe(decrypt).pipe(res);
  });

  app.use((req, res) => res.status(404).json({ error: 'Ressource introuvable.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      downloads.inc({ result: `error_${err.status}` });
      return sendError(req, res, err.status, err.message);
    }
    if (err.type === 'entity.parse.failed') return sendError(req, res, 400, 'Requête invalide.');
    if (err.type === 'entity.too.large') return sendError(req, res, 413, 'Requête trop volumineuse.');
    log({ event: 'error', message: err.message });
    sendError(req, res, 500, 'Erreur interne.');
  });

  return app;
}

module.exports = { createApp, contentDisposition };
