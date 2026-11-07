const Redis = require('ioredis');
const Minio = require('minio');
const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { createMinioStorage, createLinkClient } = require('./clients');

const log = (entry) => console.log(JSON.stringify({ service: 'upload-service', time: new Date().toISOString(), ...entry }));

async function main() {
  const config = loadConfig();
  const redis = new Redis(config.redisUrl);
  const storage = createMinioStorage(new Minio.Client(config.minio), config.bucket);
  const links = createLinkClient({ baseUrl: config.linkServiceUrl, internalToken: config.internalToken });

  await storage.ensureBucket();
  const server = createApp({ config, redis, storage, links, log }).listen(config.port, () => {
    log({ event: 'started', port: config.port });
  });

  // Kubernetes envoie SIGTERM avant d'arrêter le pod : on termine les dépôts en cours.
  process.on('SIGTERM', () => {
    server.close(() => redis.quit().finally(() => process.exit(0)));
  });
}

main().catch((err) => {
  log({ event: 'error', message: err.message });
  process.exit(1);
});
