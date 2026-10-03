import { describe, expect, it } from 'vitest';
import { recordingSeekStreamUrl } from './recordings';

describe('recordingSeekStreamUrl', () => {
  it('必须返回绝对地址：打包态（自定义协议）下相对路径打不到后端', () => {
    const url = recordingSeekStreamUrl('rec_x', 5);
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain('/api/v1/recordings/rec_x/seek-stream');
    expect(url).toContain('second=5');
  });

  it('不双拼 /api/v1（基址已含）', () => {
    const url = recordingSeekStreamUrl('rec_x', 0);
    expect(url).not.toContain('/api/v1/api/v1');
  });
});
