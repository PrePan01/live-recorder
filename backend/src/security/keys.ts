export const MAIL_PASSWORD_KEY = 'mail.password';

export const DOUYIN_COOKIE_KEY = 'douyin.cookie';

export const OPENLIST_TOKEN_KEY = 'openlist.token';

/** 生产环境钥匙串服务名（正式客户端）。 */
export const KEYCHAIN_SERVICE = 'live-recorder';

/**
 * 按环境取钥匙串服务名（#224 P0 隔离）：dev（LIVE_RECORDER_DATA_DIR 隔离）用独立服务名
 * `live-recorder-dev`，与生产正式客户端凭据（Cookie/SMTP/OpenList token）完全隔离互不读写。
 */
export function keychainService(): string {
  const dir = process.env.LIVE_RECORDER_DATA_DIR;
  return dir && dir.length > 0 ? 'live-recorder-dev' : KEYCHAIN_SERVICE;
}