const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const client = require('prom-client');
const { createStore } = require('./store');
const { newToken, newRevokeCode, sha256, safeEqual, shortToken } = require('./tokens');

const EXPIRED = { error: 'Lien expiré ou invalide.' }; // EF-06
const FILE_ID = /^[A-Za-z0-9_-]{8,128}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateCreate(body, config) {
  const { fileId, name, size, mime = 'application/octet-stream', duration, maxDownloads, password } = body || {};
  if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) throw new HttpError(400, 'Identifiant de fichier invalide.');
  if (typeof name !== 'string' || name.length < 1 || name.length > 255) throw new HttpError(400, 'Nom de fichier invalide.');
  if (!Number.isInteger(size) || size < 1 || size > config.maxFileSize) throw new HttpError(400, 'Taille de fichier invalide.');
  if (typeof mime !== 'string' || mime.length > 255) throw new HttpError(400, 'Type de fichier invalide.');
  if (!Object.hasOwn(config.durations, duration)) {
    throw new HttpError(400, `Durée invalide : choisir parmi ${Object.keys(config.durations).join(', ')}.`);
  }
  if (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > config.maxDownloads) {
    throw new HttpError(400, `Nombre de téléchargements invalide : entre 1 et ${config.maxDownloads}.`);
  }
  // bcrypt ignore tout ce qui dépasse 72 octets.
  if (password !== undefined && (typeof password !== 'string' || password.length < 1 || Buffer.byteLength(password) > 72)) {
    throw new HttpError(400, 'Mot de passe invalide (1 à 72 octets).');
  }
  return { fileId, name, size, mime, duration, maxDownloads, password };
}

function createApp({ config, redis, log = () => {} }) {
  const store = createStore(redis);
  const app = express();

  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });
  const events = new client.Counter({
    name: 'filevault_link_events_total',
    help: 'Événements sur les liens',
    labelNames: ['event'],
    registers: [registry],
  });
  const record = (event, fields) => {
    events.inc({ event });
    log({ event, ...fields });
  };

  const requireToken = (expected) => (req, res, next) => {
    const header = req.get('authorization') || '';
    if (!safeEqual(header.replace(/^Bearer /, ''), expected)) return res.status(401).json({ error: 'Non autorisé.' });
    next();
  };
  const internalOnly = requireToken(config.internalToken);
  const adminOnly = requireToken(config.adminToken);

  app.disable('x-powered-by');
  app.use(helmet()); // ES-11
  app.use(express.json({ limit: '10kb' }));

  // Sonde de vie : ne teste que le processus. Si Redis tombe, redémarrer ce service ne servirait à rien.
  app.get('/live', (req, res) => res.json({ status: 'ok' }));

  // Sonde de disponibilité : sans Redis, le pod ne reçoit plus de trafic.
  app.get('/health', async (req, res) => {
    try {
      await redis.ping();
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'redis indisponible' });
    }
  });

  app.get('/metrics', async (req, res) => {
    res.type(registry.contentType).send(await registry.metrics());
  });

  // Appelé par upload-service une fois le fichier chiffré stocké dans MinIO.
  app.post('/api/links', internalOnly, async (req, res) => {
    const input = validateCreate(req.body, config);
    const token = newToken();
    const revokeCode = newRevokeCode();
    const link = {
      fileId: input.fileId,
      name: input.name,
      size: input.size,
      mime: input.mime,
      maxDownloads: input.maxDownloads,
      revokeHash: sha256(revokeCode),
      passwordHash: input.password ? await bcrypt.hash(input.password, config.bcryptCost) : '',
    };
    const expiresAt = await store.create(token, link, config.durations[input.duration]);
    record('created', { token: shortToken(token), size: input.size, duration: input.duration });
    res.status(201).json({
      token,
      revokeCode,
      expiresAt: new Date(expiresAt).toISOString(),
      maxDownloads: input.maxDownloads,
    });
  });

  // EF-11 : déclaré avant /:token pour ne pas être pris pour un jeton.
  app.get('/api/links/stats', adminOnly, async (req, res) => {
    res.json(await store.stats());
  });

  // EF-10 : ce que voit le destinataire avant de télécharger.
  app.get('/api/links/:token', async (req, res) => {
    const link = await store.get(req.params.token);
    if (!link) return res.status(410).json(EXPIRED);
    res.json({
      name: link.name,
      size: link.size,
      mime: link.mime,
      expiresAt: new Date(link.expiresAt).toISOString(),
      remainingDownloads: link.remaining,
      passwordRequired: link.passwordHash !== '',
    });
  });

  // Appelé par download-service : vérifie le mot de passe puis décompte un téléchargement.
  app.post('/api/links/:token/consume', internalOnly, async (req, res) => {
    const { token } = req.params;
    const link = await store.get(token);
    if (!link) return res.status(410).json(EXPIRED);

    if (link.passwordHash) {
      // ES-04 : au-delà de 5 échecs, même le bon mot de passe est refusé jusqu'à la fin du blocage.
      if ((await store.failedAttempts(token)) >= config.maxPasswordAttempts) {
        return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
      }
      const password = req.body && req.body.password;
      const valid = typeof password === 'string' && (await bcrypt.compare(password, link.passwordHash));
      if (!valid) {
        const count = await store.recordFailedAttempt(token, config.lockSeconds);
        record('password_failed', { token: shortToken(token) });
        if (count >= config.maxPasswordAttempts) {
          return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
        }
        return res.status(401).json({ error: 'Mot de passe incorrect.' });
      }
      await store.clearFailedAttempts(token);
    }

    const remaining = await store.consume(token);
    if (remaining === null) return res.status(410).json(EXPIRED);
    record('downloaded', { token: shortToken(token), remaining });
    res.json({ fileId: link.fileId, name: link.name, size: link.size, mime: link.mime, remainingDownloads: remaining });
  });

  // EF-09 : l'expéditeur révoque son lien avec le code reçu à la création.
  app.post('/api/links/:token/revoke', async (req, res) => {
    const { token } = req.params;
    const link = await store.get(token);
    if (!link) return res.status(410).json(EXPIRED);
    const revokeCode = req.body && req.body.revokeCode;
    if (typeof revokeCode !== 'string' || !safeEqual(sha256(revokeCode), link.revokeHash)) {
      return res.status(403).json({ error: 'Code de révocation incorrect.' });
    }
    await store.revoke(token, link.fileId);
    record('revoked', { token: shortToken(token) });
    res.status(204).end();
  });

  app.use((req, res) => res.status(404).json({ error: 'Ressource introuvable.' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse.' });
    log({ event: 'error', message: err.message });
    res.status(500).json({ error: 'Erreur interne.' });
  });

  return app;
}

module.exports = { createApp };
