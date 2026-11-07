const { loadConfig, parseDurations } = require('../src/config');
const { safeEqual } = require('../src/tokens');

describe('parseDurations', () => {
  test('convertit les durées en secondes', () => {
    expect(parseDurations('10m, 1h,24h,7d')).toEqual({ '10m': 600, '1h': 3600, '24h': 86400, '7d': 604800 });
  });

  test.each(['2s', '0m', 'abc', ''])('refuse « %s »', (list) => {
    expect(() => parseDurations(list)).toThrow();
  });
});

test('loadConfig applique les valeurs du cahier des charges par défaut', () => {
  const config = loadConfig({});
  expect(config.durations).toEqual({ '10m': 600, '1h': 3600, '24h': 86400, '7d': 604800 });
  expect(config.maxDownloads).toBe(10);
  expect(config.maxFileSize).toBe(52428800);
  expect(config.bcryptCost).toBe(12);
  expect(config.maxPasswordAttempts).toBe(5);
  expect(config.lockSeconds).toBe(900);
  expect(config.internalToken).toBe('');
});

test('safeEqual refuse les chaînes vides et les types inattendus', () => {
  expect(safeEqual('a', 'a')).toBe(true);
  expect(safeEqual('a', 'b')).toBe(false);
  expect(safeEqual('', '')).toBe(false);
  expect(safeEqual(undefined, 'a')).toBe(false);
});
