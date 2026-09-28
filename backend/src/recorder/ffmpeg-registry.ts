import type { ChildProcess } from 'node:child_process';

/**
 * 后端拉起的 ffmpeg 子进程注册表（评估稿 Q12 收割面）。
 *
 * 这些进程的父进程不是 Tauri：后端一退（重启/退出/崩溃），POSIX 上它们不会被带走，
 * macOS 实测会留孤儿继续跑。进程组手段对「后端被外部收养」的场景不可靠，
 * 因此这里显式登记每个生成点：优雅收束时收割（SIGTERM → 宽限 → SIGKILL），
 * 再用同步 exit 兜底崩溃路径。
 */
const live = new Set<ChildProcess>();
let exitHookInstalled = false;

/** 登记一个子进程，返回解绑函数（应在该进程 close/error 时调用）。 */
export function trackFfmpeg(child: ChildProcess): () => void {
  live.add(child);
  return () => {
    live.delete(child);
  };
}

/** 当前登记数（测试/诊断用）。 */
export function trackedFfmpegCount(): number {
  return live.size;
}

/**
 * 收割登记中的子进程：先 SIGTERM，宽限期内未退出的补 SIGKILL。
 * 返回本次处理的数量；best-effort——单个进程 kill 失败不影响其余。
 */
export async function reapTrackedFfmpegs(graceMs = 3_000): Promise<number> {
  const children = [...live];
  if (children.length === 0) return 0;
  for (const child of children) {
    live.delete(child);
    try {
      child.kill('SIGTERM');
    } catch {
      // 已退出或无权限：忽略。
    }
  }
  const deadline = Date.now() + graceMs;
  const alive = (): ChildProcess[] =>
    children.filter((c) => c.exitCode === null && c.signalCode === null);
  while (Date.now() < deadline && alive().length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const child of alive()) {
    try {
      child.kill('SIGKILL');
    } catch {
      // 忽略。
    }
  }
  return children.length;
}

/**
 * 进程 exit 前的同步兜底（无法 await 的路径：未捕获异常退出等）。
 * 只对已登记进程发 SIGKILL；幂等，可重复调用。
 */
export function installFfmpegExitReap(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of live) {
      try {
        child.kill('SIGKILL');
      } catch {
        // 忽略。
      }
    }
    live.clear();
  });
}
