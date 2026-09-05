import { describe, expect, it } from 'vitest';
import { classifyUploadError, describeUploadError, type UploadErrorCode } from './uploadError';

describe('classifyUploadError', () => {
  const cases: Array<{ input: string; code: UploadErrorCode }> = [
    { input: 'OpenList 需要 2FA 验证', code: 'OPENLIST_2FA_REQUIRED' },
    { input: 'OpenList 后台上传失败：资源配额不足', code: 'OPENLIST_QUOTA_EXCEEDED' },
    { input: 'OpenList 后台上传失败：存储空间不足', code: 'OPENLIST_QUOTA_EXCEEDED' },
    { input: 'OpenList 后台上传失败：资源不存在(00010010)', code: 'OPENLIST_RESOURCE_NOT_FOUND' },
    { input: 'OpenList 后台上传失败：文件不存在', code: 'OPENLIST_RESOURCE_NOT_FOUND' },
    { input: 'OpenList 后台上传失败：任务不存在', code: 'OPENLIST_TASK_NOT_FOUND' },
    { input: 'OpenList 后台上传已取消：用户取消', code: 'OPENLIST_TASK_FAILED' },
    { input: 'OpenList 认证失败：Invalid token', code: 'OPENLIST_AUTH_FAILED' },
    { input: 'WebDAV PUT 405: Method Not Allowed', code: 'WEBDAV_405' },
    { input: 'WebDAV PUT 504: Gateway Timeout', code: 'WEBDAV_504' },
    { input: '源文件已删除，无法上传', code: 'SOURCE_DELETED' },
    { input: 'OpenList 令牌未配置', code: 'TOKEN_MISSING' },
    { input: '配置或文件缺失', code: 'CONFIG_OR_FILE_MISSING' },
    { input: 'fetch failed: ENOTFOUND openlist.bspartner.top', code: 'NETWORK' },
    { input: 'OpenList 上传进度长时间无变化，请检查云端存储是否正常', code: 'STALLED' },
    { input: 'duplex option is required', code: 'LEGACY' },
  ];

  it.each(cases)('classify(%j) → $code', ({ input, code }) => {
    expect(classifyUploadError(input).code).toBe(code);
  });

  it('每类错误都给出一句话可执行建议', () => {
    for (const { input } of cases) {
      const info = classifyUploadError(input);
      expect(info.action.length).toBeGreaterThan(0);
    }
  });

  it('null/undefined → UNKNOWN', () => {
    expect(classifyUploadError(null).code).toBe('UNKNOWN');
    expect(classifyUploadError(undefined).code).toBe('UNKNOWN');
  });

  it('未匹配错误 → UNKNOWN 且透传原文', () => {
    const raw = 'OpenList 返回未知错误码 XYZ';
    const info = classifyUploadError(raw);
    expect(info.code).toBe('UNKNOWN');
    expect(info.action).toBe(raw);
  });

  it('具体错误优先于通用 TASK_FAILED（资源不存在不被后台上传失败吞掉）', () => {
    expect(classifyUploadError('OpenList 后台上传失败：资源不存在(00010010)').code).toBe('OPENLIST_RESOURCE_NOT_FOUND');
    expect(classifyUploadError('OpenList 后台上传失败：资源配额不足').code).toBe('OPENLIST_QUOTA_EXCEEDED');
  });
});

describe('describeUploadError', () => {
  it('null/undefined → null', () => {
    expect(describeUploadError(null)).toBeNull();
    expect(describeUploadError(undefined)).toBeNull();
  });

  it('映射错误 → 返回可执行建议', () => {
    expect(describeUploadError('OpenList 后台上传失败：资源不存在(00010010)')).toContain('核对');
  });

  it('未映射错误 → 透传原文', () => {
    const raw = '某些未知错误文本';
    expect(describeUploadError(raw)).toBe(raw);
  });
});