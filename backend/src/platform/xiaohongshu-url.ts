export interface XiaohongshuTarget { url: URL; kind: 'profile' | 'room' | 'share'; id: string | null }

export function parseXiaohongshuUrl(raw: string): XiaohongshuTarget | null {
  try {
    const url = new URL(raw.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (url.hostname === 'xhslink.com' && /^\/[\w/-]+\/?$/.test(url.pathname)) return { url, kind: 'share', id: null };
    if (!['www.xiaohongshu.com', 'xiaohongshu.com'].includes(url.hostname)) return null;
    const profile = /^\/user\/profile\/([a-f\d]+)\/?$/i.exec(url.pathname);
    if (profile) return { url, kind: 'profile', id: profile[1]! };
    const room = /^\/livestream\/(\d+)(?:\/[\w-]+)?\/?$/.exec(url.pathname);
    return room ? { url, kind: 'room', id: room[1]! } : null;
  } catch { return null; }
}

export function normalizeXiaohongshuUrl(raw: string): string {
  const target = parseXiaohongshuUrl(raw);
  if (!target) return raw.trim();
  if (target.kind === 'profile') return `https://www.xiaohongshu.com/user/profile/${target.id}`;
  target.url.protocol = 'https:';
  target.url.hash = '';
  // Access tokens are required for some shares; remove only tracking parameters.
  for (const key of ['track_id', 'source', 'xhsshare', 'appuid', 'apptime']) target.url.searchParams.delete(key);
  return target.url.href;
}
