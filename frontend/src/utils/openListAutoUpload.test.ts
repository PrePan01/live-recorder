import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../api/openlist', () => ({
  testOpenList: vi.fn(),
  updateOpenListConfig: vi.fn(),
}));

import { testOpenList, updateOpenListConfig } from '../api/openlist';
import { affectsConnection, saveAndVerifyAutoUpload } from './openListAutoUpload';
import { ApiError } from '../types/error';

function apiError(message: string): ApiError {
  return new ApiError({
    code: 'CONFIG_LOAD_FAILED',
    message,
    roomId: null,
    recordingId: null,
    occurredAt: new Date().toISOString(),
    retryable: false,
  });
}

const testMock = vi.mocked(testOpenList);
const updateMock = vi.mocked(updateOpenListConfig);

beforeEach(() => {
  vi.clearAllMocks();
  testMock.mockResolvedValue({ ok: true });
  updateMock.mockResolvedValue({
    enabled: false,
    serverUrl: '',
    directoryTemplate: '{room}/{date}',
    username: '',
    deleteSourceAfterUpload: false,
    hasToken: true,
  });
});

describe('affectsConnection', () => {
  it('treats address and credentials as connection-affecting edits', () => {
    expect(affectsConnection({ serverUrl: 'https://dav.example.com' })).toBe(true);
    expect(affectsConnection({ token: 'tok' })).toBe(true);
    // 用户名同样影响 WebDAV 认证，改它也要复检。
    expect(affectsConnection({ username: 'u' })).toBe(true);
  });

  it('ignores edits that cannot break the connection', () => {
    expect(affectsConnection({ directoryTemplate: '{room}' })).toBe(false);
    expect(affectsConnection({ deleteSourceAfterUpload: true })).toBe(false);
    expect(affectsConnection({ enabled: true })).toBe(false);
    expect(affectsConnection({})).toBe(false);
  });
});

describe('saveAndVerifyAutoUpload', () => {
  it('keeps auto upload on when the connection check passes', async () => {
    const save = vi.fn(async () => undefined);
    const result = await saveAndVerifyAutoUpload(save);

    expect(save).toHaveBeenCalledTimes(1);
    expect(testMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ enabled: true });
    // 检测通过时不得关闭开关。
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('turns auto upload back off with the server reason when the check fails', async () => {
    testMock.mockRejectedValue(apiError('OpenList 认证失败，请检查用户名与令牌'));
    const result = await saveAndVerifyAutoUpload(vi.fn(async () => undefined));

    expect(result.enabled).toBe(false);
    // 具体原因要透出，不能被通用文案覆盖，否则用户不知道要改什么。
    expect(result.error).toContain('OpenList 认证失败，请检查用户名与令牌');
    expect(updateMock).toHaveBeenCalledWith({ enabled: false });
  });

  it('leaves the switch off and reports the failure when saving itself fails', async () => {
    const result = await saveAndVerifyAutoUpload(async () => {
      throw apiError('服务内部错误');
    });

    expect(result).toEqual({ enabled: false, error: '服务内部错误' });
    // 没能保存就不该发起检测，也不该调用关闭接口。
    expect(testMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('still reports the switch as off when the follow-up disable request also fails', async () => {
    testMock.mockRejectedValue(apiError('OpenList 连接失败，请检查地址与令牌'));
    updateMock.mockRejectedValue(apiError('服务内部错误'));

    const result = await saveAndVerifyAutoUpload(vi.fn(async () => undefined));

    expect(result.enabled).toBe(false);
    expect(result.error).toContain('OpenList 连接失败，请检查地址与令牌');
  });
});
