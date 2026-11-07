import { loadConfig, uploadFile, getLink, revokeLink, getStats, downloadFile } from './api.js';
import { formatSize, formatRemaining, parseRoute, shareUrl, errorMessage, plural } from './format.js';

const $ = (id) => document.getElementById(id);

const DEFAULT_CONFIG = {
  durations: [
    { value: '10m', label: '10 minutes' },
    { value: '1h', label: '1 heure', default: true },
    { value: '24h', label: '24 heures' },
    { value: '7d', label: '7 jours' },
  ],
  maxDownloads: 10,
  maxFileSizeMb: 50,
};

let config = DEFAULT_CONFIG;
let countdown = null;

function showError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

// ---------- Dépôt ----------

let chosenFile = null;
let lastUpload = null;

function chooseFile(file) {
  chosenFile = file || null;
  $('drop').classList.toggle('chosen', Boolean(file));
  $('drop-title').textContent = file ? file.name : 'Glissez un fichier ici';
  $('drop-hint').textContent = file
    ? `${formatSize(file.size)} · touchez pour changer`
    : `ou touchez pour choisir · ${config.maxFileSizeMb} Mo maximum`;
  showError($('upload-error'), '');
}

function setupUpload() {
  const select = $('duration');
  select.replaceChildren(
    ...config.durations.map((d) => {
      const option = new Option(d.label, d.value);
      option.selected = Boolean(d.default);
      return option;
    }),
  );
  $('max-downloads').max = String(config.maxDownloads);
  chooseFile(null);

  const drop = $('drop');
  $('file').addEventListener('change', (event) => chooseFile(event.target.files[0]));
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('over'));
  }
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    chooseFile(event.dataTransfer.files[0]);
  });

  $('upload-form').addEventListener('submit', submitUpload);
  $('copy').addEventListener('click', copyLink);
  $('revoke').addEventListener('click', revoke);
  $('again').addEventListener('click', resetUpload);
}

async function submitUpload(event) {
  event.preventDefault();
  const error = $('upload-error');
  const maxDownloads = Number($('max-downloads').value);

  if (!chosenFile) return showError(error, 'Choisissez un fichier à partager.');
  if (chosenFile.size === 0) return showError(error, 'Ce fichier est vide.');
  if (chosenFile.size > config.maxFileSizeMb * 1024 * 1024) {
    return showError(error, `Fichier trop volumineux : ${config.maxFileSizeMb} Mo maximum.`);
  }
  if (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > config.maxDownloads) {
    return showError(error, `Le nombre de téléchargements doit être entre 1 et ${config.maxDownloads}.`);
  }

  showError(error, '');
  $('submit').disabled = true;
  $('submit').textContent = 'Chiffrement et envoi…';
  $('progress').hidden = false;
  $('bar').style.width = '0';

  const { status, body } = await uploadFile(
    { duration: $('duration').value, maxDownloads, password: $('password').value, file: chosenFile },
    (ratio) => {
      $('bar').style.width = `${Math.round(ratio * 100)}%`;
    },
  );

  $('submit').disabled = false;
  $('submit').textContent = 'Chiffrer et créer le lien';
  $('progress').hidden = true;

  if (status !== 201) return showError(error, errorMessage(status, body));

  lastUpload = body;
  $('link').value = shareUrl(location.origin, body.token);
  const durationLabel = $('duration').selectedOptions[0].textContent;
  $('result-meta').textContent =
    `Valable ${durationLabel}, ${plural(body.maxDownloads, 'téléchargement')}` +
    `${$('password').value ? ', protégé par mot de passe' : ''}.`;
  $('revoke-code').textContent = body.revokeCode;
  $('revoke').disabled = false;
  $('revoke-status').textContent = '';
  $('copy').textContent = 'Copier';
  $('upload-form').hidden = true;
  $('result').hidden = false;
  $('link').focus();
  $('link').select();
}

async function copyLink() {
  const link = $('link');
  try {
    await navigator.clipboard.writeText(link.value);
  } catch {
    // Presse-papiers refusé (HTTP, ancien navigateur) : on sélectionne le texte.
    link.select();
    document.execCommand('copy');
  }
  $('copy').textContent = 'Copié ✓';
}

async function revoke() {
  if (!lastUpload) return;
  $('revoke').disabled = true;
  const { status, body } = await revokeLink(lastUpload.token, lastUpload.revokeCode);
  if (status === 204) {
    $('revoke-status').textContent = 'Lien révoqué. Le fichier sera supprimé dans les prochaines minutes.';
  } else {
    $('revoke').disabled = status === 410;
    $('revoke-status').textContent = errorMessage(status, body);
  }
}

