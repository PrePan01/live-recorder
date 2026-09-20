import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { checkFileIntegrity } from './integrity.js';
import { discardTemp, finalizeMp4, runFfmpegTracked, type FfmpegRunOptions } from './ffmpeg-run.js';

/** 转封装临时产物后缀：与最终 .mp4 同目录，保证改名是同一文件系统内的原子操作。 */
const TEMP_SUFFIX = '.part';
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const REMUX_BASE_STALL_MS = 2 * 60_000;
const REMUX_STALL_PER_GIB_MS = 60_000;
const REMUX_MAX_STALL_MS = 10 * 60_000;

export type RemuxOptions = FfmpegRunOptions;

/**
 * 大文件向 U 盘/NAS 写入时，缓存回写可能让 ffmpeg 数分钟没有 progress 输出。
 * 仅转封装按输入大小放宽：2 分钟基础值 + 每 GiB 1 分钟，最高 10 分钟。
 * 这不是总转换时长限制，而是“连续没有任何进度”的容忍时间。
 */
export function remuxStallMsForSize(sizeBytes: number): number {
  const gibibytes = Math.max(0, Math.ceil(sizeBytes / GIB));
  return Math.min(REMUX_MAX_STALL_MS, REMUX_BASE_STALL_MS + gibibytes * REMUX_STALL_PER_GIB_MS);
}

/**
 * 录制完成后用 ffmpeg 将 FLV 转封装为 MP4（不重编码）。
 * 产物先写临时文件，ffprobe 校验通过才改名为 .mp4，再删除源 FLV；
 * 任何失败/中断都删除半成品并保留源 FLV。失败返回 null（不阻断，由调用方重试/告警）。
 */
export async function remuxFlvToMp4(flvPath: string, options: RemuxOptions = {}): Promise<string | null> {
  const mp4Path = mp4PathFor(flvPath);
  if (!mp4Path) return null;
  const tempPath = `${mp4Path}${TEMP_SUFFIX}`;
  await discardTemp(tempPath);
  const sourceSizeBytes = (await stat(flvPath).catch(() => null))?.size ?? 0;

  // 不加 -movflags +faststart：大文件上 ffmpeg 要重写整个文件把 moov 挪到头部，这一段没有任何进度输出，
  // 既让转换耗时翻倍，也无法与「卡死」区分。moov 在尾部不影响播放（应用按 HTTP Range 提供录制文件）。
  // -f mp4：临时文件后缀无法让 ffmpeg 推断封装格式，必须显式指定。
  const res = await runFfmpegTracked(
    ['-y', '-i', flvPath, '-c', 'copy', '-f', 'mp4', tempPath],
    { ...options, stallMs: options.stallMs ?? remuxStallMsForSize(sourceSizeBytes) },
  );
  if (!res.ok) {
    await discardTemp(tempPath);
    await removeInvalidMp4(mp4Path);
    return null;
  }
  if (!(await finalizeMp4(tempPath, mp4Path))) {
    await removeInvalidMp4(mp4Path);
    return null;
  }
  // 有效 MP4 已就位后才删除源 FLV；删除失败也不回滚（宁可两份，不丢源）。
  await unlink(flvPath).catch(() => undefined);
  return mp4Path;
}

/** 删除转换坏掉的 .mp4（仅 ffprobe 明确判定不可播时；有效产物与无法校验的情况都不动）。 */
async function removeInvalidMp4(mp4Path: string): Promise<void> {
  if (!(await stat(mp4Path).catch(() => null))) return;
  if ((await checkFileIntegrity(mp4Path)) === 'failed') {
    await unlink(mp4Path).catch(() => undefined);
  }
}

/** 从 flv 路径推导 mp4 目标路径（与 remuxFlvToMp4 一致）。 */
export function mp4PathFor(flvPath: string): string | null {
  const ext = path.extname(flvPath).toLowerCase();
  return ext === '.flv' ? flvPath.replace(/\.flv$/i, '.mp4') : null;
}
