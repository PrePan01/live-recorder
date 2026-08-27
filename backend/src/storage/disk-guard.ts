export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

export interface DiskGuard {
  inspect(directory: string): Promise<DiskSpace>;
}

export class FakeDiskGuard implements DiskGuard {
  constructor(private space: DiskSpace = { freeBytes: 100 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 }) {}
  setSpace(space: DiskSpace): void {
    this.space = space;
  }
  inspect(_directory: string): Promise<DiskSpace> {
    return Promise.resolve(this.space);
  }
}
