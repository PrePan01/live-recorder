import { mkdtemp, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { pickPort, BACKUP_PORTS, osFreePort } from '../../src/sidecar/ports.ts';
import { InstanceLock } from '../../src/sidecar/instance-lock.ts';
import { writeReadyFile, readReadyFile, removeReadyFile } from '../../src/sidecar/ready-file.ts';
import { startSidecar } from '../../src/sidecar/start.ts';

let occupied: import('node:net').Server[] = [];

async function occupyPort(host: string, port: number): Promise<void> {
  const srv = createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, host, () => resolve());
  });
  occupied.push(srv);
}

afterEach(async () => {
  await Promise.all(occupied.map((s) => new Promise<void>((r) => s.close(() => r()))));
  occupied = [];
});

describe('sidecar ports', () => {
  it('prefers the requested preferred port when free', async () => {
    const preferred = 43801;
    expect(await pickPort('127.0.0.1', preferred)).toBe(preferred);
  });

  it('falls back to a backup port when preferred is occupied', async () => {
    const preferred = 43802;
    await occupyPort('127.0.0.1', preferred);
    const port = await pickPort('127.0.0.1', preferred);
    expect(port).not.toBe(preferred);
    expect(BACKUP_PORTS).toContain(port);
  });

  it('falls to OS-assigned free port when all candidates occupied', async () => {
    const preferred = 43803;
    for (const p of [preferred, ...BACKUP_PORTS]) await occupyPort('127.0.0.1', p);
    const port = await pickPort('127.0.0.1', preferred);
    expect([preferred, ...BACKUP_PORTS]).not.toContain(port);
    expect(port).toBeGreaterThan(0);
  });

  it('honors an explicit preferred port that is free', async () => {
    const preferred = 43999;
    expect(await pickPort('127.0.0.1', preferred)).toBe(preferred);
  });

  it('osFreePort returns a bindable port', async () => {
    const port = await osFreePort('127.0.0.1');
    expect(port).toBeGreaterThan(0);
  });
});

describe('sidecar instance lock', () => {
  it('acquires a lock and writes atomic state file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-lock-'));
    const result = await InstanceLock.acquire(dir, 'inst_abc');
    expect(result.acquired).toBe(true);
    const raw = JSON.parse(await readFile(path.join(dir, 'instance.lock'), 'utf8')) as { instanceId: string; pid: number };
    expect(raw.instanceId).toBe('inst_abc');
    expect(raw.pid).toBe(process.pid);
    await result.handle.release();
  });

  it('rejects a second instance with a live PID', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-lock2-'));
    const first = await InstanceLock.acquire(dir, 'inst_a');
    expect(first.acquired).toBe(true);
    const second = await InstanceLock.acquire(dir, 'inst_b');
    expect(second.acquired).toBe(false);
    expect(second.existing?.instanceId).toBe('inst_a');
    await first.handle.release();
  });

  it('reclaims a stale lock whose PID is gone', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-lock3-'));
    await writeFile(path.join(dir, 'instance.lock'), JSON.stringify({ instanceId: 'inst_old', pid: 999999, version: '0.1.0', startedAt: 'x' }));
    const result = await InstanceLock.acquire(dir, 'inst_new');
    expect(result.acquired).toBe(true);
    const raw = JSON.parse(await readFile(path.join(dir, 'instance.lock'), 'utf8')) as { instanceId: string };
    expect(raw.instanceId).toBe('inst_new');
    await result.handle.release();
  });

  it('release only removes its own lock', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-lock4-'));
    const first = await InstanceLock.acquire(dir, 'inst_a');
    await first.handle.release();
    const second = await InstanceLock.acquire(dir, 'inst_b');
    expect(second.acquired).toBe(true);
    await second.handle.release();
  });

  it('held() reflects ownership', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-lock5-'));
    const first = await InstanceLock.acquire(dir, 'inst_a');
    expect(await first.handle.held()).toBe(true);
    await first.handle.release();
    expect(await first.handle.held()).toBe(false);
  });
});

describe('sidecar ready file', () => {
  it('writes atomically and reads back', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'lr-ready-')), 'ready.json');
    const instance = { instanceId: 'inst_x', pid: process.pid, host: '127.0.0.1' as const, port: 43121, baseUrl: 'http://127.0.0.1:43121', apiVersion: 'v1' as const, startedAt: 't' };
    await writeReadyFile(file, instance);
    expect(await readReadyFile(file)).toEqual(instance);
    await removeReadyFile(file);
    expect(await readReadyFile(file)).toBeNull();
  });

  it('leaves no temp file behind', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-ready2-'));
    const file = path.join(dir, 'ready.json');
    await writeReadyFile(file, { instanceId: 'i', pid: 1, host: '127.0.0.1', port: 1, baseUrl: 'x', apiVersion: 'v1', startedAt: 't' });
    const entries = await readdirSafe(dir);
    expect(entries).toEqual(['ready.json']);
  });
});

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  return readdir(dir);
}

describe('sidecar start (integration)', () => {
  it('starts a sidecar, reports instance fields, and closes cleanly', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-sidecar-'));
    const run = await startSidecar({ host: '127.0.0.1', stateDir: dir, preferredPort: 43990, instanceId: 'inst_start' });
    expect(run.instance.instanceId).toBe('inst_start');
    expect(run.instance.port).toBe(43990);
    expect(run.instance.pid).toBe(process.pid);
    const ready = await readReadyFile(run.readyFile);
    expect(ready?.instanceId).toBe('inst_start');
    await run.close();
    expect(await readReadyFile(run.readyFile)).toBeNull();
    await expect(stat(path.join(dir, 'instance.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails to start a second sidecar sharing a state dir', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-sidecar2-'));
    const first = await startSidecar({ host: '127.0.0.1', stateDir: dir, preferredPort: 43991, instanceId: 'inst_one' });
    await expect(startSidecar({ host: '127.0.0.1', stateDir: dir, preferredPort: 43992, instanceId: 'inst_two' })).rejects.toThrow(/another live-recorder instance/);
    await first.close();
  });

  it('watchParentExit exits when its parent process dies (宿主强退兜底 #199)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-ppid-'));
    const marker = path.join(dir, 'done');
    const distStart = pathToFileURL(path.resolve(process.cwd(), 'dist/sidecar/start.js')).href;
    const childScript = `
      import { watchParentExit } from '${distStart}';
      import { writeFile } from 'node:fs/promises';
      watchParentExit(async () => { await writeFile('${marker}', 'x'); process.exit(0); });
      console.log('child-ready');
      setInterval(() => {}, 1000);
    `;
    // 中间父进程：spawn 侧车子进程（child），待 child-ready 后退出 → child 被 reparent → ppid 变化 → 自检退出。
    const middleScript = `
      import { spawn } from 'node:child_process';
      const c = spawn(${JSON.stringify(process.execPath)}, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'pipe', 'inherit'] });
      c.stdout.on('data', (d) => { if (String(d).includes('child-ready')) setTimeout(() => process.exit(0), 50); });
      setTimeout(() => process.exit(0), 8000);
    `;
    const middle = spawn(process.execPath, ['--input-type=module', '-e', middleScript], { stdio: 'inherit' });
    try {
      const start = Date.now();
      while (Date.now() - start < 10_000) {
        try {
          await stat(marker);
          return; // 自检触发成功
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      throw new Error('watchParentExit 未在父进程退出后自检退出');
    } finally {
      middle.kill('SIGKILL');
    }
  });
});