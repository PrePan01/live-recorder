import { describe, expect, it } from 'vitest';
import { buildServices } from '../../src/core/services.js';
import type { AppSettings } from '../../src/types/index.js';

describe('历史 MP4 设置迁移到格式转换步骤', () => {
  it('旧 mp4_after 自动开启管线和格式转换，但不意外启用其他后处理', () => {
    const services = buildServices({ dbPath: ':memory:' });
    services.settings.save({
      recordingDirectory: '/tmp', maxConcurrentRecordings: 2, quality: 'original', recordingFormat: 'mp4_after', autoRecord: false,
      checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 }, retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
      diskGuard: { minFreeBytes: 1, minFreePercent: 1 }, mail: { enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipients: [] }, dedupeWindowMinutes: 30,
    } as AppSettings);

    const migrated = services.settings.load()!;
    expect(migrated.pipeline).toMatchObject({ enabled: true, outputFormat: 'mp4', verify: false, exportCover: false, exportAudio: false, segmentSeconds: 0, crf: null, archiveDirectory: '' });
  });
});
