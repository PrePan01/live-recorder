import { AppError } from '../types/error.js';
import { XHS_UA } from '../platform/xiaohongshu.js';

export function normalizeXiaohongshuCookie(raw: string): string {
  return raw.trim().replace(/^cookie\s*:\s*/i, '');
}
export function validateXiaohongshuCookie(cookie: string): void {
  if (cookie.length > 32768 || /[\r\n\x00]/.test(cookie) || !/(?:^|;\s*)web_session=[^;\s]+/.test(cookie)) {
    throw new AppError('CONFIG_INVALID', '小红书 Cookie 无效，请在授权窗口登录，或粘贴包含 web_session 的完整 Cookie');
  }
}
export async function checkXiaohongshuCookieStatus(cookie: string, fetcher: typeof fetch = fetch): Promise<'valid' | 'invalid' | 'unknown'> {
  try {
    const response = await fetcher('https://edith.xiaohongshu.com/api/sns/web/v1/user/selfinfo', {
      headers: { Cookie: cookie, 'User-Agent': XHS_UA, Referer: 'https://www.xiaohongshu.com/' }, signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401) return 'invalid';
    if (!response.ok) return 'unknown';
    const json = await response.json() as { success?: boolean; code?: number; data?: { user_id?: string; guest?: boolean } };
    if (json.success === true && json.data?.user_id && json.data.guest === false) return 'valid';
    if (json.code === -100 || json.data?.guest === true) return 'invalid';
    return 'unknown';
  } catch { return 'unknown'; }
}
