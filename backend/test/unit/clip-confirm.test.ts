import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import { recoverOrphanClipExports } from '../../src/core/recovery.js';
import { buildServices } from '../../src/core/services.js';
import { FakePlatformAdapter } from '../../src/platform/fake-adapter.js';
import type { FakeEngineScript } from '../../src/recorder/fake-engine.js';
import type { AppEvent } from '../../src/core/events.js';
import type { AppSettings, Recording } from '../../src/types/index.js';

// 片段转码不跑真 ffmpeg：本组钉「保存命名→后台导出」链（命名落盘/进度/防重/失败清理）。
const exportClipFileMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/recorder/pipeline-ffmpeg.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, exportClipFile: (...args: unknown[]) => exportClipFileMock(...args) };
});

function baseSettings(dir: string): AppSettings {
  return {
    recordingDirectory: dir,
    maxConcurrentRecordings: 2,
    quality: 'original',
    autoRecord: true,
    checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
    retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
    diskGuard: { minFreeBytes: 20 * 1024 ** 3, minFreePercent: 10 },
    mail: {
      enabled: true,
      host: 'smtp.x.com',
      port: 465,
      secure: true,
      username: 'u',
      from: 'f',
      recipients: ['a@b.c'],
    },
    dedupeWindowMinutes: 30,
  };
}

