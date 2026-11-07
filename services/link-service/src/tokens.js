const crypto = require('node:crypto');

// ES-02 : 256 bits aléatoires, encodés en base64url (43 caractères).
const newToken = () => crypto.randomBytes(32).toString('base64url');
const newRevokeCode = () => crypto.randomBytes(16).toString('base64url');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Comparaison à temps constant, quelle que soit la longueur des entrées.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

// ES-12 : jamais le jeton complet dans les journaux.
const shortToken = (token) => `${token.slice(0, 6)}…`;

module.exports = { newToken, newRevokeCode, sha256, safeEqual, shortToken };
