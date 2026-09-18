import { stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { checkFileIntegrity } from './integrity.js';
import { discardTemp, finalizeMp4, runFfmpegTracked, type FfmpegRunOptions } from './ffmpeg-run.js';

/** 转封装临时产物后缀：与最终 .mp4 同目录，保证改名是同一文件系统内的原子操作。 */
const TEMP_SUFFIX = '.part';

export type RemuxOptions = FfmpegRunOptions;

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

  // 不加 -movflags +faststart：大文件上 ffmpeg 要重写整个文件把 moov 挪到头部，这一段没有任何进度输出，
  // 既让转换耗时翻倍，也无法与「卡死」区分。moov 在尾部不影响播放（应用按 HTTP Range 提供录制文件）。
  // -f mp4：临时文件后缀无法让 ffmpeg 推断封装格式，必须显式指定。
  const res = await runFfmpegTracked(['-y', '-i', flvPath, '-c', 'copy', '-f', 'mp4', tempPath], options);
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
