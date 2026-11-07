// Appels aux micro-services. Tout passe par la même origine : l'Ingress (ou la
// passerelle docker-compose) route /api/upload, /api/links et /d/ vers chaque service.
// Chaque fonction renvoie { status, body } ; status 0 = réseau injoignable.

const readJson = (res) => res.json().catch(() => ({}));

async function call(url, options) {
  try {
    const res = await fetch(url, options);
    return { status: res.status, body: await readJson(res) };
  } catch {
    return { status: 0, body: {} };
  }
}

const postJson = (url, data, headers = {}) =>
  call(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) });

export const loadConfig = () => call('/config.json', { cache: 'no-cache' });

// XMLHttpRequest plutôt que fetch : lui seul donne la progression de l'envoi.
// Les champs précèdent le fichier, comme l'exige upload-service.
export function uploadFile({ duration, maxDownloads, password, file }, onProgress) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('duration', duration);
    form.append('maxDownloads', String(maxDownloads));
    if (password) form.append('password', password);
    form.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.response || {} });
    xhr.onerror = () => resolve({ status: 0, body: {} });
    xhr.send(form);
  });
}

export const getLink = (token) => call(`/api/links/${encodeURIComponent(token)}`);

export const revokeLink = (token, revokeCode) => postJson(`/api/links/${encodeURIComponent(token)}/revoke`, { revokeCode });

export const getStats = (adminToken) =>
  call('/api/links/stats', { headers: { authorization: `Bearer ${adminToken}` } });

// Renvoie { status, blob } en cas de succès, { status, body } sinon.
export async function downloadFile(token, password) {
  try {
    const res = await fetch(`/d/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(password ? { password } : {}),
    });
    if (!res.ok) return { status: res.status, body: await readJson(res) };
    return { status: res.status, blob: await res.blob() };
  } catch {
    return { status: 0, body: {} };
  }
}
