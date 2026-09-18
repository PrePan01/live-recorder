import { mkdir, stat, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { discardTemp, finalizeMp4, runFfmpegTracked } from './ffmpeg-run.js';

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
