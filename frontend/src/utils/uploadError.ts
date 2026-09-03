/** 兼容旧版本已落库的原始错误，让历史任务也能给出可执行的处理建议。 */
export function describeUploadError(error: string | null | undefined): string | null {
  if (!error) return null;
  if (error.includes('请检查') || error.includes('请调大') || error.includes('稍后重试')) return error;
  if (/WebDAV PUT 504|gateway timeout/i.test(error)) {
    return 'OpenList 或反向代理确认超时；文件可能已经写入云盘，请先在 OpenList 核对，确认缺失后再重新上传。';
  }
  if (/WebDAV PUT 405|method not allowed/i.test(error)) {
    return '目标地址不接受 WebDAV PUT，请确认服务器地址以 /dav 开头，并检查目标存储是否允许上传和覆盖。';
  }
  if (/duplex option is required/i.test(error)) {
    return '当前任务来自旧版本上传实现，请升级应用后点击“重新上传”。';
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED/i.test(error)) {
    return '无法连接 OpenList，请检查服务地址、网络和反向代理后重新上传。';
  }
  if (/长时间无响应|超时|停滞/i.test(error)) {
    return `上传长时间没有响应，请检查 OpenList 云盘驱动及反向代理超时设置。（${error}）`;
  }
  if (/令牌未配置/i.test(error)) return 'OpenList 令牌未配置，请在设置中保存令牌后重新上传。';
  if (/配置或文件缺失/i.test(error)) return 'OpenList 配置或本地录像文件已不存在，无法继续该上传任务。';
  return error;
}
