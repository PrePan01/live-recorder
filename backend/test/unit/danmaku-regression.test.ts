import { mkdtemp, readFile, rm, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, expect, it, vi } from 'vitest';
import { DanmakuStore } from '../../src/danmaku/store.js';
import { DanmakuCollector } from '../../src/danmaku/collector.js';
import { DanmakuManager } from '../../src/danmaku/manager.js';
import { fields, parsePushFrame } from '../../src/danmaku/adapters/douyin-protocol.js';
import { packets } from '../../src/danmaku/adapters/bilibili.js';
import type { Services } from '../../src/core/services.js';
import type { Room } from '../../src/types/room.js';

const dirs: string[] = [];
async function recording() { const dir = await mkdtemp(path.join(tmpdir(), 'lr-danmaku-regression-')); dirs.push(dir); return path.join(dir, 'rec.flv'); }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('drains a backpressured writer on immediate close and paginates equal timestamps without loss', async () => {
  const rec = await recording(), store = await DanmakuStore.open(rec);
  for (let i = 0; i < 10_000; i++) expect(store.append({ id: String(i), tMs: 1000, wallMs: i, text: '弹幕'.repeat(10) })).toBe(true);
  await Promise.all([store.close(), store.close()]);
  expect((await readFile(store.filePath, 'utf8')).trim().split('\n')).toHaveLength(10_000);
  const ids: string[] = []; let cursor: string | undefined;
  do {
    const page = await store.readRange(1000, 1000, { limit: 777, ...(cursor ? { cursor } : {}) });
    ids.push(...page.messages.map(m => m.id)); cursor = page.next ?? undefined;
  } while (cursor);
  expect(ids).toEqual(Array.from({ length: 10_000 }, (_, i) => String(i)));
});

it('rebuilds an appended tail incrementally, preserves non-monotonic legacy times and recovers truncated lines', async () => {
  const rec = await recording(), file = DanmakuStore.sidecarPathFor(rec);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ id: 'old', tMs: 3000, text: '旧' }) + '\n{"crash":');
  const reader = (await DanmakuStore.openExisting(rec))!;
  expect((await reader.readRange(0, 9999)).messages.map(m => m.id)).toEqual(['old']);
  const writer = await DanmakuStore.open(rec);
  writer.append({ id: 'new', tMs: 1000, wallMs: 0, text: '新' }); await writer.close();
  expect((await reader.readRange(0, 1500)).messages.map(m => m.id)).toEqual(['new']);
  await appendFile(file, JSON.stringify({ id: 'partial', tMs: 1200, text: '尾' }));
  expect((await reader.readRange(0, 1500)).messages).toHaveLength(1);
  await appendFile(file, '\n');
  expect((await reader.readRange(0, 1500)).messages.map(m => m.id)).toEqual(['new', 'partial']);
});

it('moves and deletes messages and persisted gaps together', async () => {
  const rec = await recording(), store = await DanmakuStore.open(rec);
  store.append({ id: 'a', tMs: 100, wallMs: 1, text: 'A' });
  const gaps = [{ fromMs: 0, toMs: 50, reason: 'disconnect' }];
  await store.saveGaps(gaps); await store.close();
  const moved = rec.replace('rec.flv', 'renamed_c.mp4');
  await DanmakuStore.move(rec, moved);
  expect(await DanmakuStore.openExisting(rec)).toBeNull();
  const reader = (await DanmakuStore.openExisting(moved))!;
  expect((await reader.readRange(0, 1000)).messages).toHaveLength(1);
  expect(await reader.readGaps()).toEqual(gaps);
  await DanmakuStore.remove(moved);
  await expect(readFile(reader.filePath + '.gaps.json')).rejects.toThrow();
});

it('cancels a start waiting for credentials before creating a collector', async () => {
  let release!: (cookie: string) => void;
  const waiting = new Promise<string>(resolve => { release = resolve; });
  const services = { settings: { load: () => ({ danmaku: { enabled: true } }) }, platformCookie: () => waiting, events: { emit: vi.fn() } } as unknown as Services;
  const manager = new DanmakuManager(services), rec = await recording();
  manager.startForRecording('rec', rec, { platform: 'bilibili', url: 'https://live.bilibili.com/1' } as Room, () => 0);
  const stopped = manager.stopForRecording('rec'); release(''); await stopped;
  expect(manager.statusFor('rec')).toBeNull(); expect(services.events.emit).not.toHaveBeenCalled();
  await manager.removeSidecar(rec); expect(await DanmakuStore.openExisting(rec)).toBeNull();
});

