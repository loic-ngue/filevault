const { sha256 } = require('./tokens');

const EXPIRATIONS = 'expirations';
const SIZES = 'sizes';
const DOWNLOADS = 'stats:downloads';

const linkKey = (token) => `link:${sha256(token)}`;
const attemptsKey = (token) => `attempts:${sha256(token)}`;

const CONSUME_SCRIPT = `
local remaining = tonumber(redis.call('HGET', KEYS[1], 'remaining'))
if not remaining or remaining <= 0 then return false end
remaining = remaining - 1
if remaining == 0 then
  local fileId = redis.call('HGET', KEYS[1], 'fileId')
  redis.call('DEL', KEYS[1])
  redis.call('ZADD', KEYS[2], ARGV[1], fileId)
else
  redis.call('HSET', KEYS[1], 'remaining', remaining)
end
redis.call('INCR', KEYS[3])
return remaining
`;

function createStore(redis) {
  redis.defineCommand('consumeLink', { numberOfKeys: 3, lua: CONSUME_SCRIPT });

  return {
    async create(token, link, ttlSeconds, now = Date.now()) {
      const expiresAt = now + ttlSeconds * 1000;
      await redis
        .multi()
        .hset(linkKey(token), { ...link, remaining: link.maxDownloads, expiresAt })
        .expire(linkKey(token), ttlSeconds)
        .zadd(EXPIRATIONS, expiresAt, link.fileId)
        .hset(SIZES, link.fileId, link.size)
        .exec();
      return expiresAt;
    },

    async get(token) {
      const link = await redis.hgetall(linkKey(token));
      if (!link || !link.fileId) return null;
      return {
        ...link,
        size: Number(link.size),
        remaining: Number(link.remaining),
        maxDownloads: Number(link.maxDownloads),
        expiresAt: Number(link.expiresAt),
      };
    },

    async consume(token, now = Date.now()) {
      return redis.consumeLink(linkKey(token), EXPIRATIONS, DOWNLOADS, now);
    },

    async revoke(token, fileId, now = Date.now()) {
      await redis.multi().del(linkKey(token)).zadd(EXPIRATIONS, now, fileId).exec();
    },

    async failedAttempts(token) {
      return Number((await redis.get(attemptsKey(token))) || 0);
    },

    async recordFailedAttempt(token, lockSeconds) {
      const [[, count]] = await redis
        .multi()
        .incr(attemptsKey(token))
        .expire(attemptsKey(token), lockSeconds, 'NX')
        .exec();
      return count;
    },

    async clearFailedAttempts(token) {
      await redis.del(attemptsKey(token));
    },

    async stats(now = Date.now()) {
      const active = await redis.zrangebyscore(EXPIRATIONS, now + 1, '+inf');
      const sizes = active.length ? await redis.hmget(SIZES, ...active) : [];
      const totalBytes = sizes.reduce((sum, size) => sum + Number(size || 0), 0);
      const downloads = Number((await redis.get(DOWNLOADS)) || 0);
      return { activeFiles: active.length, totalBytes, downloads };
    },
  };
}

module.exports = { createStore, EXPIRATIONS, SIZES };
