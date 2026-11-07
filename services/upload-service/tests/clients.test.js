const { createLinkClient, createMinioStorage } = require('../src/clients');
const { parseMasterKey } = require('../src/config');

test('createLinkClient appelle link-service avec le jeton interne', async () => {
  const fetchImpl = jest.fn(async () => ({ status: 201, json: async () => ({ token: 't' }) }));
  const client = createLinkClient({ baseUrl: 'http://link:3000', internalToken: 'secret', fetchImpl });

  const result = await client.create({ fileId: 'abc' });

  expect(result).toEqual({ status: 201, body: { token: 't' } });
  const [url, options] = fetchImpl.mock.calls[0];
  expect(url).toBe('http://link:3000/api/links');
  expect(options.method).toBe('POST');
  expect(options.headers.authorization).toBe('Bearer secret');
  expect(JSON.parse(options.body)).toEqual({ fileId: 'abc' });
});

test('createLinkClient tolère une réponse qui n’est pas du JSON', async () => {
  const fetchImpl = async () => ({ status: 502, json: async () => JSON.parse('<html>') });
  const client = createLinkClient({ baseUrl: 'http://link:3000', internalToken: 's', fetchImpl });
  expect(await client.create({})).toEqual({ status: 502, body: {} });
});

test('createMinioStorage crée le bucket seulement s’il manque', async () => {
  const minio = { bucketExists: jest.fn(async () => false), makeBucket: jest.fn(async () => {}) };
  await createMinioStorage(minio, 'filevault').ensureBucket();
  expect(minio.makeBucket).toHaveBeenCalledWith('filevault');

  minio.bucketExists.mockResolvedValue(true);
  minio.makeBucket.mockClear();
  await createMinioStorage(minio, 'filevault').ensureBucket();
  expect(minio.makeBucket).not.toHaveBeenCalled();
});

test('createMinioStorage délègue put et remove au bucket', async () => {
  const minio = { putObject: jest.fn(), removeObject: jest.fn(), bucketExists: jest.fn() };
  const storage = createMinioStorage(minio, 'filevault');
  storage.put('id', 'flux');
  storage.remove('id');
  storage.ready();
  expect(minio.putObject).toHaveBeenCalledWith('filevault', 'id', 'flux', undefined, { 'Content-Type': 'application/octet-stream' });
  expect(minio.removeObject).toHaveBeenCalledWith('filevault', 'id');
  expect(minio.bucketExists).toHaveBeenCalledWith('filevault');
});

test('parseMasterKey exige 32 octets', () => {
  expect(parseMasterKey(Buffer.alloc(32, 1).toString('base64')).length).toBe(32);
  expect(() => parseMasterKey('')).toThrow('MASTER_KEY');
  expect(() => parseMasterKey(Buffer.alloc(16).toString('base64'))).toThrow('MASTER_KEY');
});
