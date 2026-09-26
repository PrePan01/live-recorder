import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/core/clock.js';
import { buildServices } from '../../src/core/services.js';
import type { SharedPreviewRecording } from '../../src/core/recorder-manager.js';
import { once } from 'node:events';

const MAX = 32 * 1024 * 1024;

function fakeRecording(opts: { pending?: number; degradedAgo?: number; parts?: Buffer[]; remaining?: Buffer } = {}) {
  const clock = new FakeClock();
  const services = buildServices({ dbPath: ':memory:', clock });
  const parts = opts.parts ?? [];
  const rec = {
    session: { recordingId: 'rec1', size: 0, lastDataAt: 0 },
    writer: {
      write: () => true,
      end: (cb?: () => void) => { cb?.(); },
      once: () => undefined,
    },
    normalizer: {
      push: () => parts,
      remaining: () => opts.remaining ?? Buffer.alloc(0),
    },
    pendingWrites: [],
    pendingWriteBytes: opts.pending ?? 0,
    writePump: null,
    writeError: null,
    degradedSince: opts.degradedAgo !== undefined ? clock.now() - opts.degradedAgo : null,
    droppedBytes: 0,
  } as unknown as SharedPreviewRecording;
  const mgr = services.manager as unknown as {
    appendSharedPreviewRecording(r: SharedPreviewRecording, chunk: Buffer): void;
    closeSharedPreviewRecording(r: SharedPreviewRecording): Promise<void>;
  };
  return { clock, rec, mgr };
}

describe('写积压降级（繁忙=等待，录制不中断）', () => {
  it('触顶不杀：丢弃新到块并记降级起点，会话存活', () => {
    const { clock, rec, mgr } = fakeRecording({ pending: MAX - 500, parts: [Buffer.alloc(1024)] });
    expect(() => mgr.appendSharedPreviewRecording(rec, Buffer.alloc(8))).not.toThrow();
    expect(rec.droppedBytes).toBe(1024);
    expect(rec.degradedSince).toBe(clock.now());
    expect(rec.writeError).toBeNull();
  });

  it('排空过半解除降级：起点清零', () => {
    const { rec, mgr } = fakeRecording({ pending: 0, degradedAgo: 1000, parts: [] });
    mgr.appendSharedPreviewRecording(rec, Buffer.alloc(8));
    expect(rec.degradedSince).toBeNull();
  });

  it('持续超宽限(180s)才停：抛既有文案，走既有失败分类', () => {
    const { rec, mgr } = fakeRecording({
      pending: MAX - 1,
      degradedAgo: 180_001,
      parts: [Buffer.alloc(1024)],
    });
    expect(() => mgr.appendSharedPreviewRecording(rec, Buffer.alloc(8))).toThrow(/写入过慢/);
  });

  it('收尾冲刷超帽不抛：强制排出保尾（QA 口径③）', async () => {
    const { rec, mgr } = fakeRecording({ pending: MAX - 1, remaining: Buffer.alloc(64 * 1024) });
    await expect(mgr.closeSharedPreviewRecording(rec)).resolves.toBeUndefined();
    expect(rec.writeError).toBeNull();
    expect(rec.pendingWrites).toHaveLength(0); // 余量已入队并被写泵排出，未被帽拦下
  });
});