it('marks a quiet authenticated connection as collecting and persists a gap on stop', async () => {
  const store = await DanmakuStore.open(await recording()); let media = 100;
  const collector = DanmakuCollector.start({ recordingId: 'quiet', store, roomUrl: '', cookie: null, sink: { status: () => undefined }, mediaNow: () => media,
    adapter: { platform: 'fake', async *collect(_url, _cookie, signal, ready) { media = 500; ready?.(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); } },
  });
  expect(collector.status.state).toBe('collecting'); media = 1000; await collector.stop();
  expect(await store.readGaps()).toEqual([{ fromMs: 100, toMs: 500, reason: 'stream_disconnect' }]);
});

function vint(n: bigint) { const a: number[] = []; do { a.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n); return Buffer.from(a); }
function field(n: number, body: Buffer | string) { const b = Buffer.from(body); return Buffer.concat([vint(BigInt(n * 8 + 2)), vint(BigInt(b.length)), b]); }
it('decodes the schema payload and all chat messages, acknowledging a 64-bit log ID', () => {
  const chat = (text: string) => field(1, Buffer.concat([field(1, 'WebcastChatMessage'), field(2, Buffer.concat([field(1, 'long distracting metadata'.repeat(10)), field(3, text)]))]));
  const response = Buffer.concat([chat('第一条'), chat('第二条'), field(5, 'internal'), Buffer.from([72, 1])]);
  const logId = 1234567890123456789n;
  const result = parsePushFrame(Buffer.concat([Buffer.from([16]), vint(logId), field(6, 'gzip'), field(8, gzipSync(response))]));
  expect(result.texts).toEqual(['第一条', '第二条']);
  const ack = fields(result.ack!); expect(ack.get(2)?.[0]).toBe(logId); expect(ack.get(7)?.[0]?.toString()).toBe('ack'); expect(ack.get(8)?.[0]?.toString()).toBe('internal');
  expect(() => parsePushFrame(Buffer.from([66, 255]))).toThrow();
});
it('rejects a zero-length Bilibili packet instead of looping indefinitely', () => {
  expect(() => [...packets(Buffer.alloc(16))]).toThrow();
});

it('restarts an active collector at the renamed path and retains its persisted gaps', async () => {
  const events = vi.fn();
  const services = { settings: { load: () => ({ danmaku: { enabled: true } }) }, platformCookie: async () => '', events: { emit: events } } as unknown as Services;
  const manager = new DanmakuManager(services), rec = await recording();
  manager.startForRecording('active', rec, { platform: 'fake', url: 'https://fake/1' } as unknown as Room, () => 1000);
  await vi.waitFor(() => expect(manager.statusFor('active')).not.toBeNull());
  const moved = rec.replace('rec.flv', 'new.flv');
  await manager.moveSidecar('active', rec, moved);
  await vi.waitFor(() => expect(manager.statusFor('active')).not.toBeNull());
  expect(await DanmakuStore.openExisting(rec)).toBeNull(); expect(await DanmakuStore.openExisting(moved)).not.toBeNull();
  await manager.shutdown();
});

it('closes a disconnected tail at the final media position even after the live clock becomes unavailable', async () => {
  const store = await DanmakuStore.open(await recording()); let media: number | null = 100;
  const collector = DanmakuCollector.start({ recordingId: 'tail', store, roomUrl: '', cookie: null, sink: { status: () => undefined }, mediaNow: () => media,
    adapter: { platform: 'fake', async *collect() { throw new Error('disconnect'); } },
  });
  await vi.waitFor(() => expect(collector.status.state).toBe('reconnecting'));
  media = null; await collector.stop(2000);
  expect(await store.readGaps()).toEqual([{ fromMs: 100, toMs: 2000, reason: 'collector_stopped' }]);
});

it('keeps a sidecar migration failure within the danmaku subsystem', async () => {
  const emit = vi.fn(), manager = new DanmakuManager({ events: { emit } } as unknown as Services);
  vi.spyOn(DanmakuStore, 'move').mockRejectedValueOnce(new Error('disk unavailable'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await expect(manager.moveSidecar('failed', '/source.flv', '/target.flv')).resolves.toBeUndefined();
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'danmaku:status', data: expect.objectContaining({ recordingId: 'failed', state: 'unavailable' }) }));
});

it('stops a pending start without waiting for a stalled credential provider', async () => {
  const credential = vi.fn(() => new Promise<string>(() => undefined));
  const services = { settings: { load: () => ({ danmaku: { enabled: true } }) }, platformCookie: credential, events: { emit: vi.fn() } } as unknown as Services;
  const manager = new DanmakuManager(services), rec = await recording();
  manager.startForRecording('waiting', rec, { platform: 'bilibili', url: 'https://live.bilibili.com/1' } as Room, () => 0);
  await vi.waitFor(() => expect(credential).toHaveBeenCalled());
  await manager.stopForRecording('waiting');
  expect(manager.statusFor('waiting')).toBeNull(); await manager.removeSidecar(rec);
  expect(await DanmakuStore.openExisting(rec)).toBeNull();
});


