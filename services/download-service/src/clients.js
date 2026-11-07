// Lecture des objets chiffrés dans MinIO. Un objet absent renvoie null.
function createMinioStorage(minio, bucket) {
  return {
    async get(fileId) {
      try {
        return await minio.getObject(bucket, fileId);
      } catch (err) {
        if (err.code === 'NoSuchKey') return null;
        throw err;
      }
    },
    ready: () => minio.bucketExists(bucket),
  };
}

// Appel interne à link-service : vérifie le mot de passe et décompte un téléchargement.
function createLinkClient({ baseUrl, internalToken, timeoutMs = 5000, fetchImpl = fetch }) {
  return {
    async consume(token, password) {
      const res = await fetchImpl(`${baseUrl}/api/links/${encodeURIComponent(token)}/consume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${internalToken}` },
        body: JSON.stringify(password ? { password } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    },
  };
}

module.exports = { createMinioStorage, createLinkClient };
