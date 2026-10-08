import { stat } from "node:fs/promises";
import { runFfmpeg } from "./pipeline-ffmpeg.js";
import { encodingWorkQueue } from "./media-work-queue.js";
import { resolveBin } from "../utils/ffmpeg.js";

export type HwEncoder = "h264_videotoolbox" | "h264_nvenc" | "h264_qsv" | "h264_amf";
export type ActualEncoder = HwEncoder | "libx264" | "copy";
export type FallbackReason =
  | "探测失败"
  | "启动失败"
  | "中途失败"
  | "无进度"
  | "产物校验失败";

const PLATFORM_ORDER: Record<string, HwEncoder[]> = {
  darwin: ["h264_videotoolbox"],
  win32: ["h264_nvenc", "h264_qsv", "h264_amf"],
};

/** 探测缓存：按 FFmpeg 程序身份（路径+大小+mtime）缓存，换程序自动重探。 */
interface ProbeCacheEntry {
  fingerprint: string;
  encoder: HwEncoder | null;
}
let probeCache: ProbeCacheEntry | null = null;
const probes = new Map<string, Promise<HwEncoder | null>>();
let probeQueue: Promise<unknown> = Promise.resolve();

async function ffmpegFingerprint(ffmpegBin: string): Promise<string> {
  const info = await stat(ffmpegBin).catch(() => null);
  return info ? `${ffmpegBin}:${info.size}:${info.mtimeMs}` : ffmpegBin;
}

/**
 * 硬件编码器探测：平台固定序取首个可用。短样本实编为准（列得出≠编得了），
 * 带总等待上限；失败缓存「无硬编」避免每次重探。
 */
export async function detectHwEncoder(ffmpegBin: string): Promise<HwEncoder | null> {
  const candidates = PLATFORM_ORDER[process.platform] ?? [];
  if (candidates.length === 0) return null;
  const fingerprint = await ffmpegFingerprint(ffmpegBin);
  if (probeCache?.fingerprint === fingerprint) return probeCache.encoder;

  const pending = probes.get(fingerprint);
  if (pending) return pending;
  const job = probeQueue.then(async () => {
    let found: HwEncoder | null = null;
    for (const encoder of candidates) {
      if (await encodingWorkQueue.run(() => probeEncoder(ffmpegBin, encoder))) { found = encoder; break; }
    }
    probeCache = { fingerprint, encoder: found };
    return found;
  });
  probes.set(fingerprint, job);
  probeQueue = job.catch(() => undefined);
  try { return await job; } finally { probes.delete(fingerprint); }
}

function ffmpegBin(): string {
  return resolveBin("ffmpeg");
}

