import { createPublicKey, verify } from 'node:crypto';

// Tauri encodes a minisign public key and detached signature as base64 text.
// Match minisign-verify: ED = BLAKE2b-512 prehash, Ed25519 signature plus signed
// trusted comment. Never accept an unverified comment or a different key ID.
export function verifyInstallerSignature(pubkey, signature, prehash) {
  const keyLines = Buffer.from(pubkey, 'base64').toString('utf8').trim().split(/\r?\n/);
  const lines = Buffer.from(signature, 'base64').toString('utf8').trim().split(/\r?\n/);
  const key = Buffer.from(keyLines[1] ?? '', 'base64');
  const packet = Buffer.from(lines[1] ?? '', 'base64');
  const global = Buffer.from(lines[3] ?? '', 'base64');
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed'
      || packet.length !== 74 || packet.subarray(0, 2).toString() !== 'ED'
      || !key.subarray(2, 10).equals(packet.subarray(2, 10))
      || !lines[2]?.startsWith('trusted comment: ') || global.length !== 64) {
    throw new Error('Invalid installer signature or signing key');
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]),
    format: 'der', type: 'spki',
  });
  const detached = packet.subarray(10);
  if (!verify(null, prehash, publicKey, detached)
      || !verify(null, Buffer.concat([detached, Buffer.from(lines[2].slice(17))]), publicKey, global)) {
    throw new Error('Installer signature verification failed');
  }
}
