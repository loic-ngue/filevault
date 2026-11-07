// Stockage des objets chiffrés dans MinIO (compatible S3).
function createMinioStorage(minio, bucket) {
  return {
    // Taille inconnue à l'avance : le client MinIO envoie le flux en multipart.
    put: (fileId, stream) => minio.putObject(bucket, fileId, stream, undefined, { 'Content-Type': 'application/octet-stream' }),
    remove: (fileId) => minio.removeObject(bucket, fileId),
    ready: () => minio.bucketExists(bucket),
    async ensureBucket() {
      if (!(await minio.bucketExists(bucket))) await minio.makeBucket(bucket);
    },
  };
}

// Appel interne à link-service, une fois le fichier stocké.
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
