function parseMasterKey(value) {
  const key = Buffer.from(value || '', 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY doit contenir 32 octets encodés en base64.');
  return key;
}

function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    linkServiceUrl: env.LINK_SERVICE_URL || 'http://localhost:3001',
    internalToken: env.INTERNAL_TOKEN || '',
    masterKey: parseMasterKey(env.MASTER_KEY), // ES-01, ES-07 : injectée depuis un Secret
    minio: {
      endPoint: env.MINIO_ENDPOINT || 'localhost',
      port: Number(env.MINIO_PORT || 9000),
      useSSL: env.MINIO_USE_SSL === 'true',
      accessKey: env.MINIO_ACCESS_KEY,
      secretKey: env.MINIO_SECRET_KEY,
    },
    bucket: env.MINIO_BUCKET || 'filevault',
  };
}

module.exports = { loadConfig, parseMasterKey };
