// Fonctions pures, testées avec node --test (tests/format.test.js).

const UNITS = ['octets', 'Ko', 'Mo', 'Go'];

export function formatSize(bytes) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(value < 10 ? 1 : 0).replace('.', ',');
  return `${rounded} ${UNITS[unit]}`;
}

// Temps restant lisible : « 2 j 3 h », « 1 h 05 min », « 4 min 09 s », « expiré ».
export function formatRemaining(ms) {
  if (ms <= 0) return 'expiré';
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (days > 0) return `${days} j ${hours} h`;
  if (hours > 0) return `${hours} h ${pad(minutes)} min`;
  if (minutes > 0) return `${minutes} min ${pad(seconds)} s`;
  return `${seconds} s`;
}

// Routes de la page : #/d/<jeton> pour le destinataire, #/admin, sinon le dépôt.
export function parseRoute(hash) {
  const download = /^#\/d\/([A-Za-z0-9_-]+)$/.exec(hash);
  if (download) return { view: 'download', token: download[1] };
  if (hash === '#/admin') return { view: 'admin' };
  return { view: 'upload' };
}

export const shareUrl = (origin, token) => `${origin}/d/${token}`;

const DEFAULT_ERRORS = {
  0: 'Connexion impossible. Vérifiez votre réseau.',
  401: 'Mot de passe incorrect.',
  410: 'Ce lien a expiré ou n’existe pas.',
  413: 'Fichier trop volumineux.',
  429: 'Trop de tentatives. Réessayez plus tard.',
  502: 'Service momentanément indisponible. Réessayez dans un instant.',
};

// Message à afficher : celui du serveur s'il y en a un, sinon un message par code.
export function errorMessage(status, body) {
  if (body && typeof body.error === 'string' && body.error) return body.error;
  return DEFAULT_ERRORS[status] || `Une erreur est survenue (code ${status}).`;
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count > 1 ? pluralForm : singular}`;
}
