import { createHash } from 'node:crypto';
import { AppError } from '../../types/error.js';
import { NativeBrowserBroker, type NativeBrowserResponse } from '../native-browser.js';

export function isDouyinLivePage(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.origin === 'https://live.douyin.com' && /^\/\d+$/.test(url.pathname) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export class DouyinNativeBroker extends NativeBrowserBroker {
  private lookups = new Map<string, Promise<NativeBrowserResponse>>();

  constructor() {
    super(
      isDouyinLivePage,
      () => new AppError('NETWORK_UNAVAILABLE', '抖音直播页面暂时无法加载', { retryable: true }),
      () => new AppError('NETWORK_UNAVAILABLE', '抖音直播页面读取超时', { retryable: true }),
      24_000,
      1,
    );
  }

  room(roomId: string, cookie: string, interactive: boolean): Promise<NativeBrowserResponse> {
    const sessionHash = createHash('sha256').update(cookie).digest('hex');
    const key = `${sessionHash}:${roomId}`;
    const current = this.lookups.get(key);
    if (current) return current;
    const pending = this.request(`https://live.douyin.com/${roomId}`, undefined, sessionHash, interactive)
      .finally(() => this.lookups.delete(key));
    this.lookups.set(key, pending);
    return pending;
  }
}
