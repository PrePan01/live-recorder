import { describe, expect, it, vi } from 'vitest';
import { defaultMessageFor } from '../../src/types/error.js';
import { fileCreateError } from '../../src/core/recording-failure.js';
import { recordingFilePath } from '../../src/storage/file-organizer.js';
import { RealWebDavClient } from '../../src/core/upload-manager.js';

describe('批三 P3 包', () => {
  it('建文件失败按 errno 归因：超长/权限/磁盘满各说各话，不再一律「保存目录无效」', () => {
    const e = (code: string) => Object.assign(new Error(code), { code });
    expect(fileCreateError(e('ENAMETOOLONG'), 'r1').message).toContain('过长');
    expect(fileCreateError(e('EACCES'), 'r1').message).toContain('权限');
    expect(fileCreateError(e('EPERM'), 'r1').message).toContain('权限');
    expect(fileCreateError(e('ENOSPC'), 'r1').message).toContain('磁盘空间不足');
    expect(fileCreateError(e('ENOSPC'), 'r1').code).toBe('DISK_SPACE_INSUFFICIENT');
    expect(fileCreateError(new Error('x'), 'r1').message).toBe('保存目录无效，录制失败');
  });

  it('13 个错误码有中文默认文案兜底（#20 后端面）', () => {
    const codes = [
      'ROOM_CONTENT_UNAVAILABLE', 'RECORDING_NOT_AVAILABLE', 'RESOURCE_NOT_FOUND',
      'TAG_INVALID', 'SEARCH_QUERY_INVALID', 'SEARCH_TIMEOUT', 'DIAGNOSTIC_ACTION_INVALID',
      'DIAGNOSTIC_CONFLICT', 'PIPELINE_CONFIG_INVALID', 'CHECK_FAILED', 'CONFIG_INVALID',
      'RECORDING_EMPTY', 'RECORDING_REMUX_FAILED',
    ] as const;
    for (const code of codes) {
      const message = defaultMessageFor(code);
      expect(message, code).toBeTruthy();
      // 人话口径：不出现英文技术词开头。
      expect(/^[一-龥]/.test(message!), `${code}: ${message}`).toBe(true);
    }
  });

  it('超长房间名被截断：路径单段字节数不超过 160（防 ENAMETOOLONG）', () => {
    const long = '超'.repeat(400); // 1200 字节
    const dir = recordingFilePath('/tmp/x', 'bilibili', long, '2026-09-25T00:00:00.000Z');
    const segments = dir.split('/');
    for (const seg of segments) {
      expect(Buffer.byteLength(seg, 'utf8')).toBeLessThanOrEqual(200);
    }
    expect(dir.includes(long)).toBe(false);
  });

  it('U-2 瞬时网络错误不缓存「无 API」，确定 4xx 才缓存降级', async () => {
    const client = new RealWebDavClient();
    const apiToken = (client as unknown as { apiToken: (r: string, u: string, p: string) => Promise<string | null> }).apiToken.bind(client);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      // 两次瞬时网络错：都应重新探测（不缓存），否则同键终身降级。
      fetchMock.mockRejectedValueOnce(new TypeError('network down'));
      expect(await apiToken('http://o.local', 'u', 'p')).toBeNull();
      fetchMock.mockRejectedValueOnce(new TypeError('network down'));
      expect(await apiToken('http://o.local', 'u', 'p')).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // 确定性 404：缓存 null，之后不再探测。
      fetchMock.mockResolvedValueOnce(new Response('<html>404</html>', { status: 404 }));
      expect(await apiToken('http://o.local', 'u', 'p')).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(await apiToken('http://o.local', 'u', 'p')).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
