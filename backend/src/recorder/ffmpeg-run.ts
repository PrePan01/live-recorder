import { spawn } from 'node:child_process';
import { rename, unlink } from 'node:fs/promises';
import { resolveBin } from '../utils/ffmpeg.js';
import { checkFileIntegrity } from './integrity.js';

/**
 * 进度静默超过该时长才判定卡死：转封装正常时持续有进度输出，慢盘只是慢、不会静默。
 * 不用「总时长」上限——同一份 5GB 在不同磁盘上耗时差几十倍，任何固定值都会误杀大文件。
 */
import { trackFfmpeg } from './ffmpeg-registry.js';

export const DEFAULT_STALL_MS = 60_000;
/** 判定卡死后等待进程真正退出的上限（SIGKILL 可能卡在不可中断 I/O 上，迟到数十秒）。 */
export const DEFAULT_KILL_GRACE_MS = 30_000;

export interface FfmpegRunResult {
  ok: boolean;
  code: number | null;
  /** 是否因子进程长时间无进度被判定卡死并终止。 */
  stalled: boolean;
  stderr: string;
}

export interface FfmpegRunOptions {
  stallMs?: number;
  killGraceMs?: number;
}

const PROGRESS_LINE = /^(frame|fps|bitrate|total_size|out_time_us|out_time_ms|out_time|dup_frames|drop_frames|speed|progress|stream_\d+_\d+_q)=/;

/**
 * 运行 ffmpeg 并按「进度」而不是「总时长」判断异常：
 * 只要还在推进就不打断（大文件在慢盘上转封装可以跑很久），连续 stallMs 无任何进度才终止。
 * -progress 由本函数统一注入，调用方只传业务参数。
 */
export function runFfmpegTracked(args: string[], options: FfmpegRunOptions = {}): Promise<FfmpegRunResult> {
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  return new Promise((resolve) => {
    const child = spawn(resolveBin('ffmpeg'), ['-nostats', '-progress', 'pipe:1', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const untrack = trackFfmpeg(child);
    let stderr = '';
    let stalled = false;
    let settled = false;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ ok: code === 0 && !stalled, code, stalled, stderr });
    };

    const armStall = (): void => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        child.kill('SIGKILL');
        killTimer = setTimeout(() => settle(null), killGraceMs);
      }, stallMs);
    };

    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      if (lines.some((line) => PROGRESS_LINE.test(line.trim()))) armStall();
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', () => { untrack(); settle(null); });
    child.on('close', (code) => { untrack(); settle(code); });

    armStall();
  });
}

/** 删除未落地的临时产物（失败/中断路径）。 */
export async function discardTemp(tempPath: string): Promise<void> {
  await unlink(tempPath).catch(() => undefined);
}

/**
 * 校验并落地 MP4 产物：ffprobe 确认可解封装后原子改名，产物不完整（退出码为 0 也可能写出坏容器）则丢弃。
 * 只处理产物本身，不动源文件。返回是否产出有效 MP4。
 */
export async function finalizeMp4(tempPath: string, outPath: string): Promise<boolean> {
  if ((await checkFileIntegrity(tempPath)) === 'failed') {
    await discardTemp(tempPath);
    return false;
  }
  try {
    await rename(tempPath, outPath);
    return true;
  } catch {
    await discardTemp(tempPath);
    return false;
  }
}
