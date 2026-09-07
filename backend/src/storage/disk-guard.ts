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
  private pending = new Map<string, Promise<DiskSpace>>();
  constructor(space?: DiskSpace) {
    this.override = space ?? null;
  }
  setSpace(space: DiskSpace): void {
    this.override = space;
  }
  inspect(directory: string): Promise<DiskSpace> {
    if (this.override) return Promise.resolve(this.override);
    const existing = this.pending.get(directory);
    if (existing) return existing;
    let timer: ReturnType<typeof setTimeout>;
    const operation = Promise.race([
      realDiskSpace(directory),
      new Promise<DiskSpace>((resolve) => { timer = setTimeout(() => resolve({ freeBytes: 0, totalBytes: 0 }), 2000); }),
    ]).finally(() => { clearTimeout(timer); this.pending.delete(directory); });
    this.pending.set(directory, operation);
    return operation;
  }
}