/** 短样本实编探测（0.3 秒测试源→空输出）：编得出才算数。 */
async function probeEncoder(_ffmpegBin: string, encoder: HwEncoder): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  timer.unref?.();
  try {
    const res = await runFfmpeg([
      "-y",
      "-v", "error",
      "-f", "lavfi",
      "-i", "testsrc=duration=0.3:size=640x360:rate=30",
      "-frames:v", "5",
      "-c:v", encoder,
      "-pix_fmt", "yuv420p",
      "-f", "null",
      "-",
    ], { stallMs: 8000, signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 编码器展示名（任务显示面用）。 */
export function describeEncoder(encoder: ActualEncoder): string {
  const names: Record<string, string> = {
    h264_videotoolbox: "硬件(VideoToolbox)",
    h264_nvenc: "硬件(NVENC)",
    h264_qsv: "硬件(QSV)",
    h264_amf: "硬件(AMF)",
    libx264: "软件",
    copy: "无损复制",
  };
  return names[encoder] ?? encoder;
}

/**
 * 编码参数映射：同一质量意图（crf 23 基准）落到各编码器的近似质量旋钮。
 * 坑点：不同编码器的质量参数语义不同（crf/q/cq/global_quality/qp），
 * 同数值不等价画质——这里按「基准 crf」做近似换算，不承诺固定文件大小。
 */
export function encoderQualityArgs(encoder: ActualEncoder, crf: number): string[] {
  switch (encoder) {
    case "h264_videotoolbox":
      // q:v 0-100，越大越好；crf 23 基准 ≈ 65。
      return ["-q:v", String(Math.round(100 - crf * 1.5))];
    case "h264_nvenc":
      return ["-cq", String(crf)];
    case "h264_qsv":
      return ["-global_quality", String(crf)];
    case "h264_amf":
      return ["-qp_i", String(crf)];
    case "libx264":
    case "copy":
      return ["-crf", String(crf)];
  }
}

/** 软编固定参数（回退路径用，行为与历史一致）。 */
export function softwareEncodeArgs(crf: number, preset = "medium"): string[] {
  return ["-c:v", "libx264", "-crf", String(crf), "-preset", preset];
}


export interface EncodeOutcome {
  actualEncoder: ActualEncoder;
  fallbackReason: FallbackReason | null;
}

/**
 * 编码回退链（硬底线=绝不阻断导出）：
 * 自动模式=硬编优先，失败类（启动/中途/无进度/产物校验）清临时产物后原输入软编重试一次；
 * 探测无硬编=直软编；软件模式=单跑软编，再败即终态（调用方保留输入）。
 * 取消不触发回退（由调用方以 aborted 区分）。
 */
export async function encodeWithFallback(opts: {
  mode: "auto" | "software";
  crf: number;
  preset?: string;
  signal?: AbortSignal;
  onWaiting?: () => void;
  onEncoder?: (outcome: EncodeOutcome) => void;
  /** 单次尝试：返回失败类或 null=成功。 */
  attempt: (encoder: ActualEncoder, qualityArgs: string[]) => Promise<FallbackReason | null>;
  /** 取消判定：取消不触发回退（设计边界）。 */
  isCancelled?: () => boolean;
}): Promise<EncodeOutcome> {
  const { mode, crf, isCancelled } = opts;
  const attempt = (encoder: ActualEncoder, quality: string[], fallbackReason: FallbackReason | null = null) => {
    if (isCancelled?.()) throw new Error("Media job cancelled");
    opts.onEncoder?.({ actualEncoder: encoder, fallbackReason });
    return opts.attempt(encoder, quality);
  };
  if (mode === "software") {
    await attempt("libx264", softwareEncodeArgs(crf, opts.preset));
    return { actualEncoder: "libx264", fallbackReason: null };
  }
  if (isCancelled?.()) throw new Error("Media job cancelled");
  const pending = detectHwEncoder(ffmpegBin()).catch(() => null);
  const hw = await new Promise<HwEncoder | null>((resolve, reject) => {
    const heartbeat = opts.onWaiting ? setInterval(opts.onWaiting, 1000) : undefined;
    heartbeat?.unref();
    const cleanup = () => { if (heartbeat) clearInterval(heartbeat); opts.signal?.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(new Error("Media job cancelled")); };
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
  if (!hw) {
    // 无硬编（平台无候选=合法软编；候选但探测全败=标「探测失败」）。
    const hasCandidates = (PLATFORM_ORDER[process.platform] ?? []).length > 0;
    await attempt("libx264", softwareEncodeArgs(crf, opts.preset), hasCandidates ? "探测失败" : null);
    return {
      actualEncoder: "libx264",
      fallbackReason: hasCandidates ? "探测失败" : null,
    };
  }
  const quality = encoderQualityArgs(hw, crf);
  const reason = await attempt(hw, quality);
  if (reason === null) return { actualEncoder: hw, fallbackReason: null };
  if (isCancelled?.()) return { actualEncoder: hw, fallbackReason: null };
  // 硬编失败=从原输入软编重试一次（调用方已清临时产物）。
  await attempt("libx264", softwareEncodeArgs(crf, opts.preset), reason);
  return { actualEncoder: "libx264", fallbackReason: reason };
}
