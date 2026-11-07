const UNITS = { m: 60, h: 3600, d: 86400 };
const DEFAULT_DURATIONS = '10m,1h,24h,7d'; // EF-02

// "10m,1h" -> { '10m': 600, '1h': 3600 } (secondes)
function parseDurations(list) {
  const durations = {};
  for (const label of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const match = /^(\d+)([mhd])$/.exec(label);
    if (!match || Number(match[1]) === 0) throw new Error(`Durée invalide : ${label}`);
    durations[label] = Number(match[1]) * UNITS[match[2]];
  }
  if (Object.keys(durations).length === 0) throw new Error('Aucune durée autorisée');
  return durations;
}

function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    redisUrl: env.REDIS_URL || 'redis://localhost:6379',
    durations: parseDurations(env.ALLOWED_DURATIONS || DEFAULT_DURATIONS),
    maxDownloads: Number(env.MAX_DOWNLOADS || 10), // EF-03
    maxFileSize: Number(env.MAX_FILE_SIZE || 50 * 1024 * 1024), // EF-01
    bcryptCost: Number(env.BCRYPT_COST || 12), // ES-03
    maxPasswordAttempts: Number(env.MAX_PASSWORD_ATTEMPTS || 5), // ES-04
    lockSeconds: Number(env.LOCK_SECONDS || 15 * 60),
    // Sans jeton configuré, les routes protégées refusent tout.
    internalToken: env.INTERNAL_TOKEN || '',
    adminToken: env.ADMIN_TOKEN || '',
  };
}

module.exports = { loadConfig, parseDurations };
