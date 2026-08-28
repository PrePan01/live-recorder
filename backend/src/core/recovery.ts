import { stat } from 'node:fs/promises';
import type { Services } from './services.js';

/**
 * 启动恢复（#82）：服务重启后，将上次运行遗留的 recording/pending/reconnecting 会话收口——
 * 文件存在且可读 → completed；否则 → failed。释放并发槽、避免 activeRecordings 虚高。
 */
export async function recoverStaleRecordings(services: Services): Promise<number> {
  const stale = services.recordings.list({ pageSize: 100 }).items.filter((r) => r.state === 'recording' || r.state === 'pending' || r.state === 'reconnecting');
  const now = services.clock.iso();
  let recovered = 0;
  for (const rec of stale) {
    const fileOk = rec.filePath ? (await stat(rec.filePath).then((s) => s.size > 0).catch(() => false)) : false;
    if (fileOk) {
      services.recordings.update(rec.id, { state: 'completed', endedAt: now, fileSizeBytes: rec.fileSizeBytes || 0 });
    } else {
      services.recordings.update(rec.id, {
        state: 'failed',
        endedAt: now,
        failureReason: { code: 'RECORDING_START_FAILED', message: '服务重启中断，录制未完成', roomId: rec.roomId, recordingId: rec.id, occurredAt: now, retryable: true },
      });
    }
    recovered += 1;
  }
  return recovered;
}