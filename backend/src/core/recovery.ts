import { stat, unlink } from "node:fs/promises";
import path from "node:path";
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

/**
 * 启动恢复孤儿管线 run（task #59）：管线 run 执行中进程被杀（升级/崩溃/强退）后，
 * queued/running 状态永久卡死、recording 停在 processing、ffmpeg .part 半截残留、
 * retry 被守卫拦死——此前 recovery 对 pipeline_runs 零引用（先于 #57 的底座稳定性洞）。
 * 处置：孤儿 run → failed（「服务重启中断，可重试」）、其 queued/running artifacts → failed 同文案、
 * recording 复位（processing→有文件 completed / 无文件 failed，pipelineStatus=failed 放开 retry）、
 * 清理录制目录下孤儿 *.part（重启后无在途 ffmpeg，后缀白名单删除安全；下次 run 起始 discardTemp 兜底仍在）。
 */
/**
 * 启动收敛孤儿片段导出：导出进行中（processing）被重启打断的 clip 不会自己活过来——
 * 按「保存后跑到底」口径收敛为 failed（「导出因应用重启中断」），半成品一并清理。
 */
export async function recoverOrphanClipExports(services: Services): Promise<number> {
  const now = services.clock.iso();
  let recovered = 0;
  for (const clip of services.recordings.listClipExporting()) {
    if (!services.db.open) break;
    if (clip.filePath) await unlink(clip.filePath).catch(() => undefined);
    services.recordings.update(clip.id, {
      state: "failed",
      endedAt: now,
      failureReason: {
        code: "RECORDING_FILE_CORRUPTED",
        message: "导出因应用重启中断",
        roomId: clip.roomId,
        recordingId: clip.id,
        occurredAt: now,
        retryable: false,
      },
    });
    recovered += 1;
  }
  return recovered;
}

export async function recoverOrphanPipelineRuns(services: Services): Promise<number> {
  const orphans = services.pipeline.repo.listRunsByStatuses(["queued", "running"]);
  const now = services.clock.iso();
  const REASON = "服务重启中断，可重试";
  let recovered = 0;
  for (const run of orphans) {
    // 断点续跑：已有产物有效的步骤跳过、缺损步骤重跑；仅在文件不可用时退回标失败。
    const rec0 = services.recordings.get(run.recordingId);
    const st0 = rec0?.filePath ? await stat(rec0.filePath).catch(() => null) : null;
    if (rec0 && st0 && st0.size > 0) {
      // 续跑前同样清理孤儿 .part 半截产物（与标失败路径的清理口径一致）。
      const dir0 = path.dirname(rec0.filePath!);
      const fs0 = await import("node:fs/promises");
      const entries0 = await fs0.readdir(dir0).catch(() => [] as string[]);
      await Promise.all(
        entries0
          .filter((f) => f.endsWith(".part"))
          .map((f) => fs0.unlink(path.join(dir0, f)).catch(() => undefined)),
      );
      void services.pipeline.resumeRunById(run.id).catch(() => undefined);
      recovered += 1;
      continue;
    }
    services.pipeline.repo.setRunStatus(run.id, "failed", now);
    for (const art of run.artifacts) {
      if (art.status === "queued" || art.status === "running") {
        services.pipeline.repo.setArtifact(art.id, {
          status: "failed",
          error: REASON,
          endedAt: now,
        });
      }
    }

    const rec = services.recordings.get(run.recordingId);
    if (rec) {
      const st = rec.filePath ? await stat(rec.filePath).catch(() => null) : null;
      if (st && st.size > 0) {
        if (rec.state === "processing") {
          services.recordings.update(rec.id, { state: "completed", pipelineStatus: "failed" });
        } else if (rec.pipelineStatus === "running" || rec.pipelineStatus === "queued") {
          services.recordings.update(rec.id, { pipelineStatus: "failed" });
        }
      } else if (rec.state === "processing") {
        services.recordings.update(rec.id, {
          state: "failed",
          pipelineStatus: "failed",
          failureReason: {
            code: "RECORDING_START_FAILED",
            message: "服务重启中断，录制未完成",
            roomId: rec.roomId,
            recordingId: rec.id,
            occurredAt: now,
            retryable: true,
          },
        });
      }
      // 清理录制目录下孤儿 .part 半截产物（mp3/mp4 同命名空间，含先于 #57 的 compress .part）。
      if (rec.filePath) {
        const dir = path.dirname(rec.filePath);
        const { readdir, unlink } = await import("node:fs/promises");
        const entries = await readdir(dir).catch(() => [] as string[]);
        await Promise.all(
          entries
            .filter((f) => f.endsWith(".part"))
            .map((f) => unlink(path.join(dir, f)).catch(() => undefined)),
        );
      }
    }
    recovered += 1;
  }
  return recovered;
}