it('stores messages and gaps in .danmaku beside .cache without cluttering the video directory', async () => {
  const rec = await recording(), dir = path.dirname(rec);
  await mkdir(path.join(dir, '.cache'));
  const store = await DanmakuStore.open(rec);
  expect(store.filePath).toBe(path.join(dir, '.danmaku', 'rec.danmaku.jsonl'));
  store.append({ id: 'a', tMs: 100, wallMs: 1, text: 'A' });
  await store.saveGaps([{ fromMs: 0, toMs: 50 }]);
  await store.close();
  expect((await store.readRange(0, 1000)).messages).toHaveLength(1);
  expect(await store.readGaps()).toEqual([{ fromMs: 0, toMs: 50 }]);
  await expect(readFile(path.join(dir, 'rec.danmaku.jsonl'))).rejects.toThrow();
  await expect(readFile(path.join(dir, 'rec.danmaku.jsonl.gaps.json'))).rejects.toThrow();
});

it('migrates legacy messages and gaps once across concurrent reads and preserves append history', async () => {
  const rec = await recording(), legacy = rec.replace('.flv', '.danmaku.jsonl');
  const message = { id: 'old', tMs: 100, wallMs: 1, text: '旧弹幕' };
  const gaps = [{ fromMs: 0, toMs: 50, reason: 'disconnect' }];
  await writeFile(legacy, JSON.stringify(message) + '\n');
  await writeFile(legacy + '.gaps.json', JSON.stringify(gaps));
  const readers = await Promise.all(Array.from({ length: 5 }, () => DanmakuStore.openExisting(rec)));
  for (const reader of readers) {
    expect((await reader!.readRange(0, 1000)).messages).toEqual([message]);
    expect(await reader!.readGaps()).toEqual(gaps);
  }
  await expect(readFile(legacy)).rejects.toThrow();
  await expect(readFile(legacy + '.gaps.json')).rejects.toThrow();
  const writer = await DanmakuStore.open(rec);
  writer.append({ id: 'new', tMs: 200, wallMs: 2, text: '新弹幕' });
  await writer.close();
  expect((await readers[0]!.readRange(0, 1000)).messages.map(m => m.id)).toEqual(['old', 'new']);
});

it('moves legacy sidecars into the new recording directory and removes both layouts', async () => {
  const rec = await recording(), legacy = rec.replace('.flv', '.danmaku.jsonl');
  await writeFile(legacy, JSON.stringify({ id: 'old', tMs: 100, text: '旧' }) + '\n');
  await writeFile(legacy + '.gaps.json', '[]');
  const target = path.join(path.dirname(rec), 'finished', 'renamed.mp4');
  await DanmakuStore.move(rec, target);
  const reader = (await DanmakuStore.openExisting(target))!;
  expect(reader.filePath).toBe(path.join(path.dirname(target), '.danmaku', 'renamed.danmaku.jsonl'));
  expect((await reader.readRange(0, 1000)).messages).toHaveLength(1);
  await expect(readFile(legacy)).rejects.toThrow();
  // Also clean up old layout files if both versions exist.
  const oldTarget = target.replace('.mp4', '.danmaku.jsonl');
  await writeFile(oldTarget, 'legacy');
  await writeFile(oldTarget + '.gaps.json', '[]');
  await writeFile(oldTarget + '.gaps.json.part', '[]');
  await DanmakuStore.remove(target);
  for (const file of [reader.filePath, oldTarget]) {
    for (const suffix of ['', '.gaps.json', '.gaps.json.part']) {
      await expect(readFile(file + suffix)).rejects.toThrow();
    }
  }
});

it('preserves both versions on migration conflicts without replacing messages or their gaps', async () => {
  const rec = await recording(), legacy = rec.replace('.flv', '.danmaku.jsonl');
  const store = await DanmakuStore.open(rec);
  store.append({ id: 'new', tMs: 200, wallMs: 2, text: '新' });
  await store.close();
  await writeFile(legacy, JSON.stringify({ id: 'old', tMs: 100, text: '旧' }) + '\n');
  await writeFile(legacy + '.gaps.json', '[{"fromMs":0,"toMs":100}]');
  const reader = (await DanmakuStore.openExisting(rec))!;
  expect((await reader.readRange(0, 1000)).messages.map(m => m.id)).toEqual(['new']);
  expect(await reader.readGaps()).toEqual([]);
  expect(await readFile(legacy, 'utf8')).toContain('old');
  expect(await readFile(legacy + '.gaps.json', 'utf8')).toContain('fromMs');
});
