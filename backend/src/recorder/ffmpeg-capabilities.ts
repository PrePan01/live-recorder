import { spawn } from 'node:child_process';
import { resolveBin } from '../utils/ffmpeg.js';

const passthroughByBinary = new Map<string, Promise<string[]>>();

/** fps_mode 在旧版中不存在，vsync 已被新版移除；能力探测避免绑定某个 FFmpeg 版本。 */
export function videoPassthroughArgs(): Promise<string[]> {
  const binary = resolveBin('ffmpeg');
  const cached = passthroughByBinary.get(binary);
  if (cached) return cached;
  const result = new Promise<string[]>(resolve => {
    const child = spawn(binary, ['-hide_banner', '-h', 'full'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let carry = '';
    let fpsMode = false;
    let vsync = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fpsMode ? ['-fps_mode:v', 'passthrough'] : vsync ? ['-vsync', '0'] : []);
    };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 3_000);
    const collect = (chunk: Buffer) => {
      const text = carry + chunk.toString();
      fpsMode ||= /-fps_mode\b/.test(text);
      vsync ||= /-vsync\b/.test(text);
      carry = text.slice(-128);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', finish);
    child.on('close', finish);
  });
  passthroughByBinary.set(binary, result);
  return result;
}
