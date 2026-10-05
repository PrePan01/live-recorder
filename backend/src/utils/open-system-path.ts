import { spawn } from 'node:child_process';

/** 复用目录/产物的系统打开方式，文件交给系统默认关联应用；路径始终作为独立参数。 */
export function openSystemPath(targetPath: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = spawn(command, [targetPath], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
