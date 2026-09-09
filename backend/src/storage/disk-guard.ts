import { statfs } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export interface DiskGuard {
  inspect(directory: string): Promise<DiskSpace>;
}

/** 读取指定目录所在文件系统的真实剩余/总空间；目录不存在时向上找最近存在的祖先。 */
export async function realDiskSpace(directory: string): Promise<DiskSpace> {
  let p = directory;
  for (let i = 0; i < 64; i += 1) {
    try {
      const s = await statfs(p);
      return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch {
      const parent = dirname(p);
      if (parent === p) break;
      p = parent;
    }
  }
  return { freeBytes: 0, totalBytes: 0 };
}

/**
 * 磁盘守卫：默认返回目录所在文件系统的真实空间；测试可经 setSpace 注入固定值
 * （磁盘保护/低磁盘用例）。
 */
export class FakeDiskGuard implements DiskGuard {
  private override: DiskSpace | null;
  /** Physical filesystem calls, not callers waiting on their 2s budget. */
  private pending = new Map<string, Promise<DiskSpace>>();
  private waiters = new Map<string, Promise<DiskSpace>>();
  private cooldownUntil = new Map<string, number>();
  private active = 0;
  private queued: Array<() => void> = [];
  constructor(space?: DiskSpace) {
    this.override = space ?? null;
  }
  setSpace(space: DiskSpace): void {
    this.override = space;
  }
  inspect(directory: string): Promise<DiskSpace> {
    if (this.override) return Promise.resolve(this.override);
    if ((this.cooldownUntil.get(directory) ?? 0) > Date.now()) return Promise.resolve({ freeBytes: 0, totalBytes: 0 });
    const waiting = this.waiters.get(directory);
    if (waiting) return waiting;
    let operation = this.pending.get(directory);
    if (!operation) {
      operation = this.enqueue(directory);
      this.pending.set(directory, operation);
      void operation.finally(() => this.pending.delete(directory));
    }
    // A caller may time out, but the physical operation keeps its slot until it
    // completes. That prevents a slow/unmounted disk from being retried in a
    // tight loop and exceeding the actual two-operation cap.
    const bounded = this.waitAtMost(operation, 2_000);
    this.waiters.set(directory, bounded);
    void bounded.finally(() => {
      if (this.waiters.get(directory) === bounded) this.waiters.delete(directory);
    });
    return bounded;
  }

  private enqueue(directory: string): Promise<DiskSpace> {
    return new Promise<DiskSpace>((resolve) => {
      const run = () => {
        this.active += 1;
        void realDiskSpace(directory)
          .then((space) => {
            if (space.totalBytes === 0) this.cooldownUntil.set(directory, Date.now() + 30_000);
            resolve(space);
          })
          .catch(() => {
            this.cooldownUntil.set(directory, Date.now() + 30_000);
            resolve({ freeBytes: 0, totalBytes: 0 });
          })
          .finally(() => {
            this.active -= 1;
            this.queued.shift()?.();
          });
      };
      if (this.active < 2) run();
      else this.queued.push(run);
    });
  }

  private waitAtMost(operation: Promise<DiskSpace>, timeoutMs: number): Promise<DiskSpace> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      operation,
      new Promise<DiskSpace>((resolve) => { timer = setTimeout(() => resolve({ freeBytes: 0, totalBytes: 0 }), timeoutMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }
}
