const request = require('supertest');
const Redis = require('ioredis-mock');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { EXPIRATIONS, SIZES } = require('../src/store');
const { sha256 } = require('../src/tokens');

const INTERNAL = 'Bearer jeton-interne-test';
const ADMIN = 'Bearer jeton-admin-test';

let redis;
let app;

beforeEach(async () => {
  redis = new Redis();
  await redis.flushall();
  const config = loadConfig({
    INTERNAL_TOKEN: 'jeton-interne-test',
    ADMIN_TOKEN: 'jeton-admin-test',
    ALLOWED_DURATIONS: '5m,10m,1h,24h,7d',
    BCRYPT_COST: '4',
  });
  app = createApp({ config, redis });
});

afterEach(() => redis.disconnect());

const validLink = (overrides = {}) => ({
  fileId: 'fichier-0001',
  name: 'contrat.pdf',
  size: 2 * 1024 * 1024,
  mime: 'application/pdf',
  duration: '1h',
  maxDownloads: 3,
  ...overrides,
});

const createLink = (overrides) =>
  request(app).post('/api/links').set('Authorization', INTERNAL).send(validLink(overrides));

const consume = (token, body = {}) =>
  request(app).post(`/api/links/${token}/consume`).set('Authorization', INTERNAL).send(body);

