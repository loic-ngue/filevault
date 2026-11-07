const crypto = require('node:crypto');
const { Transform } = require('node:stream');

// Format d'un objet chiffré dans MinIO (ES-01). Copie identique dans download-service :
// c'est le contrat entre les deux services.
//
//   version (1) | clé du fichier chiffrée : iv (12) + clé (32) + tag (16) | iv du fichier (12) | données chiffrées | tag (16)
//
// Chaque fichier a sa propre clé AES-256, chiffrée par la clé maître. L'identifiant du
// fichier sert de données authentifiées (AAD) : une clé ou un contenu recopié depuis
// un autre objet est refusé au déchiffrement.
const VERSION = 1;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;
const WRAPPED_KEY_LENGTH = IV_LENGTH + KEY_LENGTH + TAG_LENGTH;
const HEADER_LENGTH = 1 + WRAPPED_KEY_LENGTH + IV_LENGTH;
const ALGORITHM = 'aes-256-gcm';

function wrapKey(masterKey, fileKey, fileId) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv).setAAD(Buffer.from(fileId));
  return Buffer.concat([iv, cipher.update(fileKey), cipher.final(), cipher.getAuthTag()]);
}

function unwrapKey(masterKey, wrapped, fileId) {
  const iv = wrapped.subarray(0, IV_LENGTH);
  const tag = wrapped.subarray(IV_LENGTH + KEY_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, iv).setAAD(Buffer.from(fileId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(wrapped.subarray(IV_LENGTH, IV_LENGTH + KEY_LENGTH)), decipher.final()]);
}

// Chiffre en flux : le fichier n'est jamais chargé entier en mémoire.
class EncryptStream extends Transform {
  constructor(masterKey, fileId) {
    super();
    const fileKey = crypto.randomBytes(KEY_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    this.cipher = crypto.createCipheriv(ALGORITHM, fileKey, iv).setAAD(Buffer.from(fileId));
    this.header = Buffer.concat([Buffer.from([VERSION]), wrapKey(masterKey, fileKey, fileId), iv]);
    this.plaintextBytes = 0;
  }

  pushHeader() {
    if (this.header) {
      this.push(this.header);
      this.header = null;
    }
  }

  _transform(chunk, encoding, callback) {
    this.pushHeader();
    this.plaintextBytes += chunk.length;
    callback(null, this.cipher.update(chunk));
  }

  _flush(callback) {
    this.pushHeader();
    this.push(this.cipher.final());
    callback(null, this.cipher.getAuthTag());
  }
}

// Déchiffre en flux en retenant toujours les 16 derniers octets reçus : ce sont
// peut-être le tag, vérifié à la fin. Un objet altéré fait échouer le flux.
class DecryptStream extends Transform {
  constructor(masterKey, fileId) {
    super();
    this.masterKey = masterKey;
    this.fileId = fileId;
    this.decipher = null;
    this.pending = Buffer.alloc(0);
  }

  _transform(chunk, encoding, callback) {
    try {
      this.pending = Buffer.concat([this.pending, chunk]);
      if (!this.decipher) {
        if (this.pending.length < HEADER_LENGTH) return callback();
        this.start(this.pending.subarray(0, HEADER_LENGTH));
        this.pending = this.pending.subarray(HEADER_LENGTH);
      }
      const ready = this.pending.length - TAG_LENGTH;
      if (ready > 0) {
        this.push(this.decipher.update(this.pending.subarray(0, ready)));
        this.pending = this.pending.subarray(ready);
      }
      callback();
    } catch (err) {
      callback(err);
    }
  }

  start(header) {
    if (header[0] !== VERSION) throw new Error(`Version de format inconnue : ${header[0]}`);
    const fileKey = unwrapKey(this.masterKey, header.subarray(1, 1 + WRAPPED_KEY_LENGTH), this.fileId);
    const iv = header.subarray(1 + WRAPPED_KEY_LENGTH);
    this.decipher = crypto.createDecipheriv(ALGORITHM, fileKey, iv).setAAD(Buffer.from(this.fileId));
  }

  _flush(callback) {
    try {
      if (!this.decipher || this.pending.length !== TAG_LENGTH) throw new Error('Objet chiffré tronqué');
      this.decipher.setAuthTag(this.pending);
      callback(null, this.decipher.final());
    } catch (err) {
      callback(err);
    }
  }
}

const createEncryptStream = (masterKey, fileId) => new EncryptStream(masterKey, fileId);
const createDecryptStream = (masterKey, fileId) => new DecryptStream(masterKey, fileId);
const encryptedSize = (plaintextBytes) => HEADER_LENGTH + plaintextBytes + TAG_LENGTH;

module.exports = { createEncryptStream, createDecryptStream, encryptedSize, HEADER_LENGTH, TAG_LENGTH };
