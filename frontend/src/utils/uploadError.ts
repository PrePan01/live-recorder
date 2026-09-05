/** 上传错误码：映射 job.error 纯文本为稳定分类，供分级展示/错误码对照。 */
export type UploadErrorCode =
  | 'OPENLIST_2FA_REQUIRED'
  | 'OPENLIST_QUOTA_EXCEEDED'
  | 'OPENLIST_RESOURCE_NOT_FOUND'
  | 'OPENLIST_TASK_FAILED'
  | 'OPENLIST_TASK_NOT_FOUND'
  | 'OPENLIST_AUTH_FAILED'
  | 'WEBDAV_405'
  | 'WEBDAV_504'
  | 'SOURCE_DELETED'
  | 'TOKEN_MISSING'
  | 'CONFIG_OR_FILE_MISSING'
  | 'NETWORK'
  | 'STALLED'
  | 'LEGACY'
  | 'UNKNOWN';

export interface UploadErrorInfo {
  code: UploadErrorCode;
  /** 一句话可执行建议（分级展示用）。 */
  action: string;
}

const ERROR_MATCHERS: Array<{ code: UploadErrorCode; test: RegExp; action: string }> = [
  { code: 'OPENLIST_2FA_REQUIRED', test: /OpenList 需要 2FA 验证/, action: 'OpenList 账号已启用 2FA，请在弹窗中输入验证器生成的一次性验证码后重新上传。' },
  { code: 'OPENLIST_QUOTA_EXCEEDED', test: /配额|存储空间不足|资源配额/, action: 'OpenList 云端存储配额不足，请到 OpenList/云盘清理旧文件或扩容后重新上传。' },
  { code: 'OPENLIST_RESOURCE_NOT_FOUND', test: /资源不存在|文件不存在|目录不存在/, action: 'OpenList 云端找不到该上传资源（目标目录/文件缺失），请先在 OpenList 核对目标路径与云盘状态，确认后重新上传。' },
  { code: 'OPENLIST_TASK_NOT_FOUND', test: /task.*不存在|not found|任务不存在/i, action: 'OpenList 后台任务不存在，可能已被服务端清理，请点击重新上传。' },
  { code: 'OPENLIST_TASK_FAILED', test: /OpenList 后台上传(失败|已取消)|后台上传失败/, action: 'OpenList 后台任务已失败或取消，请查看详细原因；如为云端写入问题需在 OpenList 侧处理。' },
  { code: 'OPENLIST_AUTH_FAILED', test: /认证失败|401|403|Invalid.*(token|code|credential)/i, action: 'OpenList 认证失败，请检查账号令牌或重新获取 2FA 验证码。' },
  { code: 'WEBDAV_405', test: /WebDAV PUT 405|method not allowed/i, action: '目标地址不接受 WebDAV PUT，请确认服务器地址以 /dav 开头，并检查目标存储是否允许上传和覆盖。' },
  { code: 'WEBDAV_504', test: /WebDAV PUT 504|gateway timeout/i, action: 'OpenList 或反向代理确认超时；文件可能已写入云盘，请先在 OpenList 核对，确认缺失后再重新上传。' },
  { code: 'SOURCE_DELETED', test: /源文件已删除/, action: '本地源文件已删除，无法上传。若需保留，请先恢复文件或重新录制。' },
  { code: 'TOKEN_MISSING', test: /令牌未配置/, action: 'OpenList 令牌未配置，请在设置中保存令牌后重新上传。' },
  { code: 'CONFIG_OR_FILE_MISSING', test: /配置或文件缺失|录制无文件|文件缺失/, action: 'OpenList 配置或本地录像文件已不存在，无法继续该上传任务。' },
  { code: 'NETWORK', test: /fetch failed|ENOTFOUND|ECONNREFUSED/, action: '无法连接 OpenList，请检查服务地址、网络和反向代理后重新上传。' },
  { code: 'STALLED', test: /长时间无响应|超时|停滞|进度长时间无变化/, action: '上传长时间没有响应，请检查 OpenList 云盘驱动及反向代理超时设置。' },
  { code: 'LEGACY', test: /duplex option is required/, action: '当前任务来自旧版本上传实现，请升级应用后点击"重新上传"。' },
];

/** 兼容旧版本已落库的原始错误：返回稳定错误码 + 一句话可执行建议。 */
export function classifyUploadError(error: string | null | undefined): UploadErrorInfo {
  if (!error) return { code: 'UNKNOWN', action: '' };
  for (const m of ERROR_MATCHERS) {
    if (m.test.test(error)) return { code: m.code, action: m.action };
  }
  return { code: 'UNKNOWN', action: error };
}

/**
 * 兼容旧调用：返回一句话可执行建议的纯文本。
 * 未映射到的上游错误直接透传原文，保证历史任务也能看到完整原因。
 */
export function describeUploadError(error: string | null | undefined): string | null {
  if (!error) return null;
  const { action } = classifyUploadError(error);
  return action || error;
}