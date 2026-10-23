import { MatroskaLiveParser } from "./matroska-live.js";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { resolveBin } from "../utils/ffmpeg.js";
import { trackFfmpeg } from "./ffmpeg-registry.js";
import { youtubeInput } from "./youtube-media.js";
import {
  detectPreviewHwEncoder,
  encoderQualityArgs,
  softwareEncodeArgs,
} from "./hw-encode.js";
import { AppError } from "../types/error.js";

const sessions = new Map<string, () => void>();
export function stopYoutubePlayback(id: string): void {
  sessions.get(id)?.();
}

/** Bounded, on-demand compatibility playback; never transcode the stored original. */
export async function openYoutubePlayback(
  id: string,
  file: string,
  second: number,
  mode: "auto" | "software",
  signal?: AbortSignal,
): Promise<PassThrough> {
  stopYoutubePlayback(id);
  if (sessions.size >= 4)
    throw new AppError(
      "CONCURRENT_LIMIT_REACHED",
      "回看会话已满，请关闭其他回看后重试",
    );
  const stream = new PassThrough({ highWaterMark: 512 * 1024 });
  stream.on("error", () => {});
  let child: ReturnType<typeof spawn> | undefined;
  let mediaInput: Awaited<ReturnType<typeof youtubeInput>> | undefined;
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    child?.kill("SIGKILL");
    stream.destroy();
    if (sessions.get(id) === stop) sessions.delete(id);
    signal?.removeEventListener("abort", stop);
    if (mediaInput) void mediaInput.dispose().catch(() => undefined);
  };
  sessions.set(id, stop);
  signal?.addEventListener("abort", stop, { once: true });
  stream.once("close", stop);
  try {
    const input = (mediaInput = await youtubeInput(file));
    let copy = false;
    if (second === 0 && file.endsWith(".mkv")) {
      const parser = new MatroskaLiveParser();
      parser.push(await input.readHeader());
      copy = parser.canCopyToFlv;
    }
    const hardware =
      !copy && mode === "auto"
        ? await detectPreviewHwEncoder()
        : null;
    if (signal?.aborted || cancelled)
      throw new AppError("RECORDING_NOT_AVAILABLE", "回看已取消");
    // Await the first bytes so a decoder startup error can still become an API error.
    await new Promise<void>((resolve, reject) => {
      let first = true;
      const start = (hw: typeof hardware) => {
        child = spawn(
          resolveBin("ffmpeg"),
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            "2",
            "-ss",
            String(second),
            ...input.args,
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            ...(copy
              ? ["-c", "copy"]
              : [
                  "-vf",
                  "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
                  ...(hw
                    ? ["-c:v", hw, ...encoderQualityArgs(hw, 23)]
                    : softwareEncodeArgs(23, "ultrafast")),
                  "-pix_fmt",
                  "yuv420p",
                  "-threads",
                  "2",
                  "-c:a",
                  "aac",
                  "-b:a",
                  "128k",
                ]),
            "-f",
            "flv",
            "pipe:1",
          ],
          { windowsHide: true, stdio: ["ignore", "pipe", "ignore", ...input.fileDescriptors] },
        );
        const process = child;
        const untrack = trackFfmpeg(process);
        const timer = setTimeout(() => {
          process.kill("SIGKILL");
        }, 15_000);
        process.stdout!.once("data", () => {
          first = false;
          clearTimeout(timer);
          resolve();
        });
        process.stdout!.pipe(stream, { end: false });
        process.once("error", () => {
          clearTimeout(timer);
          untrack();
          reject(new AppError("RECORDING_NOT_AVAILABLE", "无法启动兼容播放"));
        });
        process.once("close", (code) => {
          clearTimeout(timer);
          untrack();
          if (first && hw && !cancelled) {
            process.stdout!.unpipe(stream);
            start(null);
            return;
          }
          if (first)
            reject(
              new AppError(
                "RECORDING_NOT_AVAILABLE",
                "该位置暂无可播放内容，请稍后重试",
                { retryable: true },
              ),
            );
          else if (code !== 0 && !cancelled)
            stream.destroy(new Error("兼容播放中断"));
          else stream.end();
          void input.dispose().catch(() => undefined);
          signal?.removeEventListener("abort", stop);
          if (sessions.get(id) === stop) sessions.delete(id);
        });
      };
      start(hardware);
    });
    return stream;
  } catch (error) {
    stop();
    throw error;
  }
}