function resetUpload() {
  lastUpload = null;
  $('upload-form').reset();
  setupDurationsDefault();
  chooseFile(null);
  $('result').hidden = true;
  $('upload-form').hidden = false;
}

function setupDurationsDefault() {
  const index = config.durations.findIndex((d) => d.default);
  $('duration').selectedIndex = Math.max(index, 0);
}

// ---------- Destinataire ----------

let currentLink = null;

function showGone(message) {
  clearInterval(countdown);
  $('download-loading').hidden = true;
  $('file-card').hidden = true;
  $('download-gone-text').textContent = message;
  $('download-gone').hidden = false;
}

function renderLink(token, link) {
  currentLink = { token, ...link };
  $('download-loading').hidden = true;
  $('download-gone').hidden = true;
  $('file-card').hidden = false;
  $('file-name').textContent = link.name;
  $('file-size').textContent = formatSize(link.size);
  $('file-remaining').textContent = String(link.remainingDownloads);
  $('download-password-label').hidden = !link.passwordRequired;

  const expiresAt = Date.parse(link.expiresAt);
  const tick = () => {
    const left = expiresAt - Date.now();
    $('file-expires').textContent = formatRemaining(left);
    if (left <= 0) showGone('Ce lien a expiré. Le fichier a été supprimé.');
  };
  clearInterval(countdown);
  tick();
  countdown = setInterval(tick, 1000);
}

async function openDownload(token) {
  $('download-loading').hidden = false;
  $('file-card').hidden = true;
  $('download-gone').hidden = true;
  showError($('download-error'), '');
  $('download-form').reset();

  const { status, body } = await getLink(token);
  if (status === 200) return renderLink(token, body);
  if (status === 410) return showGone('Ce lien a expiré, a été révoqué ou a atteint son nombre de téléchargements.');
  showGone(errorMessage(status, body));
}

async function submitDownload(event) {
  event.preventDefault();
  if (!currentLink) return;
  const error = $('download-error');
  const password = $('download-password').value;
  if (currentLink.passwordRequired && !password) return showError(error, 'Saisissez le mot de passe reçu.');

  showError(error, '');
  $('download').disabled = true;
  $('download').textContent = 'Déchiffrement…';
  const result = await downloadFile(currentLink.token, password);
  $('download').disabled = false;
  $('download').textContent = 'Télécharger';

  if (result.blob) {
    const url = URL.createObjectURL(result.blob);
    const anchor = Object.assign(document.createElement('a'), { href: url, download: currentLink.name });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    // Met à jour le compteur ; au dernier téléchargement, le lien a disparu.
    const { status, body } = await getLink(currentLink.token);
    if (status === 200) renderLink(currentLink.token, body);
    else showGone('Téléchargement terminé. C’était le dernier : le lien n’est plus valable.');
    return;
  }
  if (result.status === 410) return showGone(errorMessage(410, result.body));
  showError(error, errorMessage(result.status, result.body));
}

// ---------- Administration ----------

async function submitAdmin(event) {
  event.preventDefault();
  const error = $('admin-error');
  const token = $('admin-token').value;
  if (!token) return showError(error, 'Saisissez le jeton administrateur.');

  const { status, body } = await getStats(token);
  if (status !== 200) {
    $('stats').hidden = true;
    return showError(error, status === 401 ? 'Jeton administrateur incorrect.' : errorMessage(status, body));
  }
  showError(error, '');
  $('stat-files').textContent = String(body.activeFiles);
  $('stat-bytes').textContent = formatSize(body.totalBytes);
  $('stat-downloads').textContent = String(body.downloads);
  $('stats').hidden = false;
}

// ---------- Navigation ----------

function route() {
  const { view, token } = parseRoute(location.hash);
  for (const name of ['upload', 'download', 'admin']) $(`view-${name}`).hidden = name !== view;
  clearInterval(countdown);
  if (view === 'download') openDownload(token);
  document.title = { upload: 'FileVault', download: 'Fichier partagé · FileVault', admin: 'Administration · FileVault' }[view];
}

async function start() {
  const { status, body } = await loadConfig();
  if (status === 200 && Array.isArray(body.durations) && body.durations.length) config = { ...DEFAULT_CONFIG, ...body };

  setupUpload();
  $('download-form').addEventListener('submit', submitDownload);
  $('admin-form').addEventListener('submit', submitAdmin);
  window.addEventListener('hashchange', route);
  route();
}

start();
