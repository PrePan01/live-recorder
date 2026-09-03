import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * ffmpeg/ffprobe 解析：桌面 GUI 双击启动时 PATH 精简（/usr/bin:/bin），
 * homebrew 等安装路径不在 PATH 中导致 mp4_after 转封装/管线 ffmpeg 步骤静默失败。
 * 解析顺序：PATH → 打包内置 Resources/ffmpeg → 常见安装路径。
 */
const COMMON_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

function inPath(cmd: string): string | null {
  for (const d of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!d) continue;
    const p = path.join(d, cmd);
    if (existsSync(p)) return p;
  }
  return null;
}

function bundledBinDir(): string | null {
  // 桌面打包：后端由 Resources/node 运行，execPath 的目录即 Resources；ffmpeg 随包放 Resources/ffmpeg。
  try {
    const res = path.dirname(process.execPath);
    if (existsSync(path.join(res, 'ffmpeg'))) return path.join(res, 'ffmpeg');
  } catch {
    /* 忽略 */
  }
  return null;
}

export function resolveBin(name: 'ffmpeg' | 'ffprobe'): string {
  const hit = inPath(name);
  if (hit) return hit;
  const bundled = bundledBinDir();
  if (bundled) {
    const p = path.join(bundled, name);
    if (existsSync(p)) return p;
  }
  for (const d of COMMON_DIRS) {
    const p = path.join(d, name);
    if (existsSync(p)) return p;
  }
  return name;
}