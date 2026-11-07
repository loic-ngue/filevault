// Mêmes clés que link-service (src/store.js) : c'est le contrat entre les deux services.
const EXPIRATIONS = 'expirations';
const SIZES = 'sizes';

// EF-07 : supprime de MinIO chaque fichier dont la date de suppression est passée
// (lien expiré, épuisé ou révoqué). Un fichier en échec reste dans l'index et sera
// retenté au prochain passage du CronJob.
async function runCleanup({ redis, storage, now = Date.now(), batchSize = 100, log = () => {} }) {
  let removed = 0;
  let failed = 0;
  let offset = 0;

  for (;;) {
    const due = await redis.zrangebyscore(EXPIRATIONS, '-inf', now, 'LIMIT', offset, batchSize);
    for (const fileId of due) {
      try {
        await storage.remove(fileId);
        await redis.multi().zrem(EXPIRATIONS, fileId).hdel(SIZES, fileId).exec();
        removed++;
      } catch (err) {
        failed++;
        log({ event: 'cleanup_failed', fileId, message: err.message });
      }
    }
    if (due.length < batchSize) break;
    // Les fichiers en échec restent en tête de l'index : on les saute.
    offset = failed;
  }

  log({ event: 'cleanup_done', removed, failed });
  return { removed, failed };
}

module.exports = { runCleanup, EXPIRATIONS, SIZES };
