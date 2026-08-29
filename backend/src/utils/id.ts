const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 48bit 毫秒时间戳 + 80bit 随机数，Crockford base32，共 26 字符。 */
export function ulid(now: number = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  for (const b of bytes) rand += CROCKFORD[b & 31]!;
  return time + rand;
}

export function newId(prefix: 'room' | 'rec' | 'alr' | 'tag' | 'diag' | 'act' | 'prun' | 'part' | 'upl'): string {
  return `${prefix}_${ulid()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
