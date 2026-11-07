const Redis = require('ioredis-mock');
const { runCleanup, EXPIRATIONS, SIZES } = require('../src/cleanup');

const NOW = 1_800_000_000_000;
let redis;

beforeEach(async () => {
  redis = new Redis();
  await redis.flushall();
});

afterEach(() => redis.disconnect());

const schedule = async (fileId, at, size = 100) => {
  await redis.zadd(EXPIRATIONS, at, fileId);
  await redis.hset(SIZES, fileId, size);
};

const fakeStorage = (failing = []) => {
  const removed = [];
  return {
    removed,
    remove: async (fileId) => {
      if (failing.includes(fileId)) throw new Error('MinIO indisponible');
      removed.push(fileId);
    },
  };
};

test('supprime les fichiers échus et garde les fichiers actifs (EF-07)', async () => {
  await schedule('echu-1', NOW - 1000);
  await schedule('echu-2', NOW);
  await schedule('actif', NOW + 60_000);
  const storage = fakeStorage();

  const result = await runCleanup({ redis, storage, now: NOW });

  expect(result).toEqual({ removed: 2, failed: 0 });
  expect(storage.removed.sort()).toEqual(['echu-1', 'echu-2']);
  expect(await redis.zrange(EXPIRATIONS, 0, -1)).toEqual(['actif']);
  expect(await redis.hkeys(SIZES)).toEqual(['actif']);
});

test("garde dans l'index un fichier dont la suppression échoue", async () => {
  await schedule('ko', NOW - 2000);
  await schedule('ok', NOW - 1000);
  const log = jest.fn();

  const result = await runCleanup({ redis, storage: fakeStorage(['ko']), now: NOW, log });

  expect(result).toEqual({ removed: 1, failed: 1 });
  expect(await redis.zrange(EXPIRATIONS, 0, -1)).toEqual(['ko']);
  expect(log).toHaveBeenCalledWith({ event: 'cleanup_failed', fileId: 'ko', message: 'MinIO indisponible' });
});

test('traite plusieurs lots sans boucler sur les échecs', async () => {
  for (let i = 0; i < 7; i++) await schedule(`f${i}`, NOW - 10_000 + i);
  const storage = fakeStorage(['f0']);

  const result = await runCleanup({ redis, storage, now: NOW, batchSize: 3 });

  expect(result).toEqual({ removed: 6, failed: 1 });
  expect(await redis.zrange(EXPIRATIONS, 0, -1)).toEqual(['f0']);
});

test("ne fait rien quand rien n'est échu", async () => {
  await schedule('actif', NOW + 1);
  expect(await runCleanup({ redis, storage: fakeStorage(), now: NOW })).toEqual({ removed: 0, failed: 0 });
});
