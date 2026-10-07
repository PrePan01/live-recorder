import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyInstallerSignature } from './verify-installer-signatures.mjs';
import { pubkey, signature } from './test-fixtures/signatures.mjs';

test('signature verification rejects wrong keys, tampered payloads and trusted comments', () => {
  const sig = signature('installer');
  const hash = createHash('blake2b512').update('installer').digest();
  verifyInstallerSignature(pubkey, sig, hash);
  assert.throws(() => verifyInstallerSignature(pubkey, sig, createHash('blake2b512').update('tampered').digest()), /verification failed/);
  const changed = Buffer.from(Buffer.from(sig, 'base64').toString().replace('trusted comment: test installer', 'trusted comment: other installer')).toString('base64');
  assert.throws(() => verifyInstallerSignature(pubkey, changed, hash), /verification failed/);
  assert.throws(() => verifyInstallerSignature('invalid key', sig, hash), /signing key/);
});

test('verifier accepts signatures produced by the installed Tauri CLI', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lr-tauri-signature-'));
  const key = join(directory, 'test.key');
  const file = join(directory, 'installer.dmg');
  try {
    const cli = resolve('frontend/node_modules/@tauri-apps/cli/tauri.js');
    const run = (args) => {
      // Never print signer output: generation may include the temporary key.
      const env = { ...process.env };
      delete env.TAURI_SIGNING_PRIVATE_KEY;
      delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
      assert.equal(result.status, 0, 'Tauri signer command failed');
    };
    run(['signer', 'generate', '--ci', '--password', '', '--write-keys', key]);
    writeFileSync(file, 'Tauri signer integration');
    run(['signer', 'sign', '--private-key-path', key, '--password', '', file]);
    verifyInstallerSignature(readFileSync(`${key}.pub`, 'utf8').trim(), readFileSync(`${file}.sig`, 'utf8').trim(), createHash('blake2b512').update(readFileSync(file)).digest());
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
