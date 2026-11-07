const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const request = require('supertest');
const Redis = require('ioredis-mock');
const { createApp, cleanName } = require('../src/app');
const { loadConfig } = require('../src/config');
const { createDecryptStream } = require('../src/crypto');

const MASTER_KEY = crypto.randomBytes(32);

const memoryStorage = () => {
  const objects = new Map();
  return {
    objects,
    put: jest.fn(async (fileId, stream) => {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      objects.set(fileId, Buffer.concat(chunks));
    }),
    remove: jest.fn(async (fileId) => {
      objects.delete(fileId);
    }),
    ready: async () => true,
  };
};

const linkCreated = (body) => ({
  status: 201,
  body: { token: 'jeton-test', revokeCode: 'code-test', expiresAt: '2026-11-01T10:00:00.000Z', maxDownloads: body.maxDownloads },
});

let redis;
let storage;
let links;
let log;
let app;

function build(env = {}) {
  const config = loadConfig({ MASTER_KEY: MASTER_KEY.toString('base64'), ...env });
  app = createApp({ config, redis, storage, links, log });
}

beforeEach(async () => {
  redis = new Redis();
  await redis.flushall();
  storage = memoryStorage();
  links = { create: jest.fn(async (body) => linkCreated(body)) };
  log = jest.fn();
  build();
});

afterEach(() => redis.disconnect());

const upload = (content, { filename = 'contrat.pdf', contentType = 'application/pdf', fields } = {}) => {
  const req = request(app).post('/api/upload');
  for (const [name, value] of Object.entries(fields || { duration: '1h', maxDownloads: '3' })) req.field(name, value);
  return req.attach('file', content, { filename, contentType });
};

const decrypt = async (fileId) => {
  const chunks = [];
  for await (const chunk of Readable.from([storage.objects.get(fileId)]).pipe(createDecryptStream(MASTER_KEY, fileId))) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

describe('dépôt réussi', () => {
  test('chiffre et stocke le fichier, puis crée le lien (EF-01, R-01)', async () => {
    const original = crypto.randomBytes(2 * 1024 * 1024);
    const res = await upload(original, { fields: { duration: '1h', maxDownloads: '3', password: 'secret123' } });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      token: 'jeton-test',
      revokeCode: 'code-test',
      expiresAt: '2026-11-01T10:00:00.000Z',
      maxDownloads: 3,
      path: '/d/jeton-test',
    });

    const [link] = links.create.mock.calls[0];
    expect(link).toEqual({
      fileId: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      name: 'contrat.pdf',
      size: original.length,
      mime: 'application/pdf',
      duration: '1h',
      maxDownloads: 3,
      password: 'secret123',
    });
    expect([...storage.objects.keys()]).toEqual([link.fileId]);
    expect((await decrypt(link.fileId)).equals(original)).toBe(true);
  });

  test('stocke un contenu illisible (R-05)', async () => {
    const original = Buffer.from('RELEVÉ BANCAIRE CONFIDENTIEL\n'.repeat(1000));
    await upload(original, { filename: 'releve.txt', contentType: 'text/plain' });
    const [stored] = storage.objects.values();
    expect(stored.includes(Buffer.from('CONFIDENTIEL'))).toBe(false);
  });

  test("n'envoie pas de mot de passe quand il n'y en a pas", async () => {
    await upload(Buffer.from('bonjour'));
    expect(links.create.mock.calls[0][0]).not.toHaveProperty('password');
  });

  test('garde les noms accentués et retire les chemins', async () => {
    await upload(Buffer.from('x'), { filename: 'relevé été.pdf' });
    expect(links.create.mock.calls[0][0].name).toBe('relevé été.pdf');
  });

  test('journalise sans nom de fichier ni jeton (ES-12)', async () => {
    await upload(Buffer.from('x'), { filename: 'diplome-secret.pdf' });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('uploaded');
    expect(logged).not.toContain('diplome-secret');
    expect(logged).not.toContain('jeton-test');
  });

  test('compte les dépôts dans /metrics', async () => {
    await upload(Buffer.from('12345'));
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('filevault_uploads_total{result="ok"} 1');
    expect(res.text).toContain('filevault_uploaded_bytes_total 5');
  });
});

