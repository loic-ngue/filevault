const { createLinkClient, createMinioStorage } = require('../src/clients');
const { parseMasterKey } = require('../src/config');

test('consume appelle link-service avec le jeton interne et le mot de passe', async () => {
  const fetchImpl = jest.fn(async () => ({ status: 200, json: async () => ({ fileId: 'f' }) }));
  const client = createLinkClient({ baseUrl: 'http://link:3000', internalToken: 'secret', fetchImpl });

  expect(await client.consume('a/b', 'mdp')).toEqual({ status: 200, body: { fileId: 'f' } });
  const [url, options] = fetchImpl.mock.calls[0];
  expect(url).toBe('http://link:3000/api/links/a%2Fb/consume');
  expect(options.headers.authorization).toBe('Bearer secret');
  expect(JSON.parse(options.body)).toEqual({ password: 'mdp' });
});

test("consume n'envoie pas de mot de passe vide et tolère une réponse non JSON", async () => {
  const fetchImpl = jest.fn(async () => ({ status: 502, json: async () => JSON.parse('<html>') }));
  const client = createLinkClient({ baseUrl: 'http://link:3000', internalToken: 's', fetchImpl });
  expect(await client.consume('t')).toEqual({ status: 502, body: {} });
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({});
});

test('get renvoie null pour un objet absent et relaie les autres erreurs', async () => {
  const missing = Object.assign(new Error('absent'), { code: 'NoSuchKey' });
  const minio = { getObject: jest.fn().mockRejectedValueOnce(missing).mockRejectedValueOnce(new Error('panne')) };
  const storage = createMinioStorage(minio, 'filevault');
  expect(await storage.get('id')).toBeNull();
  await expect(storage.get('id')).rejects.toThrow('panne');
  expect(minio.getObject).toHaveBeenCalledWith('filevault', 'id');
});

test('get renvoie le flux et ready interroge le bucket', async () => {
  const minio = { getObject: jest.fn(async () => 'flux'), bucketExists: jest.fn(async () => true) };
  const storage = createMinioStorage(minio, 'filevault');
  expect(await storage.get('id')).toBe('flux');
  expect(await storage.ready()).toBe(true);
  expect(minio.bucketExists).toHaveBeenCalledWith('filevault');
});

test('parseMasterKey exige 32 octets', () => {
  expect(parseMasterKey(Buffer.alloc(32, 1).toString('base64')).length).toBe(32);
  expect(() => parseMasterKey('')).toThrow('MASTER_KEY');
});
