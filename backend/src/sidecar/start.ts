import path from 'node:path';
import { buildApp } from '../api/server.js';
import { buildServices, defaultDataDir } from '../core/services.js';
import { recoverStaleRecordings } from '../core/recovery.js';
import { DEFAULT_HOST, APP_VERSION, API_VERSION } from './types.js';
import type { AppInstance } from './types.js';
import { InstanceLock } from './instance-lock.js';
import type { InstanceLockHandle } from './instance-lock.js';
import { DEFAULT_PORT, BACKUP_PORTS } from './ports.js';
import { writeReadyFile, removeReadyFile } from './ready-file.js';
import { nowIso, ulid } from '../utils/id.js';

export interface SidecarOptions {
  host?: string;
  preferredPort?: number;
  readyFile?: string;
  stateDir?: string;
  instanceId?: string;
  dbPath?: string;
  extraOrigins?: string[];
  mode?: 'fake' | 'real';
}

export interface SidecarResult {
  instance: AppInstance;
  readyFile: string;
  lock: InstanceLockHandle;
  close: () => Promise<void>;
}

/**
 * 桌面 sidecar 启动状态机（P0-0）：
 * acquire-lock → 端口选择（43120→备用→OS 空闲）→ 迁移/恢复 → listen → 原子 ready 文件 → ready。
 * 返回后可挂接 SIGINT/SIGTERM 优雅收束。
 */
export async function startSidecar(
  opts: SidecarOptions,
): Promise<SidecarResult> {
  const host = opts.host ?? DEFAULT_HOST;
  const stateDir = opts.stateDir ?? path.join(defaultDataDir(), 'state');
  const instanceId = opts.instanceId ?? `inst_${ulid()}`;
  const readyFile = opts.readyFile ?? path.join(stateDir, 'ready.json');

  const lockResult = await InstanceLock.acquire(stateDir, instanceId);
  if (!lockResult.acquired) {
    throw new Error(
      `another live-recorder instance is running (pid=${lockResult.existing?.pid})`,
    );
  }
  const lock = lockResult.handle;

  const port = opts.preferredPort ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    await lock.release();
    throw new Error('invalid backend port');
  }
  const startedAt = nowIso();
  const instance: AppInstance = {
    instanceId,
    pid: process.pid,
    host: '127.0.0.1',
    port,
    baseUrl: `http://${host}:${port}`,
    apiVersion: API_VERSION,
    startedAt,
  };

  const buildOptions: Parameters<typeof buildServices>[0] = {};
  if (opts.mode) buildOptions.mode = opts.mode;
  if (opts.dbPath) buildOptions.dbPath = opts.dbPath;
  let services: ReturnType<typeof buildServices>;
  try {
    services = buildServices(buildOptions);
  } catch (error) {
    await lock.release();
    throw error;
  }
  try {
    void recoverStaleRecordings(services)
      .then((count) => {
        if (count > 0)
          console.log(`recovered ${count} stale recording session(s)`);
      })
      .catch((error) => console.error('recording recovery failed', error));
    // #220：重启时遗留的「待确认保留」录制按默认保留恢复管线/上传。
    services.manager.resumePendingConfirmations();
    // 恢复重启前排队中的上传任务（#195：上传队列为内存态，DB 中 queued/running 需启动续传）。
    const resumedUploads = services.uploader.resumePending();
    if (resumedUploads > 0)
      console.log(`resumed ${resumedUploads} pending upload job(s)`);

    const extraOrigins = opts.extraOrigins ?? [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
    ];
    const { app } = buildApp(services, { extraOrigins, instance });

    // 直接监听目标端口，避免“探测释放后被其他进程抢占”的竞态。
    try {
      const candidates =
        port === 0 ? [0] : [...new Set([port, ...BACKUP_PORTS, 0])];
      for (const candidate of candidates) {
        try {
          await app.listen({ host, port: candidate });
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (candidate === 0 || (code !== 'EADDRINUSE' && code !== 'EACCES'))
            throw error;
        }
      }
      const address = app.server.address();
      if (!address || typeof address === 'string')
        throw new Error('backend address unavailable');
      instance.port = address.port;
      instance.baseUrl = `http://${host}:${address.port}`;
      await writeReadyFile(readyFile, instance);
      services.scheduler.start();
    } catch (error) {
      await app.close();
      throw error;
    }

    let closing: Promise<void> | null = null;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        // 优雅收束顺序：停止接收新请求（app.close）→ 安全收束调度与连接（onClose 钩子）→ 删除 ready/锁。
        try {
          await app.close();
        } finally {
          try {
            if (await lock.held()) await removeReadyFile(readyFile);
          } finally {
            await lock.release();
          }
        }
      })());

    return { instance, readyFile, lock, close };
  } catch (error) {
    services.scheduler.stop();
    if (services.db.open) services.db.close();
    await lock.release();
    throw error;
  }
}

/** 向进程注册优雅退出信号，确保退出顺序固定。 */
export function installShutdownSignals(run: SidecarResult): void {
  const shutdown = (signal: string): void => {
    console.log(`received ${signal}, shutting down`);
    void run.close().then(
      () => process.exit(0),
      (error) => {
        console.error('shutdown failed', error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * 父进程死亡自检（#199 兜底）：Tauri 宿主被强杀/崩溃（未走优雅退出）时，
 * 后端子进程会被 reparent 到 init/launchd，process.ppid 变化即判定宿主已退出，
 * 优雅收束（关服务→删 ready/锁）后自行退出，避免孤儿后端常驻占用 43120 致新版连旧后端。
 */
export function watchParentExit(close: () => Promise<void>): void {
  const parentPid = process.ppid;
  const timer = setInterval(() => {
    let alive = true;
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      alive = (error as NodeJS.ErrnoException).code === 'EPERM';
    }
    if (process.ppid !== parentPid || !alive) {
      clearInterval(timer);
      console.log('parent process exited, shutting down backend');
      void close().then(
        () => process.exit(0),
        (error) => {
          console.error('shutdown failed', error);
          process.exit(1);
        },
      );
    }
  }, 2_000);
  // 不阻止事件循环退出（纯守护逻辑）。
  timer.unref();
}

export { APP_VERSION, DEFAULT_HOST };
