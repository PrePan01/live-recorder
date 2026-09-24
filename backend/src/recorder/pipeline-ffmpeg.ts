import { mkdir, stat, copyFile, rm, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { discardTemp, finalizeMp4, runFfmpegTracked } from './ffmpeg-run.js';
import { checkFileIntegrity } from './integrity.js';
import { resolveBin } from '../utils/ffmpeg.js';

export function ffmpegThreadCount(logicalCores = availableParallelism()): number {
  return Math.max(1, Math.min(4, Math.floor(Math.max(1, logicalCores) / 2)));
}

interface FfmpegResult {
  ok: boolean;
  code: number | null;
  stderr: string;
}

/** 按进度判定卡死，慢盘上的大文件不会被固定超时打断。 */
export async function runFfmpeg(args: string[]): Promise<FfmpegResult> {
  const res = await runFfmpegTracked(args);
  return { ok: res.ok, code: res.code, stderr: res.stderr };
}

export interface CoverResult {
  coverPath: string;
  sizeBytes: number;
}

/** 提取封面帧（第 1 秒首帧），输出 jpg；失败返回 null（封面可选，不阻断管线）。 */
export async function extractCoverFrame(inputPath: string, outputDir: string, baseName: string): Promise<CoverResult | null> {
  const coverPath = path.join(outputDir, `${baseName}.jpg`);
  const res = await runFfmpeg(['-y', '-i', inputPath, '-frames:v', '1', '-q:v', '3', coverPath]);
  if (!res.ok) return null;
  const st = await stat(coverPath).catch(() => null);
  return st ? { coverPath, sizeBytes: st.size } : null;
}

export interface SegmentResult {
  segments: string[];
  pattern: string;
}

/** 按秒数切片（关键帧对齐，避免重编码）：输出 seg_000.ts 系列；失败返回 null。 */
export async function segmentFile(inputPath: string, outputDir: string, baseName: string, segmentSeconds: number): Promise<SegmentResult | null> {
  const pattern = path.join(outputDir, `${baseName}_seg_%03d.ts`);
  const res = await runFfmpeg(['-y', '-i', inputPath, '-c', 'copy', '-f', 'segment', '-segment_time', String(segmentSeconds), '-reset_timestamps', '1', pattern]);
  if (!res.ok) return null;
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(outputDir).catch(() => [] as string[]))
    .filter((f) => f.startsWith(`${baseName}_seg_`) && f.endsWith('.ts'))
    .sort();
  return { segments: files.map((f) => path.join(outputDir, f)), pattern };
}

export interface AudioExportResult {
  ok: boolean;
  /** ok=true 时为 mp3 路径与大小；失败时 reason：no_audio=预检无音轨，encode_failed=转码/校验失败 */
  outPath?: string;
  sizeBytes?: number;
  reason?: 'no_audio' | 'encode_failed';
}

/** ffprobe 预检首条音轨：true=有音轨，false=确认无音轨，null=ffprobe 缺失/超时/解析失败（不阻断，交给 ffmpeg 判定）。 */
function probeHasAudioStream(filePath: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const child = spawn(
      resolveBin('ffprobe'),
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_type', '-of', 'json', filePath],
      { windowsHide: true },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => done(null));
    child.on('close', (code) => {
      if (code !== 0) return done(null);
      try {
        const parsed = JSON.parse(out) as { streams?: unknown[] };
        done(Array.isArray(parsed.streams) && parsed.streams.length > 0);
      } catch {
        done(null);
      }
    });
    const timer = setTimeout(() => {
      child.kill();
      done(null);
    }, 10_000);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * 导出音频（mp3，CBR 192k，评估稿 c0e54a5f）：同目录同基名 `.mp3`，同名已存在则覆盖。
 * 安全链：ffprobe 预检音轨（无音轨明确失败不静默）→ 编码写 .part → ffprobe 校验可播 → 删旧产物 → 原子改名就位。
 * 任何路径不删源文件；失败不留临时残留。
 */
export async function exportAudioToMp3(inputPath: string): Promise<AudioExportResult> {
  const outPath = inputPath.replace(/\.[^.]+$/, '.mp3');
  if (outPath === inputPath) return { ok: false, reason: 'encode_failed' };
  if ((await probeHasAudioStream(inputPath)) === false) return { ok: false, reason: 'no_audio' };

  const tempPath = `${outPath}.part`;
  await discardTemp(tempPath);
  const res = await runFfmpeg(['-y', '-i', inputPath, '-vn', '-map', 'a:0', '-c:a', 'libmp3lame', '-b:a', '192k', '-f', 'mp3', tempPath]);
  if (!res.ok) {
    await discardTemp(tempPath);
    return { ok: false, reason: 'encode_failed' };
  }
  // 校验可播（退出码 0 也可能写出坏文件）才就位；先删旧产物支持覆盖（Windows rename 不覆盖既有文件）。
  if ((await checkFileIntegrity(tempPath)) === 'failed') {
    await discardTemp(tempPath);
    return { ok: false, reason: 'encode_failed' };
  }
  await rm(outPath, { force: true }).catch(() => undefined);
  try {
    await rename(tempPath, outPath);
  } catch {
    await discardTemp(tempPath);
    return { ok: false, reason: 'encode_failed' };
  }
  const st = await stat(outPath).catch(() => null);
  return st ? { ok: true, outPath, sizeBytes: st.size } : { ok: false, reason: 'encode_failed' };
}

export interface CompressResult {
  outPath: string;
  sizeBytes: number;
}

/** 压缩转封装：crf 为 null 时仅 remux（copy）；否则重编码 H.264。产物校验通过才落地，失败不留半成品。 */
export async function compressOrRemux(inputPath: string, crf: number | null): Promise<CompressResult | null> {
  // mp4 且无需压缩：已是目标格式，无需处理（调用方标 skipped，不影响管线 finalStatus）。
  if (/\.mp4$/i.test(inputPath) && crf === null) return null;
  const outPath = inputPath.replace(/\.(flv|ts|mp4)$/i, crf === null ? '_remux.mp4' : '_c.mp4');
  if (outPath === inputPath) return null;
  const tempPath = `${outPath}.part`;
  await discardTemp(tempPath);
  const args = crf === null
    ? ['-y', '-i', inputPath, '-c', 'copy', '-f', 'mp4', tempPath]
    : ['-y', '-i', inputPath, '-c:v', 'libx264', '-threads', String(ffmpegThreadCount()), '-crf', String(crf), '-preset', 'medium', '-c:a', 'aac', '-f', 'mp4', tempPath];
  const res = await runFfmpeg(args);
  if (!res.ok || !(await finalizeMp4(tempPath, outPath))) return null;
  const st = await stat(outPath).catch(() => null);
  return st ? { outPath, sizeBytes: st.size } : null;
}

/** 归档：复制到归档目录（保留相对子路径），失败不删除源文件。 */
export async function archiveTo(inputPath: string, archiveDirectory: string): Promise<string | null> {
  const dest = path.join(archiveDirectory, path.basename(inputPath));
  await mkdir(path.dirname(dest), { recursive: true });
  try {
    await copyFile(inputPath, dest);
    return dest;
  } catch {
    return null;
  }
}

/** 清理目录（仅内部产物，失败忽略）。 */
export async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
