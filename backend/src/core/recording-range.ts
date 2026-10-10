import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import type { Services } from "./services.js";
import type { Recording } from "../types/index.js";
import { AppError } from "../types/error.js";
import { resolveBin } from "../utils/ffmpeg.js";

// Completed files share an in-flight probe; the bounded cache is invalidated by
// file identity. Active recordings never spawn a probe or scan the growing file.
const durations = new Map<string, Promise<number>>();
export async function recordedSeconds(
  services: Services,
  recording: Recording,
): Promise<number> {
  const active = services.manager.recordingMediaTailSeconds(
    recording.roomId,
    recording.id,
  );
  if (active != null) return active;
  if ((recording.metadata?.durationMs ?? 0) > 0)
    return recording.metadata!.durationMs! / 1000;
  if (!recording.filePath)
    throw new AppError("RECORDING_NOT_AVAILABLE", "录像文件尚未就绪", {
      recordingId: recording.id,
    });
  const info = await stat(recording.filePath).catch(() => null);
  if (!info?.isFile())
    throw new AppError("RECORDING_NOT_AVAILABLE", "录像文件不可读", {
      recordingId: recording.id,
    });
  const key = `${recording.filePath}:${info.size}:${info.mtimeMs}`;
  let pending = durations.get(key);
  if (!pending) {
    pending = new Promise<number>((resolve, reject) => {
      execFile(
        resolveBin("ffprobe"),
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          recording.filePath!,
        ],
        { timeout: 8_000, maxBuffer: 64 * 1024, windowsHide: true },
        (error, stdout) => {
          try {
            const duration = Number(JSON.parse(stdout).format?.duration);
            if (error || !Number.isFinite(duration) || duration <= 0)
              throw error ?? new Error("Missing duration");
            resolve(duration);
          } catch {
            reject(
              new AppError(
                "RECORDING_NOT_AVAILABLE",
                "无法确定已录范围，请稍后重试",
                { recordingId: recording.id },
              ),
            );
          }
        },
      );
    });
    if (durations.size >= 64) durations.delete(durations.keys().next().value!);
    durations.set(key, pending);
    void pending.catch(() => durations.delete(key));
  }
  return pending;
}

export function assertSegmentRange(
  start: unknown,
  end: unknown,
  duration: number,
  recordingId: string,
): asserts start is number {
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end - start < 1 ||
    end > duration
  ) {
    throw new AppError(
      "CONFIG_INVALID",
      "片段至少需要 1 秒，且必须在已录范围内",
      { recordingId },
    );
  }
}
