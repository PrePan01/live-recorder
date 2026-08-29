import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { APP_VERSION } from './types.js';
import { nowIso } from '../utils/id.js';

export interface InstanceLockInfo {
  instanceId: string;
  pid: number;
  version: string;
  startedAt: string;
}

export interface AcquireResult {
  /** 是否取得单实例锁（true=本进程成为唯一实例）。 */
  acquired: boolean;
  /** 已存在但无法取得的实例（仅 acquired=false 时有意义）。 */
  existing: InstanceLockInfo | null;
}

export interface InstanceLockHandle {
  instanceId: string;
  readonly file: string;
  release(): Promise<void>;
  held(): Promise<boolean>;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code === 'EPERM';
  }
}

function isStale(info: InstanceLockInfo): boolean {
  // PID 不存活即为过期；存活则视为有效实例锁（由调用方决定复用/拒绝）。
  return !isPidAlive(info.pid);
}

/**
 * 单实例锁：以原子状态文件保存 instanceId/PID/版本/启动时间。
 * 启动前校验 PID 是否存活；过期状态自动清理后可重取。
 */
export class InstanceLock {
  readonly file: string;
  private info: InstanceLockInfo;

  private constructor(dir: string, instanceId: string) {
    this.file = join(dir, 'instance.lock');
    this.info = { instanceId, pid: process.pid, version: APP_VERSION, startedAt: nowIso() };
  }

  static async acquire(dir: string, instanceId: string): Promise<AcquireResult & { handle: InstanceLockHandle }> {
    const lock = new InstanceLock(dir, instanceId);
    const result = await lock.doAcquire();
    return { ...result, handle: lock };
  }

  private async doAcquire(): Promise<AcquireResult> {
    await mkdir(dirname(this.file), { recursive: true });
    const existing = await this.read();
    if (existing) {
      // 已存在但 PID 存活且 instanceId 一致：同进程重复 acquire（幂等，视为已持有）。
      if (!isStale(existing) && existing.instanceId === this.info.instanceId && existing.pid === process.pid) {
        this.info = existing;
        return { acquired: true, existing: null };
      }
      // 已存在且 PID 存活但属于其他实例：拒绝，不覆盖。
      if (!isStale(existing)) {
        return { acquired: false, existing };
      }
      // 过期状态：先清理再原子写入。
      await this.write();
      return { acquired: true, existing: null };
    }
    await this.write();
    return { acquired: true, existing: null };
  }

  /** 删除本实例持有的锁文件；非本实例持有则不动。 */
  async release(): Promise<void> {
    const existing = await this.read();
    if (existing && existing.instanceId === this.info.instanceId && existing.pid === this.info.pid) {
      await unlink(this.file).catch(() => undefined);
    }
  }

  /** 检查本实例是否仍持有锁（进程重启后旧锁自动视为过期）。 */
  async held(): Promise<boolean> {
    const existing = await this.read();
    return Boolean(existing && existing.instanceId === this.info.instanceId && existing.pid === this.info.pid);
  }

  get instanceId(): string {
    return this.info.instanceId;
  }

  private async read(): Promise<InstanceLockInfo | null> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as InstanceLockInfo;
      if (!parsed || typeof parsed.instanceId !== 'string' || typeof parsed.pid !== 'number') return null;
      return parsed;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return null;
      return null;
    }
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.info), 'utf8');
    await rename(tmp, this.file);
  }
}