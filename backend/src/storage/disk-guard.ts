import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export interface DiskGuard {
  inspect(directory: string): Promise<DiskSpace>;
}

/** 读取指定目录所在文件系统的真实剩余/总空间；目录不存在时向上找最近存在的祖先。 */
export function realDiskSpace(directory: string): DiskSpace {
  let p = directory;
  for (let i = 0; i < 64; i += 1) {
    try {
      const s = statfsSync(p);
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
  constructor(space?: DiskSpace) {
    this.override = space ?? null;
  }
  setSpace(space: DiskSpace): void {
    this.override = space;
  }
  inspect(directory: string): Promise<DiskSpace> {
    return Promise.resolve(this.override ?? realDiskSpace(directory));
  }
}