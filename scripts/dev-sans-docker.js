// Lance FileVault complet sur http://localhost:8080 sans Docker, pour développer le
// frontend ou faire une démo rapide. Les vrais services tournent dans un seul processus,
// routés comme par l'Ingress ; Redis est simulé (ioredis-mock) et MinIO est remplacé par
// un stockage en mémoire. Tout est perdu à l'arrêt.
//
// Prérequis : npm install dans chaque dossier de services/.
// Usage : node scripts/dev-sans-docker.js   (jeton admin affiché au démarrage)
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const services = path.join(__dirname, '..', 'services');
const load = (service, mod) => require(path.join(services, service, mod));

const PORT = Number(process.env.PORT || 8080);
const INTERNAL_TOKEN = crypto.randomBytes(16).toString('hex');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'admin-dev';
const MASTER_KEY = crypto.randomBytes(32).toString('base64');

const objects = new Map();
const storage = {
  async put(fileId, stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    objects.set(fileId, Buffer.concat(chunks));
  },
  remove: async (fileId) => objects.delete(fileId),
  get: async (fileId) => (objects.has(fileId) ? Readable.from([objects.get(fileId)]) : null),
  ready: async () => true,
};

const log = (entry) => console.log(JSON.stringify(entry));
const linkUrl = `http://127.0.0.1:${PORT}`;

const LinkRedis = load('link-service', 'node_modules/ioredis-mock');
const linkRedis = new LinkRedis();
const link = load('link-service', 'src/app').createApp({
  config: load('link-service', 'src/config').loadConfig({
    INTERNAL_TOKEN,
    ADMIN_TOKEN,
    // 5 min en plus pour les recettes R-01 et R-04.
    ALLOWED_DURATIONS: '5m,10m,1h,24h,7d',
    BCRYPT_COST: '10',
  }),
  redis: linkRedis,
  log,
});

const UploadRedis = load('upload-service', 'node_modules/ioredis-mock');
const upload = load('upload-service', 'src/app').createApp({
  config: load('upload-service', 'src/config').loadConfig({ MASTER_KEY, UPLOADS_PER_HOUR: '100' }),
  redis: new UploadRedis(),
  storage,
  links: load('upload-service', 'src/clients').createLinkClient({ baseUrl: linkUrl, internalToken: INTERNAL_TOKEN }),
  log,
});

const download = load('download-service', 'src/app').createApp({
  config: load('download-service', 'src/config').loadConfig({ MASTER_KEY }),
  storage,
  links: load('download-service', 'src/clients').createLinkClient({ baseUrl: linkUrl, internalToken: INTERNAL_TOKEN }),
  log,
});

const express = load('link-service', 'node_modules/express');
const frontend = express();
frontend.get('/config.json', (req, res) => {
  const config = require(path.join(services, 'frontend', 'public', 'config.json'));
  res.json({ ...config, durations: [{ value: '5m', label: '5 minutes (démo)' }, ...config.durations] });
});
frontend.use(express.static(path.join(services, 'frontend', 'public'), { etag: false, maxAge: 0 }));

// CronJob cleanup simulé : toutes les 30 s.
const { runCleanup } = load('cleanup', 'src/cleanup');
setInterval(() => runCleanup({ redis: linkRedis, storage, log }).catch((err) => log({ event: 'cleanup_error', message: err.message })), 30_000);

http
  .createServer((req, res) => {
    if (req.url.startsWith('/api/upload')) return upload(req, res);
    if (req.url.startsWith('/api/links')) return link(req, res);
    if (req.url.startsWith('/d/')) return download(req, res);
    frontend(req, res);
  })
  .listen(PORT, () => {
    console.log(`FileVault (dev, sans Docker) : http://localhost:${PORT}`);
    console.log(`Jeton administrateur : ${ADMIN_TOKEN}`);
  });