describe('santé et métriques', () => {
  test('GET /health répond ok quand Redis répond', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('GET /health répond 503 quand Redis est indisponible, GET /live reste ok', async () => {
    redis.ping = () => Promise.reject(new Error('down'));
    expect((await request(app).get('/health')).status).toBe(503);
    expect((await request(app).get('/live')).status).toBe(200);
  });

  test('GET /metrics expose les métriques Prometheus', async () => {
    await createLink();
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('filevault_link_events_total{event="created"} 1');
  });

  test('envoie les en-têtes de sécurité (ES-11)', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('création de lien', () => {
  test('refuse un appel sans jeton interne', async () => {
    const res = await request(app).post('/api/links').send(validLink());
    expect(res.status).toBe(401);
  });

  test('crée un lien de 256 bits avec un code de révocation (EF-04, ES-02)', async () => {
    const res = await createLink();
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.revokeCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(res.body.maxDownloads).toBe(3);
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
  });

  test('applique la durée choisie comme TTL Redis (EF-02)', async () => {
    const { body } = await createLink({ duration: '5m' });
    const ttl = await redis.ttl(`link:${sha256(body.token)}`);
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  test("ne stocke ni le jeton ni le mot de passe en clair (ES-03)", async () => {
    const { body } = await createLink({ password: 'secret123' });
    const keys = await redis.keys('*');
    expect(keys.join()).not.toContain(body.token);
    const stored = await redis.hgetall(`link:${sha256(body.token)}`);
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$04\$/);
    expect(JSON.stringify(stored)).not.toContain('secret123');
  });

  test('indexe le fichier pour le nettoyage', async () => {
    const { body } = await createLink();
    const score = Number(await redis.zscore(EXPIRATIONS, 'fichier-0001'));
    expect(score).toBe(Date.parse(body.expiresAt));
    expect(await redis.hget(SIZES, 'fichier-0001')).toBe(String(2 * 1024 * 1024));
  });

  test.each([
    ['durée inconnue', { duration: '2h' }, /Durée invalide/],
    ['0 téléchargement', { maxDownloads: 0 }, /entre 1 et 10/],
    ['11 téléchargements (EF-03)', { maxDownloads: 11 }, /entre 1 et 10/],
    ['fichier de plus de 50 Mo (EF-01)', { size: 50 * 1024 * 1024 + 1 }, /Taille/],
    ['identifiant de fichier invalide', { fileId: '../etc' }, /Identifiant/],
    ['nom vide', { name: '' }, /Nom/],
    ['type trop long', { mime: 'x'.repeat(256) }, /Type/],
    ['mot de passe de plus de 72 octets', { password: 'é'.repeat(37) }, /Mot de passe/],
  ])('refuse : %s', async (_, overrides, message) => {
    const res = await createLink(overrides);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });

  test('refuse un JSON mal formé', async () => {
    const res = await request(app)
      .post('/api/links')
      .set('Authorization', INTERNAL)
      .set('Content-Type', 'application/json')
      .send('{"fileId":');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('JSON invalide.');
  });
});

describe('consultation par le destinataire (EF-10)', () => {
  test('affiche nom, taille, temps restant et besoin de mot de passe', async () => {
    const { body } = await createLink({ password: 'secret123' });
    const res = await request(app).get(`/api/links/${body.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      name: 'contrat.pdf',
      size: 2 * 1024 * 1024,
      mime: 'application/pdf',
      expiresAt: body.expiresAt,
      remainingDownloads: 3,
      passwordRequired: true,
    });
  });

  test('refuse un lien inconnu avec un message clair (EF-06)', async () => {
    const res = await request(app).get('/api/links/inconnu');
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/Lien expiré/);
  });
});

describe('téléchargement', () => {
  test('refuse un appel sans jeton interne', async () => {
    const { body } = await createLink();
    expect((await request(app).post(`/api/links/${body.token}/consume`)).status).toBe(401);
  });

  test('décompte les téléchargements puis refuse le suivant (R-02, R-03)', async () => {
    const { body } = await createLink({ maxDownloads: 2 });

    const first = await consume(body.token);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ fileId: 'fichier-0001', name: 'contrat.pdf', remainingDownloads: 1 });
    expect((await consume(body.token)).body.remainingDownloads).toBe(0);

    const third = await consume(body.token);
    expect(third.status).toBe(410);
    expect(third.body.error).toMatch(/Lien expiré/);
  });

  test('planifie la suppression du fichier dès le dernier téléchargement', async () => {
    const { body } = await createLink({ maxDownloads: 1 });
    await consume(body.token);
    const score = Number(await redis.zscore(EXPIRATIONS, 'fichier-0001'));
    expect(score).toBeLessThanOrEqual(Date.now());
  });

  test('ne dépasse jamais la limite sous des requêtes simultanées', async () => {
    const { body } = await createLink({ maxDownloads: 3 });
    const results = await Promise.all(Array.from({ length: 8 }, () => consume(body.token)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 410)).toHaveLength(5);
  });

  test('refuse un lien inconnu', async () => {
    expect((await consume('inconnu')).status).toBe(410);
  });
});

describe('mot de passe (EF-08, ES-04)', () => {
  test('accepte le bon mot de passe', async () => {
    const { body } = await createLink({ password: 'secret123' });
    expect((await consume(body.token, { password: 'secret123' })).status).toBe(200);
  });

  test('refuse un mot de passe absent ou faux sans décompter', async () => {
    const { body } = await createLink({ password: 'secret123' });
    expect((await consume(body.token)).status).toBe(401);
    expect((await consume(body.token, { password: 'faux' })).status).toBe(401);
    const info = await request(app).get(`/api/links/${body.token}`);
    expect(info.body.remainingDownloads).toBe(3);
  });

  test('bloque le lien après 5 échecs, même avec le bon mot de passe (R-06)', async () => {
    const { body } = await createLink({ password: 'secret123' });
    for (let i = 0; i < 4; i++) expect((await consume(body.token, { password: 'faux' })).status).toBe(401);
    expect((await consume(body.token, { password: 'faux' })).status).toBe(429);

    const blocked = await consume(body.token, { password: 'secret123' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/15 minutes/);

    const ttl = await redis.ttl(`attempts:${sha256(body.token)}`);
    expect(ttl).toBeGreaterThan(890);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  test('remet le compteur à zéro après un succès', async () => {
    const { body } = await createLink({ password: 'secret123' });
    await consume(body.token, { password: 'faux' });
    await consume(body.token, { password: 'secret123' });
    expect(await redis.exists(`attempts:${sha256(body.token)}`)).toBe(0);
  });
});

describe('révocation (EF-09)', () => {
  test('refuse un code incorrect ou absent', async () => {
    const { body } = await createLink();
    const res = await request(app).post(`/api/links/${body.token}/revoke`).send({ revokeCode: 'faux' });
    expect(res.status).toBe(403);
    expect((await request(app).post(`/api/links/${body.token}/revoke`)).status).toBe(403);
  });

  test('révoque le lien et planifie la suppression du fichier', async () => {
    const { body } = await createLink();
    const res = await request(app).post(`/api/links/${body.token}/revoke`).send({ revokeCode: body.revokeCode });
    expect(res.status).toBe(204);
    expect((await request(app).get(`/api/links/${body.token}`)).status).toBe(410);
    expect(Number(await redis.zscore(EXPIRATIONS, 'fichier-0001'))).toBeLessThanOrEqual(Date.now());
  });

  test('refuse un lien inconnu', async () => {
    const res = await request(app).post('/api/links/inconnu/revoke').send({ revokeCode: 'x' });
    expect(res.status).toBe(410);
  });
});

describe('statistiques administrateur (EF-11)', () => {
  test('exigent le jeton administrateur', async () => {
    expect((await request(app).get('/api/links/stats')).status).toBe(401);
    expect((await request(app).get('/api/links/stats').set('Authorization', INTERNAL)).status).toBe(401);
  });

  test('comptent fichiers actifs, volume et téléchargements', async () => {
    await createLink({ fileId: 'fichier-0001', size: 1000 });
    const second = await createLink({ fileId: 'fichier-0002', size: 500, maxDownloads: 1 });
    await createLink({ fileId: 'fichier-0003', size: 200 });
    await consume(second.body.token); // épuisé : n'est plus actif

    const res = await request(app).get('/api/links/stats').set('Authorization', ADMIN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ activeFiles: 2, totalBytes: 1200, downloads: 1 });
  });
});

test('répond 404 en JSON sur une route inconnue', async () => {
  const res = await request(app).get('/inconnu');
  expect(res.status).toBe(404);
  expect(res.body.error).toBeDefined();
});

test("répond 500 sans détail quand Redis échoue", async () => {
  const log = jest.fn();
  const failing = new Redis();
  failing.hgetall = () => Promise.reject(new Error('panne'));
  const config = loadConfig({ INTERNAL_TOKEN: 'x' });
  const res = await request(createApp({ config, redis: failing, log })).get('/api/links/abc');
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ error: 'Erreur interne.' });
  expect(log).toHaveBeenCalledWith({ event: 'error', message: 'panne' });
});
