const EXPIRATIONS = 'expirations';
const SIZES = 'sizes';

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
    offset = failed;
  }

  log({ event: 'cleanup_done', removed, failed });
  return { removed, failed };
}

module.exports = { runCleanup, EXPIRATIONS, SIZES };
