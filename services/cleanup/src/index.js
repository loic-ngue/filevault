const Redis = require('ioredis');
const Minio = require('minio');
const { runCleanup } = require('./cleanup');

const log = (entry) => console.log(JSON.stringify({ service: 'cleanup', time: new Date().toISOString(), ...entry }));

async function main() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const minio = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: Number(process.env.MINIO_PORT || 9000),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
  });
  const bucket = process.env.MINIO_BUCKET || 'filevault';
  const storage = { remove: (fileId) => minio.removeObject(bucket, fileId) };

  try {
    const { failed } = await runCleanup({ redis, storage, log });
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    redis.disconnect();
  }
}

main().catch((err) => {
  log({ event: 'error', message: err.message });
  process.exitCode = 1;
});
