const express = require('express');
const helmet = require('helmet');
const client = require('prom-client');
const { createDecryptStream } = require('./crypto');

const MIME = /^[\w.+-]+\/[\w.+-]+$/;
const EXPIRED = 'Lien expiré ou invalide.';

const FORWARDED = new Set([401, 410, 429]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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
  app.use(helmet());

  app.get('/live', (req, res) => res.json({ status: 'ok' }));

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

  app.get('/d/:token', (req, res) => {
    res.set('Cache-Control', 'no-store').redirect(302, `/#/d/${encodeURIComponent(req.params.token)}`);
  });

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
    if (!object) throw new HttpError(410, EXPIRED);

    res.set({
      'Content-Type': MIME.test(mime) ? mime : 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': contentDisposition(name),
      'Cache-Control': 'no-store',
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
      res.destroy(err);
    });
    decrypt.on('end', () => {
      downloads.inc({ result: 'ok' });
      downloadedBytes.inc(size);
      log({ event: 'downloaded', fileId, size, remaining: remainingDownloads });
    });
    object.pipe(decrypt).pipe(res);
  });

  app.use((req, res) => res.status(404).json({ error: 'Ressource introuvable.' }));

  app.use((err, req, res, _next) => {
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
