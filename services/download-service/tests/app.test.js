const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const request = require('supertest');
const { createApp, contentDisposition } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createEncryptStream } = require('../src/crypto');

const MASTER_KEY = crypto.randomBytes(32);
const FILE_ID = 'fichier-test-0001';

async function encrypt(data, fileId = FILE_ID) {
  const chunks = [];
  for await (const chunk of Readable.from([data]).pipe(createEncryptStream(MASTER_KEY, fileId))) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Rend l'objet en petits morceaux, comme MinIO.
const chunked = (buffer, size = 4096) => {
  const parts = [];
  for (let i = 0; i < buffer.length; i += size) parts.push(buffer.subarray(i, i + size));
  return Readable.from(parts);
};

const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

let original;
let objects;
let storage;
let links;
let log;
let app;

const consumed = (overrides = {}) => ({
  status: 200,
  body: { fileId: FILE_ID, name: 'contrat.pdf', size: original.length, mime: 'application/pdf', remainingDownloads: 2, ...overrides },
});

beforeEach(async () => {
  original = crypto.randomBytes(300_000);
  objects = new Map([[FILE_ID, await encrypt(original)]]);
  storage = {
    get: jest.fn(async (fileId) => (objects.has(fileId) ? chunked(objects.get(fileId)) : null)),
    ready: async () => true,
  };
  links = { consume: jest.fn(async () => consumed()) };
  log = jest.fn();
  const config = loadConfig({ MASTER_KEY: MASTER_KEY.toString('base64') });
  app = createApp({ config, storage, links, log });
});

const download = (token = 'jeton-test') => request(app).post(`/d/${token}`).buffer(true).parse(binary);

describe('lien partagé (GET)', () => {
  test('renvoie vers la page du frontend sans décompter de téléchargement', async () => {
    const res = await request(app).get('/d/jeton-test');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/#/d/jeton-test');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(links.consume).not.toHaveBeenCalled();
  });

  test('encode le jeton dans la redirection', async () => {
    const res = await request(app).get('/d/a%22b');
    expect(res.headers.location).toBe('/#/d/a%22b');
  });
});

describe('téléchargement (POST)', () => {
  test("renvoie le fichier d'origine, nom et type conservés (EF-05, R-02)", async () => {
    const res = await download();
    expect(res.status).toBe(200);
    expect(res.body.equals(original)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-length']).toBe(String(original.length));
    expect(res.headers['content-disposition']).toBe(`attachment; filename="contrat.pdf"; filename*=UTF-8''contrat.pdf`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(storage.get).toHaveBeenCalledWith(FILE_ID);
  });

  test('transmet le mot de passe saisi dans un formulaire', async () => {
    await download().type('form').send({ password: 'secret123' });
    expect(links.consume).toHaveBeenCalledWith('jeton-test', 'secret123');
  });

  test('transmet le mot de passe envoyé en JSON', async () => {
    await download().send({ password: 'secret123' });
    expect(links.consume).toHaveBeenCalledWith('jeton-test', 'secret123');
  });

  test("n'envoie pas de mot de passe quand il est absent ou mal typé", async () => {
    await download();
    await download().send({ password: 42 });
    expect(links.consume.mock.calls).toEqual([
      ['jeton-test', undefined],
      ['jeton-test', undefined],
    ]);
  });

  test('remplace un type de fichier invalide', async () => {
    links.consume.mockResolvedValue(consumed({ mime: 'pas un type' }));
    const res = await download();
    expect(res.headers['content-type']).toBe('application/octet-stream');
  });

  test('journalise sans nom de fichier ni jeton (ES-12)', async () => {
    links.consume.mockResolvedValue(consumed({ name: 'diplome-secret.pdf' }));
    await download();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('downloaded');
    expect(logged).not.toContain('diplome-secret');
    expect(logged).not.toContain('jeton-test');
  });

  test('compte les téléchargements dans /metrics', async () => {
    await download();
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('filevault_downloads_total{result="ok"} 1');
    expect(res.text).toContain(`filevault_downloaded_bytes_total ${original.length}`);
  });
});

describe('refus relayés depuis link-service', () => {
  test.each([
    [410, 'Lien expiré ou invalide.'],
    [401, 'Mot de passe incorrect.'],
    [429, 'Trop de tentatives. Réessayez dans 15 minutes.'],
  ])('%i : « %s » (EF-06, R-03, R-06)', async (status, error) => {
    links.consume.mockResolvedValue({ status, body: { error } });
    const res = await request(app).post('/d/jeton-test');
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error });
    expect(storage.get).not.toHaveBeenCalled();
  });

  test('message par défaut quand link-service ne précise rien', async () => {
    links.consume.mockResolvedValue({ status: 410, body: {} });
    expect((await request(app).post('/d/x')).body.error).toBe('Lien expiré ou invalide.');
  });

  test('page HTML lisible pour un formulaire du navigateur', async () => {
    links.consume.mockResolvedValue({ status: 410, body: { error: 'Lien expiré <ou> invalide.' } });
    const res = await request(app).post('/d/x').set('Accept', 'text/html');
    expect(res.status).toBe(410);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('Lien expiré &lt;ou&gt; invalide.');
  });
});

describe('pannes', () => {
  test('link-service injoignable', async () => {
    links.consume.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app).post('/d/x');
    expect(res.status).toBe(502);
    expect(log).toHaveBeenCalledWith({ event: 'link_service_error', message: 'ECONNREFUSED' });
  });

  test('link-service en erreur serveur', async () => {
    links.consume.mockResolvedValue({ status: 500, body: {} });
    expect((await request(app).post('/d/x')).status).toBe(502);
  });

  test('fichier déjà supprimé par cleanup', async () => {
    objects.clear();
    const res = await request(app).post('/d/x');
    expect(res.status).toBe(410);
  });

  test('MinIO indisponible', async () => {
    storage.get.mockRejectedValue(new Error('timeout'));
    expect((await request(app).post('/d/x')).status).toBe(502);
  });

  test("clé d'un autre fichier : erreur propre, sans fichier joint", async () => {
    objects.set(FILE_ID, await encrypt(original, 'autre-fichier'));
    const res = await request(app).post('/d/x');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Le fichier stocké est illisible.' });
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'integrity_failed', fileId: FILE_ID }));
  });

  test('objet altéré : la connexion est coupée avant la fin', async () => {
    const altered = Buffer.from(objects.get(FILE_ID));
    altered[altered.length - 1] ^= 1;
    objects.set(FILE_ID, altered);
    await expect(download()).rejects.toThrow();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'integrity_failed' }));
  });

  test('erreur de lecture MinIO en cours de route', async () => {
    storage.get.mockImplementation(async () => {
      const stream = new Readable({ read() {} });
      stream.push(objects.get(FILE_ID).subarray(0, 10_000));
      setImmediate(() => stream.destroy(new Error('connexion perdue')));
      return stream;
    });
    await expect(download()).rejects.toThrow();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: 'integrity_failed', message: 'connexion perdue' }));
  });

  test('JSON mal formé', async () => {
    const res = await request(app).post('/d/x').set('Content-Type', 'application/json').send('{"password":');
    expect(res.status).toBe(400);
  });

  test('corps trop gros', async () => {
    const res = await request(app).post('/d/x').send({ password: 'x'.repeat(5000) });
    expect(res.status).toBe(413);
  });
});

