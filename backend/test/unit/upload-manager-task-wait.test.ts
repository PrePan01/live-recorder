import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildServices, type Services } from '../../src/core/services.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import {
  OPENLIST_TASK_TIMEOUT,
  TaskWaitPolicy,
  UploadManager,
  RealWebDavClient,
} from '../../src/core/upload-manager.js';

const STALL_MS = 5;
const GRACE_MS = 50;

function policyAt(clock: { now: number }, overrides: Partial<{ stall: number; grace: number; interval: number }> = {}) {
  return new TaskWaitPolicy(
    overrides.stall ?? STALL_MS,
    overrides.grace ?? GRACE_MS,
    overrides.interval ?? 0,
    () => clock.now,
  );
}

describe('后台落盘等待策略：按进展判定，不按总时长', () => {
  it('一直有进展就永远不判失败', () => {
    const clock = { now: 0 };
    const policy = policyAt(clock);
    // 模拟慢速网盘：每 4 秒才动一格，累计跑过 2 小时也不该判失败。
    for (let i = 0; i < 1800; i += 1) {
      clock.now += 4_000;
      policy.observe(true);
      expect(policy.exhausted).toBe(false);
      expect(policy.dueForVerify()).toBe(false);
    }
  });

  it('进度停住后先核验，确认期过完才算失败', () => {
    const clock = { now: 1_000 };
    const policy = policyAt(clock);

    // 进度停住的这一刻开始计时。
    policy.observe(false);
    expect(policy.exhausted).toBe(false);

    // 卡滞窗口未满：既不核验也不失败。
    clock.now = 1_000 + STALL_MS - 1;
    expect(policy.dueForVerify()).toBe(false);
    expect(policy.exhausted).toBe(false);

    // 满窗口：到点核验，但仍在确认期内，不能判失败。
    clock.now = 1_000 + STALL_MS;
    expect(policy.dueForVerify()).toBe(true);
    expect(policy.exhausted).toBe(false);

    // 确认期内依然不判失败。
    clock.now = 1_000 + STALL_MS + GRACE_MS - 1;
    expect(policy.exhausted).toBe(false);

    // 卡滞 + 确认期都过完，才允许判失败。
    clock.now = 1_000 + STALL_MS + GRACE_MS;
    expect(policy.exhausted).toBe(true);
  });

  it('进度恢复后重新开始计时', () => {
    const clock = { now: 1_000 };
    const policy = policyAt(clock);
    policy.observe(false);
    clock.now = 1_000 + STALL_MS + GRACE_MS + 100;
    expect(policy.exhausted).toBe(true);

    // 又有进展：重新起算，不再处于"该失败"状态。
    policy.observe(true);
    expect(policy.exhausted).toBe(false);
    clock.now += STALL_MS + GRACE_MS - 1;
    policy.observe(false);
    expect(policy.exhausted).toBe(false);
  });

  it('确认期内的核验按间隔节流', () => {
    const clock = { now: 1_000 };
    const policy = policyAt(clock, { interval: 100 });
    policy.observe(false);

    clock.now = 1_000 + STALL_MS;
    expect(policy.dueForVerify()).toBe(true);
    clock.now += 1;
    expect(policy.dueForVerify()).toBe(false);
    clock.now += 99;
    expect(policy.dueForVerify()).toBe(true);
  });
});