describe('dépôt refusé', () => {
  test('quand la requête n’est pas multipart', async () => {
    const res = await request(app).post('/api/upload').send({ file: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/multipart/);
  });

  test('quand le formulaire est coupé au milieu du fichier, sans rien garder', async () => {
    const body = [
      '--frontiere',
      'Content-Disposition: form-data; name="duration"',
      '',
      '1h',
      '--frontiere',
      'Content-Disposition: form-data; name="maxDownloads"',
      '',
      '3',
      '--frontiere',
      'Content-Disposition: form-data; name="file"; filename="a.txt"',
      'Content-Type: text/plain',
      '',
      'début du fichier sans fin',
    ].join('\r\n');
    const res = await request(app)
      .post('/api/upload')
      .set('Content-Type', 'multipart/form-data; boundary=frontiere')
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/interrompue/);
    expect(storage.objects.size).toBe(0);
    expect(links.create).not.toHaveBeenCalled();
  });

  test('quand aucun fichier n’est joint', async () => {
    const res = await request(app).post('/api/upload').field('duration', '1h').field('maxDownloads', '3');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Aucun fichier reçu.');
  });

  test('quand les champs arrivent après le fichier', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('x'), 'a.txt')
      .field('duration', '1h')
      .field('maxDownloads', '3');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/précéder le fichier/);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test('quand le fichier est dans un autre champ', async () => {
    const res = await request(app)
      .post('/api/upload')
      .field('duration', '1h')
      .field('maxDownloads', '3')
      .attach('document', Buffer.from('x'), 'a.txt');
    expect(res.status).toBe(400);
  });

  test('quand deux fichiers sont envoyés, sans rien garder', async () => {
    const res = await upload(Buffer.from('premier')).attach('file', Buffer.from('second'), 'b.txt');
    expect(res.status).toBe(400);
    expect(storage.objects.size).toBe(0);
    expect(links.create).not.toHaveBeenCalled();
  });

  test('quand le fichier dépasse la limite, en cours de lecture', async () => {
    build({ MAX_FILE_SIZE: '1024' });
    const res = await upload(crypto.randomBytes(5000));
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/trop volumineux/);
    expect(storage.objects.size).toBe(0);
    expect(links.create).not.toHaveBeenCalled();
  });

  test('quand la taille annoncée dépasse la limite, sans lire le corps', async () => {
    build({ MAX_FILE_SIZE: '1024' });
    const res = await upload(crypto.randomBytes(200 * 1024));
    expect(res.status).toBe(413);
    expect(storage.put).not.toHaveBeenCalled();
  });

  test('quand link-service refuse les paramètres, en supprimant le fichier', async () => {
    links.create.mockResolvedValue({ status: 400, body: { error: 'Durée invalide : choisir parmi 10m, 1h.' } });
    const res = await upload(Buffer.from('x'), { fields: { duration: '2h', maxDownloads: '3' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Durée invalide/);
    expect(storage.objects.size).toBe(0);
  });

  test('quand link-service refuse sans message', async () => {
    links.create.mockResolvedValue({ status: 400, body: {} });
    const res = await upload(Buffer.from('x'));
    expect(res.body.error).toBe('Requête invalide.');
  });

  test('quand link-service est injoignable, en supprimant le fichier', async () => {
    links.create.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await upload(Buffer.from('x'));
    expect(res.status).toBe(502);
    expect(storage.objects.size).toBe(0);
    expect(log).toHaveBeenCalledWith({ event: 'link_service_error', message: 'ECONNREFUSED' });
  });

  test('quand link-service répond une erreur serveur', async () => {
    links.create.mockResolvedValue({ status: 500, body: {} });
    expect((await upload(Buffer.from('x'))).status).toBe(502);
  });

  test('quand le stockage échoue', async () => {
    storage.put.mockImplementation(async (fileId, stream) => {
      stream.resume();
      throw new Error('MinIO indisponible');
    });
    const res = await upload(crypto.randomBytes(100_000));
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Stockage indisponible.');
    expect(storage.remove).toHaveBeenCalled();
  });
});

describe('limite de dépôts (ES-05)', () => {
  test('refuse au-delà de la limite par IP et par heure', async () => {
    build({ UPLOADS_PER_HOUR: '2' });
    expect((await upload(Buffer.from('1'))).status).toBe(201);
    expect((await upload(Buffer.from('2'))).status).toBe(201);
    const third = await upload(Buffer.from('3'));
    expect(third.status).toBe(429);
    expect(third.body.error).toMatch(/2 par heure/);
    const [key] = await redis.keys('uploads:*');
    expect(await redis.ttl(key)).toBeGreaterThan(3590);
  });

  test("lit l'IP réelle derrière l'Ingress", async () => {
    build({ UPLOADS_PER_HOUR: '1', TRUST_PROXY: '1' });
    const from = (ip) => upload(Buffer.from('x')).set('X-Forwarded-For', ip);
    expect((await from('203.0.113.1')).status).toBe(201);
    expect((await from('203.0.113.2')).status).toBe(201);
    expect((await from('203.0.113.1')).status).toBe(429);
  });
});

describe('santé', () => {
  test('répond ok quand Redis et MinIO répondent', async () => {
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
  redis.multi = () => {
    throw new Error('panne');
  };
  const res = await upload(Buffer.from('x'));
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ error: 'Erreur interne.' });
});

test.each([
  ['../../etc/passwd', 'passwd'],
  ['C:\\Users\\moi\\cni.png', 'cni.png'],
  ['nom\u0000avec\u001fcontrôle.txt', 'nomaveccontrôle.txt'],
  ['', 'fichier'],
  [undefined, 'fichier'],
])('cleanName(%j) = %j', (input, expected) => {
  expect(cleanName(input)).toBe(expected);
});