describe('santé', () => {
  test('répond ok quand MinIO répond', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
  });

  test('répond 503 quand MinIO est indisponible, /live reste ok', async () => {
    storage.ready = () => Promise.reject(new Error('down'));
    expect((await request(app).get('/health')).status).toBe(503);
    expect((await request(app).get('/live')).status).toBe(200);
  });
});

test('répond 404 sur une route inconnue', async () => {
  expect((await request(app).get('/inconnu')).status).toBe(404);
});

test('répond 500 sans détail sur une erreur inattendue', async () => {
  links.consume.mockResolvedValue({ status: 200, body: null });
  const res = await request(app).post('/d/x');
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ error: 'Erreur interne.' });
});

test.each([
  ['contrat.pdf', `attachment; filename="contrat.pdf"; filename*=UTF-8''contrat.pdf`],
  ['relevé été.pdf', `attachment; filename="relev_ _t_.pdf"; filename*=UTF-8''relev%C3%A9%20%C3%A9t%C3%A9.pdf`],
  ['a"b\\c\'(1).txt', `attachment; filename="a_b_c'(1).txt"; filename*=UTF-8''a%22b%5Cc%27%281%29.txt`],
])('contentDisposition(%j)', (name, expected) => {
  expect(contentDisposition(name)).toBe(expected);
});
