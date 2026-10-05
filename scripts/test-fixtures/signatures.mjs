import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keyId = Buffer.from('0102030405060708', 'hex');
export const pubkey = Buffer.from(`untrusted comment: test key\n${Buffer.concat([Buffer.from('Ed'), keyId, publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]).toString('base64')}\n`).toString('base64');
export function signature(bytes) {
  const detached = sign(null, createHash('blake2b512').update(bytes).digest(), privateKey);
  const comment = 'test installer';
  const packet = Buffer.concat([Buffer.from('ED'), keyId, detached]);
  const global = sign(null, Buffer.concat([detached, Buffer.from(comment)]), privateKey);
  return Buffer.from(`untrusted comment: test\n${packet.toString('base64')}\ntrusted comment: ${comment}\n${global.toString('base64')}\n`).toString('base64');
}
export const writeSignature = (dir, name, bytes = name.endsWith('.dmg') ? 'abc' : 'abcd') => writeFile(join(dir, `${name}.sig`), `${signature(bytes)}\n`);
