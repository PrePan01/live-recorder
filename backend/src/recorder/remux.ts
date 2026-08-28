import { spawn } from 'node:child_process';
import { rename } from 'node:fs/promises';
import path from 'node:path';

const REMUX_TIMEOUT_MS = 120_000;

/**
 * 录制完成后用 ffmpeg 将 FLV 转封装为 MP4（不重编码，快速 remux）。
 * 返回新文件路径；ffmpeg 缺失/超时/失败返回 null（保留原 FLV，不阻断）。
 */
export async function remuxFlvToMp4(flvPath: string): Promise<string | null> {
  const mp4Path = flvPath.replace(/\.flv$/i, '.mp4');
  if (mp4Path === flvPath) return null;
  try {
    const ok = await runFfmpeg(['-y', '-i', flvPath, '-c', 'copy', '-movflags', '+faststart', mp4Path]);
    if (!ok) return null;
    // 转封装成功：删除源 FLV，返回 MP4 路径。
    await rename(flvPath, mp4Path).catch(() => undefined);
    return mp4Path;
  } catch {
    return null;
  }
}

function runFfmpeg(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', args);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, REMUX_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** 从 flv 路径推导 mp4 目标路径（与 remuxFlvToMp4 一致）。 */
export function mp4PathFor(flvPath: string): string | null {
  const ext = path.extname(flvPath).toLowerCase();
  return ext === '.flv' ? flvPath.replace(/\.flv$/i, '.mp4') : null;
}