import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { APP_VERSION } from './types.js';
import { nowIso } from '../utils/id.js';

export interface InstanceLockInfo {
  instanceId: string;
  pid: number;
  version: string;
  startedAt: string;
  leaseVersion?: number;
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
  private lease: Database.Database | null = null;
  private static owners = new Map<string, InstanceLock>();

  private constructor(dir: string, instanceId: string) {
    this.file = join(dir, 'instance.lock');
    this.info = {
      instanceId,
      pid: process.pid,
      version: APP_VERSION,
      startedAt: nowIso(),
      leaseVersion: 1,
    };
  }

  static async acquire(
    dir: string,
    instanceId: string,
  ): Promise<AcquireResult & { handle: InstanceLockHandle }> {
    dir = resolve(dir);
    const owned = InstanceLock.owners.get(join(dir, 'instance.lock'));
    if (owned?.info.instanceId === instanceId && (await owned.held())) {
      return { acquired: true, existing: null, handle: owned };
    }
    const lock = new InstanceLock(dir, instanceId);
    const result = await lock.doAcquire();
    return { ...result, handle: lock };
  }

  private async doAcquire(): Promise<AcquireResult> {
    await mkdir(dirname(this.file), { recursive: true });
    // SQLite 的 OS 文件锁在进程退出/崩溃时自动释放；JSON 仅用于身份发现。
    // 避免先读后 rename 让两个进程同时“取得”同一把锁。
    const lease = new Database(
      join(dirname(this.file), 'instance-lease.sqlite'),
      { timeout: 0 },
    );
    try {
      lease.exec('BEGIN IMMEDIATE');
    } catch (error) {
      lease.close();
      if ((error as { code?: string }).code === 'SQLITE_BUSY') {
        return { acquired: false, existing: await this.read() };
      }
      throw error;
    }
    this.lease = lease;
    try {
      const existing = await this.read();
      // 兼容旧版本（没有 SQLite 租约）的存活后端，不越过它启动第二实例。
      if (existing && existing.leaseVersion !== 1 && !isStale(existing)) {
        this.closeLease();
        return { acquired: false, existing };
      }
      await this.write();
      InstanceLock.owners.set(this.file, this);
      return { acquired: true, existing: null };
    } catch (error) {
      this.closeLease();
      throw error;
    }
  }

  private closeLease(): void {
    this.lease?.close();
    this.lease = null;
    if (InstanceLock.owners.get(this.file) === this)
      InstanceLock.owners.delete(this.file);
  }

  /** 删除本实例持有的锁文件；非本实例持有则不动。 */
  async release(): Promise<void> {
    try {
      const existing = await this.read();
      if (
        this.lease &&
        existing &&
        existing.instanceId === this.info.instanceId &&
        existing.pid === this.info.pid
      ) {
        await unlink(this.file).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    } finally {
      this.closeLease();
    }
  }

  /** 检查本实例是否仍持有锁（进程重启后旧锁自动视为过期）。 */
  async held(): Promise<boolean> {
    const existing = await this.read();
    return Boolean(
      this.lease &&
      existing &&
      existing.instanceId === this.info.instanceId &&
      existing.pid === this.info.pid,
    );
  }

  get instanceId(): string {
    return this.info.instanceId;
  }

  private async read(): Promise<InstanceLockInfo | null> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as InstanceLockInfo;
      if (
        !parsed ||
        typeof parsed.instanceId !== 'string' ||
        !Number.isInteger(parsed.pid) ||
        parsed.pid <= 1
      )
        return null;
      return parsed;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return null;
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.info), 'utf8');
    await rename(tmp, this.file);
  }
}
