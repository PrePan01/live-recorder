import { spawnSync } from 'node:child_process';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Only detach the caller's own mount. An EBUSY after executing a mounted binary
// can be transient; retry normally before forcing that same mount to detach.
export async function detachDmg(mountPoint, { execute = spawnSync, pause = wait, warn = console.warn } = {}) {
  const detach = force => execute('hdiutil', ['detach', mountPoint, ...(force ? ['-force'] : [])], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  const failure = result => new Error(`Cannot detach DMG ${mountPoint}: ${result.error?.message || result.stderr || result.stdout || result.signal || `exit ${result.status}`}`);
  for (const [attempt, delay] of [0, 500, 1000].entries()) {
    if (delay) await pause(delay);
    const result = detach(false);
    if (!result.error && result.status === 0) return;
    if (result.error || (result.status !== 16 && !/resource busy/i.test(`${result.stderr ?? ''} ${result.stdout ?? ''}`)))
      throw failure(result);
    warn(`DMG mount busy (${attempt + 1}/3): ${mountPoint}`);
  }
  warn(`Force-detaching busy test DMG: ${mountPoint}`);
  const result = detach(true);
  if (result.error || result.status !== 0) throw failure(result);
}
