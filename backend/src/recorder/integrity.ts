import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolveBin } from "../utils/ffmpeg.js";
import type { RecordingIntegrity } from "../types/index.js";

const FFPROBE_TIMEOUT_MS = 15_000;

/** ffprobe checks demuxing and positive duration, not a full frame-by-frame decode. */
export interface IntegrityCheckDetail {
  outcome: "ok" | "failed" | "unverifiable";
  detail: string;
}

export async function checkFileIntegrityDetailed(
  filePath: string,
  timeoutMs = FFPROBE_TIMEOUT_MS,
): Promise<IntegrityCheckDetail> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: IntegrityCheckDetail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(
      resolveBin("ffprobe"),
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        filePath,
      ],
      { windowsHide: true },
    );
    const timer = setTimeout(() => {
      finish({ outcome: "unverifiable", detail: "校验超时" });
      child.kill("SIGKILL");
    }, timeoutMs);
    let out = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    // Bound diagnostics even for a file generating excessive probe errors.
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8192);
    });
    child.on("error", () =>
      finish({ outcome: "unverifiable", detail: "ffprobe 不可用" }),
    );
    child.on("close", async (code) => {
      if (settled) return;
      if (code !== 0) {
        if (
          code === null ||
          /no such file|permission denied|access is denied|input\/output error|device not (?:configured|ready)|resource temporarily unavailable|stale file handle/i.test(
            stderr,
          )
        ) {
          finish({
            outcome: "unverifiable",
            detail: "录像文件暂不可访问，请检查存储设备与读取权限后重试",
          });
          return;
        }
        // Only failed probes need this extra I/O; a detached disk is not corruption.
        try {
          await access(filePath, constants.R_OK);
        } catch {
          finish({
            outcome: "unverifiable",
            detail: "录像文件暂不可访问，请检查存储设备与读取权限后重试",
          });
          return;
        }
        finish({ outcome: "failed", detail: "文件损坏或截断" });
        return;
      }
      try {
        const parsed = JSON.parse(out) as { format?: { duration?: string } };
        const duration = Number(parsed.format?.duration ?? 0);
        finish(
          Number.isFinite(duration) && duration > 0
            ? { outcome: "ok", detail: "" }
            : { outcome: "failed", detail: "时长为 0" },
        );
      } catch {
        finish({ outcome: "failed", detail: "无法解析媒体信息" });
      }
    });
  });
}

/** Legacy callers share the same classification and timeout semantics. */
export async function checkFileIntegrity(
  filePath: string,
  timeoutMs = FFPROBE_TIMEOUT_MS,
): Promise<RecordingIntegrity> {
  const { outcome } = await checkFileIntegrityDetailed(filePath, timeoutMs);
  return outcome === "ok"
    ? "verified"
    : outcome === "failed"
      ? "failed"
      : "pending";
}
