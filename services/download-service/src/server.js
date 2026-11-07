const Minio = require('minio');
const { createApp } = require('./app');
const { loadConfig } = require('./config');
const { createMinioStorage, createLinkClient } = require('./clients');

const log = (entry) => console.log(JSON.stringify({ service: 'download-service', time: new Date().toISOString(), ...entry }));

const config = loadConfig();
const storage = createMinioStorage(new Minio.Client(config.minio), config.bucket);
const links = createLinkClient({ baseUrl: config.linkServiceUrl, internalToken: config.internalToken });

const server = createApp({ config, storage, links, log }).listen(config.port, () => {
  log({ event: 'started', port: config.port });
});

// Kubernetes envoie SIGTERM avant d'arrêter le pod : on termine les téléchargements en cours.
process.on('SIGTERM', () => server.close(() => process.exit(0)));
