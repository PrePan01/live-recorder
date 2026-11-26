import type { ChineseLivePlatform } from '../../security/keys.js';

const RESERVED_ROOM_PATHS = new Set([
  'about', 'activity', 'download', 'game', 'g', 'help', 'home', 'index', 'live',
  'login', 'l', 'rank', 'search', 'topic', 'video', 'videos', 'vod', 'follow',
  'replay', 'profile', 'category', 'categories', 'directory', 'personal', 'user',
]);

export function numericRoomId(value: unknown): string | undefined {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return;
  if (typeof value !== 'string' && typeof value !== 'number') return;
  const id = String(value).replace(/^0+/, '');
  return /^[1-9]\d{0,19}$/.test(id) ? id : undefined;
}

export function parseChineseRoomLink(platform: ChineseLivePlatform, raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const domain = `${platform}.com`;
    if (!['http:', 'https:'].includes(url.protocol) || url.port || url.username || url.password ||
        ![domain, `www.${domain}`, `m.${domain}`].includes(url.hostname)) return null;
    if (platform === 'douyu' && /^\/topic\/[\w-]+\/?$/.test(url.pathname)) {
      return numericRoomId(url.searchParams.get('rid')) ?? null;
    }
    const name = /^\/([\w-]{1,64})\/?$/.exec(url.pathname)?.[1];
    if (!name || RESERVED_ROOM_PATHS.has(name.toLowerCase())) return null;
    if (/^\d+$/.test(name)) return numericRoomId(name) ?? null;
    return name;
  } catch {
    return null;
  }
}

export function chineseRoomUrl(platform: ChineseLivePlatform, room: string): string {
  return `https://www.${platform}.com/${room}`;
}