async function waitFor(fn: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function makeServices() {
  // 与录制行的 nowIso（真实时间）同基准，exportClip 的已录时长校验才成立。
  const clock = new FakeClock(Date.now());
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-clip-confirm-'));
  const services = buildServices({ dbPath: ':memory:', clock });
  services.settings.save(baseSettings(dir));
  return { clock, dir, services };
}

async function startRecording() {
  const { clock, dir, services } = await makeServices();
  (
    services.engineFor() as unknown as { script: FakeEngineScript }
  ).script = { frames: 100, intervalMs: 500 };
  (services.adapterFor('bilibili') as FakePlatformAdapter).setScript(
    Array.from({ length: 20 }, () => ({ status: 'live' as const })),
  );
  const room = services.rooms.create({
    platform: 'bilibili',
    url: 'https://live.bilibili.com/99',
    displayName: '片段确认',
  });
  await services.manager.maybeStartRecording(room, {
    streamSessionId: `clip-${Math.random()}`,
  });
  const source = services.recordings.list({ roomId: room.id }).items[0]!;
  await waitFor(() => Boolean(services.recordings.get(source.id)?.filePath));
  // 积累出选区所需的已录时长（0~2 秒选区）。
  clock.advance(3_000);
  await new Promise((r) => setTimeout(r, 5));
  // 返回最新行：filePath 等字段在启动后才写入。
  return { clock, dir, services, room, source: services.recordings.get(source.id)! };
}

/** 模拟一次成功的后台导出：落盘指定大小的产物，可选驱动进度回调。 */
function mockExportOk(
  sizeBytes: number,
  drive?: (opts?: {
    onProgress?: (info: { outTimeMs: number; speed: number | null }) => void;
  }) => Promise<void> | void,
) {
  exportClipFileMock.mockImplementation(
    async (
      _in: string,
      out: string,
      _s: number,
      _e: number,
      opts?: {
        onProgress?: (info: { outTimeMs: number; speed: number | null }) => void;
      },
    ) => {
      await writeFile(out, Buffer.alloc(sizeBytes));
      if (drive) await drive(opts);
      return { ok: true, sizeBytes, stderr: '' };
    },
  );
}

beforeEach(() => {
  exportClipFileMock.mockReset();
});

describe('片段导出（保存命名→后台导出）', () => {
  it('完成即终态：标题=文件名、不进确认链、endReason=clip_export、导出不停录', async () => {
    const { services, source } = await startRecording();
    mockExportOk(2048);

    const started = await services.manager.exportClip(source.id, 0, 2, '我的片段');
    // 创建即映射选区起止：导出中历史行时长=选区时长（不随录制增长回退）。
    expect(new Date(started.clip.endedAt!).getTime()).toBe(
      new Date(services.recordings.get(source.id)!.startedAt).getTime() + 2_000,
    );
    await waitFor(
      () => services.recordings.get(started.clip.id)?.state === 'completed',
    );
    const clip = services.recordings.get(started.clip.id)!;
    // 直接到 completed：用户点「保存」已确认命名，完成不再进确认链（不双弹）。
    expect(clip.state).toBe('completed');
    expect(clip.endReason).toBe('clip_export');
    // 标题=文件名：延迟改名把落盘文件改成用户命名。
    expect(clip.streamTitle).toBe('我的片段');
    expect(path.basename(clip.filePath!)).toBe('我的片段.flv');
    expect((await stat(clip.filePath!)).size).toBe(2048);
    // 导出不停录：源录制仍在进行。
    expect(services.recordings.get(source.id)!.state).toBe('recording');
    // 选区映射到时间轴：片段起止=源录制开始+选区秒位。
    expect(new Date(clip.endedAt!).getTime()).toBe(
      new Date(services.recordings.get(source.id)!.startedAt).getTime() + 2_000,
    );
  });

  it('同录同名互不影响：第二个加序号，标题与文件名同步，绝不覆盖', async () => {
    const { services, source } = await startRecording();
    let call = 0;
    exportClipFileMock.mockImplementation(async (_in: string, out: string) => {
      call += 1;
      const sizeBytes = call === 1 ? 1111 : 2222;
      await writeFile(out, Buffer.alloc(sizeBytes));
      return { ok: true, sizeBytes, stderr: '' };
    });

    const first = await services.manager.exportClip(source.id, 0, 2, '同名');
    await waitFor(
      () => services.recordings.get(first.clip.id)?.state === 'completed',
    );
    const second = await services.manager.exportClip(source.id, 0, 2, '同名');
    await waitFor(
      () => services.recordings.get(second.clip.id)?.state === 'completed',
    );

    const a = services.recordings.get(first.clip.id)!;
    const b = services.recordings.get(second.clip.id)!;
    expect(path.basename(a.filePath!)).toBe('同名.flv');
    // 撞名加序号，标题同步加序号，历史标题=磁盘文件名恒等式不破。
    expect(path.basename(b.filePath!)).toBe('同名 (1).flv');
    expect(b.streamTitle).toBe('同名 (1)');
    // 两个文件并存且内容互不覆盖。
    expect((await stat(a.filePath!)).size).toBe(1111);
    expect((await stat(b.filePath!)).size).toBe(2222);
  });

  it('片段起成源文件名：源文件不被覆盖，片段加序号', async () => {
    const { services, source } = await startRecording();
    const sourcePath = source.filePath!;
    const sourceBase = path.basename(sourcePath, path.extname(sourcePath));
    mockExportOk(3333);

    const started = await services.manager.exportClip(source.id, 0, 2, sourceBase);
    await waitFor(
      () => services.recordings.get(started.clip.id)?.state === 'completed',
    );

    const clip = services.recordings.get(started.clip.id)!;
    // 源文件在保护名单第一位：片段永远不得指向它，只能落到序号名。
    expect(path.basename(clip.filePath!)).toBe(`${sourceBase} (1).flv`);
    expect(clip.filePath).not.toBe(sourcePath);
    expect(services.recordings.get(source.id)!.filePath).toBe(sourcePath);
    await expect(stat(sourcePath)).resolves.toBeTruthy();
    expect((await stat(clip.filePath!)).size).toBe(3333);
  });

  it('并行导出：同名同刻完成序号正确，单条失败不影响他条', async () => {
    const { clock, services, source } = await startRecording();
    // 再攒余量：FakeClock 与录制行起点有毫秒级偏移，(2,3) 选区需要更宽松的已录时长。
    clock.advance(3_000);
    // 同刻收尾压「查重→改名」间隙竞态；两条成功同名 + 一条失败，互不牵连。
    let release!: () => void;
    const barrier = new Promise<void>((res) => {
      release = res;
    });
    exportClipFileMock.mockImplementation(
      async (_in: string, out: string, startSecond: number) => {
        if (startSecond === 2) {
          await writeFile(out, Buffer.alloc(999));
          await barrier;
          return { ok: false, sizeBytes: 999, stderr: 'ffmpeg: boom' };
        }
        const sizeBytes = startSecond === 0 ? 1111 : 2222;
        await writeFile(out, Buffer.alloc(sizeBytes));
        await barrier;
        return { ok: true, sizeBytes, stderr: '' };
      },
    );

    const a1 = await services.manager.exportClip(source.id, 0, 2, '同名');
    const a2 = await services.manager.exportClip(source.id, 1, 2, '同名');
    const bad = await services.manager.exportClip(source.id, 2, 3, '要失败的');
    release();
    await waitFor(
      () =>
        services.recordings.get(a1.clip.id)?.state === 'completed' &&
        services.recordings.get(a2.clip.id)?.state === 'completed' &&
        services.recordings.get(bad.clip.id)?.state === 'failed',
    );

    const first = services.recordings.get(a1.clip.id)!;
    const second = services.recordings.get(a2.clip.id)!;
    const failed = services.recordings.get(bad.clip.id)!;
    // 并发同名收尾：两条并存、标题=文件基名、恰一条带序号（顺序不锁死，锁恒等式与集合）。
    const titles = new Set([first.streamTitle, second.streamTitle]);
    expect([...titles].sort()).toEqual(['同名', '同名 (1)']);
    for (const clip of [first, second]) {
      expect(path.basename(clip.filePath!, path.extname(clip.filePath!))).toBe(
        clip.streamTitle,
      );
    }
    // 内容互不覆盖：两条产物大小各自对应。
    expect(new Set([(await stat(first.filePath!)).size, (await stat(second.filePath!)).size])).toEqual(
      new Set([1111, 2222]),
    );
    // 单条失败不影响他条，失败条半成品照清。
    expect(failed.failureReason?.message).toBe('片段导出失败');
    await expect(stat(failed.filePath!)).rejects.toThrow();
  });

  it('同选区防重复提交，不同选区可并行；全局上限防风暴', async () => {
    const { clock, services, source } = await startRecording();
    const releases: Array<() => void> = [];
    exportClipFileMock.mockImplementation(async (_in: string, out: string) => {
      await writeFile(out, Buffer.alloc(512)).catch(() => undefined);
      await new Promise<void>((res) => releases.push(res));
      return { ok: true, sizeBytes: 512, stderr: '' };
    });

    const first = await services.manager.exportClip(source.id, 0, 2, '选区甲');
    // 同起止区间不重复提交。
    await expect(
      services.manager.exportClip(source.id, 0, 2, '选区甲再来'),
    ).rejects.toMatchObject({ code: 'CONCURRENT_LIMIT_REACHED' });
    // 不同选区可并行。
    const second = await services.manager.exportClip(source.id, 1, 2, '选区乙');
    // 全局上限（6）：在途占满后新导出被拒，但不杀在途。
    clock.advance(6_000);
    const combos: Array<[number, number]> = [
      [0, 1],
      [0, 3],
      [0, 4],
      [0, 5],
    ];
    const queued = [] as string[];
    for (const [s, e] of combos) {
      const r = await services.manager.exportClip(source.id, s, e, `选区${s}-${e}`);
      queued.push(r.clip.id);
    }
    await expect(
      services.manager.exportClip(source.id, 2, 3, '超限'),
    ).rejects.toMatchObject({ code: 'CONCURRENT_LIMIT_REACHED' });

    // 等 6 路导出全部进入在途再放行，全部正常完成。
    await waitFor(() => releases.length === 6);
    for (const release of releases) release();
    await waitFor(
      () =>
        [first.clip.id, second.clip.id, ...queued].every(
          (id) => services.recordings.get(id)?.state === 'completed',
        ),
    );
  });

  it('失败：主行人话文案、原因进 details、半成品即刻清理', async () => {
    const { services, source } = await startRecording();
    exportClipFileMock.mockImplementation(async (_in: string, out: string) => {
      await writeFile(out, Buffer.alloc(999));
      return { ok: false, sizeBytes: 999, stderr: 'ffmpeg: boom' };
    });

    const started = await services.manager.exportClip(source.id, 0, 2, '失败的');
    await waitFor(
      () => services.recordings.get(started.clip.id)?.state === 'failed',
    );
    const clip = services.recordings.get(started.clip.id)!;
    // 主行只留人话文案，技术原文进 details（不上主行）。
    expect(clip.failureReason?.message).toBe('片段导出失败');
    expect(String(clip.failureReason?.details?.reason)).toContain('boom');
    await expect(stat(clip.filePath!)).rejects.toThrow();
  });

  it('进度：整数百分比变化才发、≥500ms 间隔，终态置 null', async () => {
    const { clock, services, source } = await startRecording();
    const events: AppEvent[] = [];
    services.events.on((event) => events.push(event));
    mockExportOk(512, (opts) => {
      opts?.onProgress?.({ outTimeMs: 500, speed: 1 }); // 25%
      clock.advance(100);
      opts?.onProgress?.({ outTimeMs: 1000, speed: 1 }); // 50%，500ms 内被节流丢弃
      clock.advance(600);
      opts?.onProgress?.({ outTimeMs: 1500, speed: 1 }); // 75%
    });

    const started = await services.manager.exportClip(source.id, 0, 2, '带进度');
    await waitFor(
      () => services.recordings.get(started.clip.id)?.state === 'completed',
    );

    const clipEvents = events.filter(
      (e) =>
        e.type === 'recording:updated' &&
        (e.data as Recording).id === started.clip.id,
    );
    const pcts = clipEvents
      .map((e) => (e.data as Recording).progressPercent)
      .filter((p): p is number => typeof p === 'number');
    expect(pcts).toEqual([25, 75]);
    // 终态事件显式置 null（历史行退出「导出中」显示）。
    const doneEvent = clipEvents.find(
      (e) => (e.data as Recording).state === 'completed',
    )!;
    expect((doneEvent.data as Recording).progressPercent).toBeNull();
    // 完成后同链跟进的校验/管线事件不再携带导出进度字段。
    expect(
      clipEvents
        .slice(clipEvents.indexOf(doneEvent) + 1)
        .every((e) => (e.data as Recording).progressPercent === undefined),
    ).toBe(true);
  });

  it('重启孤儿：processing 的 clip 收敛为失败并清半成品', async () => {
    const { dir, services } = await makeServices();
    const clip = services.recordings.create({
      roomId: 'room_x',
      roomName: '孤儿',
      platform: 'bilibili',
      streamSessionId: null,
      streamTitle: '孤儿片段',
      origin: 'clip',
    });
    const partial = path.join(dir, 'orphan.flv');
    await writeFile(partial, Buffer.alloc(777));
    services.recordings.update(clip.id, { state: 'processing', filePath: partial });

    const recovered = await recoverOrphanClipExports(services);
    expect(recovered).toBe(1);
    const after = services.recordings.get(clip.id)!;
    expect(after.state).toBe('failed');
    expect(after.failureReason?.message).toBe('导出因应用重启中断');
    await expect(stat(partial)).rejects.toThrow();
  });

  it('名称校验：空/超长/非法字符拒绝', async () => {
    const { services, source } = await startRecording();
    await expect(
      services.manager.exportClip(source.id, 0, 2, ''),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      services.manager.exportClip(source.id, 0, 2, 'a'.repeat(121)),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(
      services.manager.exportClip(source.id, 0, 2, '坏/名'),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('片段完成后与正常保存录像同链（校验+管线自动入队）', () => {
  it('成功完成：自动入完整性校验队列+自动进管线，不依赖手动批量重校验', async () => {
    const { services, source } = await startRecording();
    mockExportOk(4096);
    const vq = vi
      .spyOn(services.verificationQueue, 'enqueue')
      .mockImplementation(() => true);
    const pl = vi
      .spyOn(services.pipeline, 'enqueue')
      .mockImplementation(() => undefined);

    const started = await services.manager.exportClip(source.id, 0, 2, '同链片段');
    await waitFor(
      () => services.recordings.get(started.clip.id)?.state === 'completed',
    );
    expect(vq).toHaveBeenCalledWith(
      expect.objectContaining({ id: started.clip.id }),
    );
    expect(pl).toHaveBeenCalledWith(started.clip.id);
  });

  it('真实入队语义与正常录像一致：管线未启用=not_required、状态保持 completed', async () => {
    const { services, source } = await startRecording();
    mockExportOk(4096);
    const started = await services.manager.exportClip(source.id, 0, 2, '真实入队');
    await waitFor(
      () =>
        services.recordings.get(started.clip.id)?.pipelineStatus ===
        'not_required',
    );
    const clip = services.recordings.get(started.clip.id)!;
    expect(clip.state).toBe('completed');
    expect(clip.endReason).toBe('clip_export');
  });

  it('失败不入队：failed 行不进校验/管线', async () => {
    const { services, source } = await startRecording();
    exportClipFileMock.mockImplementation(async (_in: string, out: string) => {
      await writeFile(out, Buffer.alloc(10));
      return { ok: false, sizeBytes: 999, stderr: 'ffmpeg: boom' };
    });
    const vq = vi.spyOn(services.verificationQueue, 'enqueue');
    const pl = vi.spyOn(services.pipeline, 'enqueue');

    const started = await services.manager.exportClip(source.id, 0, 2, '失败件');
    await waitFor(
      () => services.recordings.get(started.clip.id)?.state === 'failed',
    );
    expect(vq).not.toHaveBeenCalled();
    expect(pl).not.toHaveBeenCalled();
  });
});
