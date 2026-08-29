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
    const st = rec.filePath ? await stat(rec.filePath).catch(() => null) : null;
    // #167 一致性：文件存在且非空 → completed（fileSizeBytes 取实际大小，修正 DB 记录 0 字节）；
    // 0 字节/无文件 → failed（RECORDING_EMPTY，与录制完成 0 字节判定一致）。
    if (st && st.size > 0) {
      services.recordings.update(rec.id, { state: 'completed', endedAt: now, fileSizeBytes: st.size });
    } else {
      services.recordings.update(rec.id, {
        state: 'failed',
        endedAt: now,
        failureReason: {
          code: st ? 'RECORDING_EMPTY' : 'RECORDING_START_FAILED',
          message: st ? '录制文件为空（未获取到流数据）' : '服务重启中断，录制未完成',
          roomId: rec.roomId,
          recordingId: rec.id,
          occurredAt: now,
          retryable: true,
        },
      });
    }
    recovered += 1;
  }
  return recovered;
}