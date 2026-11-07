const Redis = require('ioredis');
const { createApp } = require('./app');
const { loadConfig } = require('./config');

const config = loadConfig();
const redis = new Redis(config.redisUrl);
const log = (entry) => console.log(JSON.stringify({ service: 'link-service', time: new Date().toISOString(), ...entry }));

const server = createApp({ config, redis, log }).listen(config.port, () => {
  log({ event: 'started', port: config.port });
});

// Kubernetes envoie SIGTERM avant d'arrêter le pod : on termine les requêtes en cours.
process.on('SIGTERM', () => {
  server.close(() => redis.quit().finally(() => process.exit(0)));
});
