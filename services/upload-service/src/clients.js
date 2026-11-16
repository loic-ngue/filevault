function createMinioStorage(minio, bucket) {
  return {
    put: (fileId, stream) => minio.putObject(bucket, fileId, stream, undefined, { 'Content-Type': 'application/octet-stream' }),
    remove: (fileId) => minio.removeObject(bucket, fileId),
    ready: () => minio.bucketExists(bucket),
    async ensureBucket() {
      if (!(await minio.bucketExists(bucket))) await minio.makeBucket(bucket);
    },
  };
}

function createLinkClient({ baseUrl, internalToken, timeoutMs = 5000, fetchImpl = fetch }) {
  return {
    async create(link) {
      const res = await fetchImpl(`${baseUrl}/api/links`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${internalToken}` },
        body: JSON.stringify(link),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    },
  };
}

module.exports = { createMinioStorage, createLinkClient };
