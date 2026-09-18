import type { BilibiliCookieStatus, DouyinCookieStatus } from '../api/settings';

/** 平台登录态探测结果（两个平台口径一致）。 */
export type CookieProbeStatus = BilibiliCookieStatus | DouyinCookieStatus;

/** 凭证在界面上呈现的状态。 */
export type CredentialStatus = 'authorized' | 'invalid' | 'unauthorized';

/**
 * 凭证展示状态：探测结果优先于「本地是否存过」。
 *
 * 登录失效后本地 Cookie 仍在，只看存没存过会把失效的登录显示成已登录；
 * 探测失败或尚未探测（unknown / null）时才回退到本地是否存过，避免把正常的登录误报成失效。
 */
export function credentialStatus(probe: CookieProbeStatus | null, hasCookie: boolean): CredentialStatus {
  if (probe === 'invalid') return 'invalid';
  if (probe === 'missing') return 'unauthorized';
  return hasCookie ? 'authorized' : 'unauthorized';
}
