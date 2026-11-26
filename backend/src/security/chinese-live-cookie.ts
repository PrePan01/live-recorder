import { AppError } from '../types/error.js';
import { number, responseJson, sameSiteHeaders, webRequest } from '../platform/chinese-live/adapter.js';
import { huyaCookieStatus } from '../platform/huya/verify-cookie.js';
import type { ChineseLivePlatform } from './keys.js';

export const CHINESE_LIVE_COOKIE_FIELDS = { douyu: 'douyuCookie', huya: 'huyaCookie' } as const;
export const CHINESE_LIVE_PLATFORMS = ['douyu', 'huya'] as const;

export function normalizeChineseLiveCookie(platform: ChineseLivePlatform, value: unknown): string {
  const label = platform === 'douyu' ? '斗鱼' : '虎牙';
  if (typeof value !== 'string') throw new AppError('CONFIG_INVALID', `${label} Cookie 必须为字符串`);
  const cookie = value.trim().replace(/^cookie\s*:\s*/i, '');
  if (!cookie) return '';
  if (cookie.length > 16384 || /[\u0000-\u001f\u007f-\uffff]/.test(cookie) ||
      !cookie.split(';').filter(part => part.trim()).every(part => /^[!#$%&'*+.^_`|~\w-]+=[^;]*$/.test(part.trim()))) {
    throw new AppError('CONFIG_INVALID', `${label} Cookie 格式无效`);
  }
  const required = platform === 'douyu' ? /(?:^|;\s*)acf_auth=[^;\s]+/ : /(?:^|;\s*)yyuid=[1-9]\d*(?:;|$)/;
  if (!required.test(cookie)) throw new AppError('CONFIG_INVALID', `请登录${label}后复制完整的网页 Cookie`);
  return cookie;
}

export async function checkChineseLiveCookie(
  platform: ChineseLivePlatform, cookie: string, fetcher: typeof fetch = fetch,
): Promise<'valid' | 'invalid' | 'unknown'> {
  if (platform === 'huya') return huyaCookieStatus(cookie);
  try {
    const headers = sameSiteHeaders(platform, '', cookie);
    const response = await webRequest(fetcher, '斗鱼授权检查', 'https://www.douyu.com/wgapi/livenc/liveweb/follow/top3', { headers });
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      return 'invalid';
    }
    const body = await responseJson(response, '斗鱼授权检查');
    if (number(body.error ?? body.code) === 0 && body.data !== undefined && body.data !== null) return 'valid';
    if (/未登[录陆]|登[录陆]失效|请登[录陆]|token已过期/i.test(String(body.msg ?? body.message))) return 'invalid';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
