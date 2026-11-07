import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSize, formatRemaining, parseRoute, shareUrl, errorMessage, plural } from '../public/js/format.js';

test('formatSize', () => {
  assert.equal(formatSize(0), '0 octets');
  assert.equal(formatSize(512), '512 octets');
  assert.equal(formatSize(1536), '1,5 Ko');
  assert.equal(formatSize(2 * 1024 * 1024), '2,0 Mo');
  assert.equal(formatSize(50 * 1024 * 1024), '50 Mo');
  assert.equal(formatSize(3 * 1024 ** 3), '3,0 Go');
});

test('formatRemaining', () => {
  assert.equal(formatRemaining(0), 'expiré');
  assert.equal(formatRemaining(-5), 'expiré');
  assert.equal(formatRemaining(9_400), '9 s');
  assert.equal(formatRemaining(249_000), '4 min 09 s');
  assert.equal(formatRemaining(3_900_000), '1 h 05 min');
  assert.equal(formatRemaining(2 * 86_400_000 + 3 * 3_600_000), '2 j 3 h');
});

test('parseRoute', () => {
  assert.deepEqual(parseRoute('#/d/AbC_-123'), { view: 'download', token: 'AbC_-123' });
  assert.deepEqual(parseRoute('#/admin'), { view: 'admin' });
  assert.deepEqual(parseRoute(''), { view: 'upload' });
  assert.deepEqual(parseRoute('#/d/'), { view: 'upload' });
  assert.deepEqual(parseRoute('#/d/<script>'), { view: 'upload' });
});

test('shareUrl', () => {
  assert.equal(shareUrl('https://filevault.local', 'abc'), 'https://filevault.local/d/abc');
});

test('errorMessage', () => {
  assert.equal(errorMessage(410, { error: 'Lien expiré ou invalide.' }), 'Lien expiré ou invalide.');
  assert.equal(errorMessage(401, {}), 'Mot de passe incorrect.');
  assert.equal(errorMessage(0, null), 'Connexion impossible. Vérifiez votre réseau.');
  assert.equal(errorMessage(418, undefined), 'Une erreur est survenue (code 418).');
});

test('plural', () => {
  assert.equal(plural(1, 'téléchargement'), '1 téléchargement');
  assert.equal(plural(3, 'téléchargement'), '3 téléchargements');
  assert.equal(plural(0, 'fichier'), '0 fichier');
});
