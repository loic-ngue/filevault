const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const busboy = require('busboy');
const client = require('prom-client');
const { createEncryptStream } = require('./crypto');

// Marge pour les en-têtes multipart et les champs autour du fichier.
const MULTIPART_OVERHEAD = 64 * 1024;
const INTERRUPTED = 'Requête multipart invalide ou interrompue.';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Garde le nom affiché au destinataire, sans chemin ni caractère de contrôle.
function cleanName(filename) {
  const base = String(filename || '')
    .split(/[\\/]/)
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  return (base || 'fichier').slice(0, 255);
}

// Lit le formulaire multipart et chiffre le fichier vers le stockage au fil de l'eau.
// Les champs duration et maxDownloads doivent précéder le fichier dans le formulaire.
// En cas d'échec, l'objet éventuellement stocké est supprimé.
function receiveFile(req, { maxFileSize, masterKey, storage, tooLarge }) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: { files: 1, fields: 5, fieldSize: 1024, fileSize: maxFileSize },
      });
    } catch {
      return reject(new HttpError(400, 'Envoyer le fichier en multipart/form-data.'));
    }

    const fields = {};
    let failure = null;
    let upload = null;
    let finished = false;
    const fail = (err) => {
      failure = failure || err;
    };

    const finish = async () => {
      if (finished) return;
      finished = true;
      if (upload) await upload.stored;
      if (!upload) fail(new HttpError(400, 'Aucun fichier reçu.'));
      if (failure) {
        if (upload) await storage.remove(upload.fileId).catch(() => {});
        return reject(failure);
      }
      resolve({
        fields,
        file: { fileId: upload.fileId, name: upload.name, mime: upload.mime, size: upload.encrypt.plaintextBytes },
      });
    };

    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('filesLimit', () => fail(new HttpError(400, 'Un seul fichier par envoi.')));
    bb.on('file', (name, file, info) => {
      if (name !== 'file' || upload) {
        fail(new HttpError(400, 'Envoyer un seul fichier, dans le champ « file ».'));
        return file.resume();
      }
      if (!fields.duration || !fields.maxDownloads) {
        fail(new HttpError(400, 'Les champs duration et maxDownloads doivent précéder le fichier.'));
        return file.resume();
      }
      const fileId = crypto.randomBytes(16).toString('base64url');
      const encrypt = createEncryptStream(masterKey, fileId);
      // L'erreur est déjà retenue par fail() : sans cet écouteur, un flux détruit
      // alors que le stockage ne le lit plus ferait planter le processus.
      encrypt.on('error', () => {});
      // Arrête le chiffrement mais continue de vider la requête pour pouvoir répondre.
      const abort = (err) => {
        fail(err);
        file.unpipe(encrypt);
        encrypt.destroy(err);
        file.resume();
      };
      file.on('limit', () => abort(new HttpError(413, tooLarge)));
      file.on('error', () => abort(new HttpError(400, INTERRUPTED)));
      file.pipe(encrypt);
      upload = {
        fileId,
        name: cleanName(info.filename),
        mime: info.mimeType || 'application/octet-stream',
        encrypt,
        abort,
        stored: storage
          .put(fileId, encrypt)
          .catch((err) => abort(err instanceof HttpError ? err : new HttpError(502, 'Stockage indisponible.'))),
      };
    });

    // Formulaire mal formé ou connexion coupée par le client.
    const broken = () => {
      const err = new HttpError(400, INTERRUPTED);
      if (upload) upload.abort(err);
      else fail(err);
      finish();
    };
    bb.on('error', broken);
    req.on('error', broken);
    bb.on('close', finish);
    req.pipe(bb);
  });
}

function createApp({ config, redis, storage, links, log = () => {} }) {
  const app = express();
  const tooLarge = `Fichier trop volumineux : ${Math.round(config.maxFileSize / 1024 / 1024)} Mo maximum.`;

  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const uploads = new client.Counter({
    name: 'filevault_uploads_total',
    help: 'Dépôts de fichiers par résultat',
    labelNames: ['result'],
    registers: [registry],
  });
  const uploadedBytes = new client.Counter({
    name: 'filevault_uploaded_bytes_total',
    help: 'Octets déposés (en clair)',
    registers: [registry],
  });

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(helmet()); // ES-11

  // Sonde de vie : ne teste que le processus. Si MinIO tombe, redémarrer ce service ne servirait à rien.
  app.get('/live', (req, res) => res.json({ status: 'ok' }));

  // Sonde de disponibilité : sans Redis ou MinIO, le pod ne reçoit plus de trafic.
  app.get('/health', async (req, res) => {
    try {
      await Promise.all([redis.ping(), storage.ready()]);
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'dépendance indisponible' });
    }
  });

  app.get('/metrics', async (req, res) => {
    res.type(registry.contentType).send(await registry.metrics());
  });

  // ES-05 : 10 dépôts par adresse IP et par heure, compteur partagé entre les copies.
  const limitUploads = async (req, res, next) => {
    const key = `uploads:${req.ip}`;
    const [[, count]] = await redis.multi().incr(key).expire(key, 3600, 'NX').exec();
    if (count > config.uploadsPerHour) {
      uploads.inc({ result: 'rate_limited' });
      req.resume();
      return res.status(429).json({ error: `Trop de dépôts : ${config.uploadsPerHour} par heure maximum.` });
    }
    next();
  };

  // EF-01 : dépôt d'un fichier, chiffré (ES-01) puis lié à un lien temporaire.
  app.post('/api/upload', limitUploads, async (req, res) => {
    if (Number(req.get('content-length')) > config.maxFileSize + MULTIPART_OVERHEAD) {
      req.resume();
      throw new HttpError(413, tooLarge);
    }
    const { fields, file } = await receiveFile(req, { ...config, storage, tooLarge });

    let result = null;
    try {
      result = await links.create({
        fileId: file.fileId,
        name: file.name,
        size: file.size,
        mime: file.mime,
        duration: fields.duration,
        maxDownloads: Number(fields.maxDownloads),
        ...(fields.password ? { password: fields.password } : {}),
      });
    } catch (err) {
      log({ event: 'link_service_error', message: err.message });
    }

    if (!result || result.status !== 201) {
      await storage.remove(file.fileId).catch(() => {});
      if (result && result.status === 400) throw new HttpError(400, result.body.error || 'Requête invalide.');
      throw new HttpError(502, 'Service des liens indisponible.');
    }

    uploads.inc({ result: 'ok' });
    uploadedBytes.inc(file.size);
    // ES-12 : ni nom de fichier ni jeton dans les journaux.
    log({ event: 'uploaded', fileId: file.fileId, size: file.size, duration: fields.duration });
    res.status(201).json({ ...result.body, path: `/d/${result.body.token}` });
  });

  app.use((req, res) => res.status(404).json({ error: 'Ressource introuvable.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) {
      uploads.inc({ result: `error_${err.status}` });
      return res.status(err.status).json({ error: err.message });
    }
    log({ event: 'error', message: err.message });
    res.status(500).json({ error: 'Erreur interne.' });
  });

  return app;
}

module.exports = { createApp, cleanName };
