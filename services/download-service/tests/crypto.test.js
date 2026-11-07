const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createEncryptStream, createDecryptStream, encryptedSize, HEADER_LENGTH } = require('../src/crypto');

const MASTER_KEY = crypto.randomBytes(32);
const FILE_ID = 'fichier-test-0001';

// Fait passer un tampon dans un flux, découpé en morceaux de taille donnée.
async function run(stream, input, chunkSize = 1000) {
  const chunks = [];
  for (let i = 0; i < input.length; i += chunkSize) chunks.push(input.subarray(i, i + chunkSize));
  const out = [];
  await pipeline(Readable.from(chunks), stream, async (source) => {
    for await (const chunk of source) out.push(chunk);
  });
  return Buffer.concat(out);
}

const encrypt = (data, fileId = FILE_ID) => run(createEncryptStream(MASTER_KEY, fileId), data);
const decrypt = (data, { fileId = FILE_ID, masterKey = MASTER_KEY, chunkSize } = {}) =>
  run(createDecryptStream(masterKey, fileId), data, chunkSize);

test('retrouve le fichier original après chiffrement puis déchiffrement', async () => {
  const original = crypto.randomBytes(300_000);
  const encrypted = await encrypt(original);
  expect(encrypted.length).toBe(encryptedSize(original.length));
  expect((await decrypt(encrypted, { chunkSize: 7 })).equals(original)).toBe(true);
});

test('gère un fichier vide', async () => {
  const encrypted = await encrypt(Buffer.alloc(0));
  expect(encrypted.length).toBe(encryptedSize(0));
  expect((await decrypt(encrypted)).length).toBe(0);
});

test('rend le contenu illisible et différent à chaque chiffrement (R-05)', async () => {
  const original = Buffer.from('CONTRAT CONFIDENTIEL '.repeat(500));
  const a = await encrypt(original);
  const b = await encrypt(original);
  expect(a.includes(Buffer.from('CONTRAT'))).toBe(false);
  expect(a.equals(b)).toBe(false);
});

test('compte les octets en clair', async () => {
  const stream = createEncryptStream(MASTER_KEY, FILE_ID);
  await run(stream, Buffer.alloc(12_345));
  expect(stream.plaintextBytes).toBe(12_345);
});

describe('refuse un objet', () => {
  let encrypted;
  beforeAll(async () => {
    encrypted = await encrypt(Buffer.from('données sensibles'.repeat(100)));
  });

  test('dont le contenu a été modifié', async () => {
    const altered = Buffer.from(encrypted);
    altered[HEADER_LENGTH + 5] ^= 1;
    await expect(decrypt(altered)).rejects.toThrow();
  });

  test('dont le tag a été modifié', async () => {
    const altered = Buffer.from(encrypted);
    altered[altered.length - 1] ^= 1;
    await expect(decrypt(altered)).rejects.toThrow();
  });

  test('associé à un autre identifiant de fichier', async () => {
    await expect(decrypt(encrypted, { fileId: 'autre-fichier' })).rejects.toThrow();
  });

  test('avec une autre clé maître', async () => {
    await expect(decrypt(encrypted, { masterKey: crypto.randomBytes(32) })).rejects.toThrow();
  });

  test('tronqué', async () => {
    await expect(decrypt(encrypted.subarray(0, HEADER_LENGTH + 10))).rejects.toThrow('tronqué');
    await expect(decrypt(encrypted.subarray(0, 20))).rejects.toThrow('tronqué');
  });

  test("d'une version inconnue", async () => {
    const altered = Buffer.from(encrypted);
    altered[0] = 9;
    await expect(decrypt(altered)).rejects.toThrow('Version');
  });
});
