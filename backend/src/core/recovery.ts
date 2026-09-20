import { stat } from "node:fs/promises";
import type { Services } from "./services.js";

export async function recoverStaleRecordings(
  services: Services,
): Promise<number> {
  const stale = services.recordings.listActive();
  const now = services.clock.iso();
  let recovered = 0;
  for (const rec of stale) {
    services.recordings.update(rec.id, {
      state: "failed",
      endedAt: now,
      failureReason: {
        code: "RECORDING_START_FAILED",
        message: "上次服务中断，正在核对录像文件",
        roomId: rec.roomId,
        recordingId: rec.id,
        occurredAt: now,
        retryable: true,
      },
    });
  }
  for (const rec of stale) {
    if (!services.db.open) break;
    const st = rec.filePath ? await stat(rec.filePath).catch(() => null) : null;
    if (!services.db.open) break;
    if (st && st.size > 0) {
      services.recordings.update(rec.id, {
        state: "completed",
        endedAt: now,
        fileSizeBytes: st.size,
        endReason: "service_restart",
        failureReason: {
          code: "RECORDING_START_FAILED",
          message: "录制因服务重启中断，已保存的内容可能不完整",
          roomId: rec.roomId,
          recordingId: rec.id,
          occurredAt: now,
          retryable: false,
        },
      });
      services.manager.resumeRecoveredProcessing(rec.id);
    } else {
      services.recordings.update(rec.id, {
        state: "failed",
        endedAt: now,
        failureReason: {
          code: st ? "RECORDING_EMPTY" : "RECORDING_START_FAILED",
          message: st
            ? "录制文件为空（未获取到流数据）"
            : "服务重启中断，录制未完成",
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