describe('上传任务等待超时的后续处理', () => {
  async function newUpload(services: Services, client: { put: () => Promise<void> }) {
    services.uploader = new UploadManager(services, client);
    const base = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as never);
    services.settings.save({
      ...base,
      openlist: {
        enabled: true,
        serverUrl: 'https://dav.example.com/dav',
        directoryTemplate: '{room}',
        username: 'u',
        deleteSourceAfterUpload: false,
      },
    } as never);
    await services.secretStore.set('openlist.token', 'tok');
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-ulw-'));
    const file = path.join(dir, 'a.flv');
    await writeFile(file, Buffer.alloc(1024));
    const room = services.rooms.create({
      platform: 'bilibili',
      url: 'https://live.bilibili.com/1',
      displayName: 'u',
    });
    const rec = services.recordings.create({
      roomId: room.id,
      roomName: room.displayName,
      platform: 'bilibili',
      streamSessionId: 's',
      streamTitle: 't',
    });
    services.recordings.update(rec.id, { state: 'completed', filePath: file });
    return rec;
  }

  it('等待云端落盘超时不再自动重传整个文件', async () => {
    const services = buildServices({ dbPath: ':memory:' });
    let puts = 0;
    const rec = await newUpload(services, {
      async put() {
        puts += 1;
        throw new Error(`${OPENLIST_TASK_TIMEOUT}：等待超过 6 小时，文件可能仍在写入`);
      },
    });

    const job = await services.uploader.enqueue(rec.id);
    const deadline = Date.now() + 3_000;
    while (services.uploader.uploadRepo.get(job!.id)?.status !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const stored = services.uploader.uploadRepo.get(job!.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.error).toContain(OPENLIST_TASK_TIMEOUT);
    // 关键：不重传。旧实现会退避重试 3 次，把整个大文件再传一遍。
    expect(puts).toBe(1);
  });
});

describe('轮询期间用远端文件核验兜底', () => {
  // 配置里的服务地址以 /dav 结尾（真实设置就是这样），API 根要从它推出来。
  const SERVER = 'https://dav.example.com/dav';
  const REMOTE = `${SERVER}/room/a.flv`;

  async function runPut(options: {
    remoteAppearsAfter: number;
  }): Promise<{ resolved: boolean; error: string | null; propfinds: number }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-ulp-'));
    const file = path.join(dir, 'a.flv');
    const payload = Buffer.alloc(4096, 7);
    await writeFile(file, payload);

    const original = globalThis.fetch;
    let propfinds = 0;
    const seen: string[] = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      const method = String(init?.method ?? 'GET');
      seen.push(`${method} ${target}`);
      if (method === 'MKCOL') return new Response('', { status: 201 });
      if (target.includes('/api/auth/login')) {
        return new Response(JSON.stringify({ code: 200, data: { token: 'api-token' } }), { status: 200 });
      }
      if (target.includes('/api/fs/put')) {
        return new Response(JSON.stringify({ code: 200, data: { task: { id: 'task-1' } } }), { status: 200 });
      }
      if (target.includes('/api/task/upload/info')) {
        // 服务端一直停在 10%，但这是"进度不动"，不是"任务失败"。
        return new Response(
          JSON.stringify({ code: 200, data: { id: 'task-1', state: 'running', progress: 10 } }),
          { status: 200 },
        );
      }
      if (method === 'PROPFIND') {
        propfinds += 1;
        if (propfinds < options.remoteAppearsAfter) {
          return new Response('<d:multistatus xmlns:d="DAV:"></d:multistatus>', { status: 207 });
        }
        return new Response(
          `<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:getcontentlength>${payload.length}</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>`,
          { status: 207 },
        );
      }
      throw new Error(`unexpected request ${method} ${target} (seen: ${seen.join(' | ')})`);
    }) as typeof fetch;

    try {
      const client = new RealWebDavClient({
        taskPollIntervalMs: 1,
        taskStallTimeoutMs: 10,
        taskStallGraceMs: 200,
        taskVerifyIntervalMs: 0,
        taskPollTimeoutMs: 2_000,
        verifyDelaysMs: [0],
        verifyTimeoutMs: 500,
        uploadIdleTimeoutMs: 5_000,
        responseTimeoutMs: 5_000,
      });
      await client.put(REMOTE, file, 'u', 'p', () => {}, SERVER);
      return { resolved: true, error: null, propfinds };
    } catch (err) {
      return { resolved: false, error: err instanceof Error ? err.message : String(err), propfinds };
    } finally {
      globalThis.fetch = original;
    }
  }

  it('进度不动但云端随后写完 → 判成功，不再中途报错', async () => {
    const result = await runPut({ remoteAppearsAfter: 3 });
    expect(result.error).toBeNull();
    expect(result.resolved).toBe(true);
  });

  it('进度不动且云端始终没有文件 → 才判超时，且带上可核对的标识', async () => {
    const result = await runPut({ remoteAppearsAfter: Number.MAX_SAFE_INTEGER });
    expect(result.resolved).toBe(false);
    expect(result.error).toContain(OPENLIST_TASK_TIMEOUT);
  });
});
