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

it('pages the saved list in file order and resumes from the last complete line', async () => {
  const rec = await recording();
  const file = DanmakuStore.sidecarPathFor(rec);
  await mkdir(path.dirname(file), { recursive: true });
  const saved = Array.from({ length: 501 }, (_, index) => ({
    id: String(index),
    tMs: index === 500 ? null : 1000,
    text: '弹幕',
  }));
  const prefix = saved.map((row) => JSON.stringify(row) + '\n').join('');
  const partial = JSON.stringify({ id: 'tail', tMs: 2500, text: '新弹幕' });
  await writeFile(file, prefix + partial);
  const reader = (await DanmakuStore.openExisting(rec))!;

  const first = await reader.readListPage('0', 500);
  expect(first.messages).toEqual(saved.slice(0, 500));
  expect(first.next).toBe(first.resumeCursor);
  const last = await reader.readListPage(first.resumeCursor, 500);
  expect(last).toEqual({
    messages: [saved[500]],
    rowCursors: [first.resumeCursor],
    next: null,
    resumeCursor: String(Buffer.byteLength(prefix)),
  });
  expect(await reader.readListPage(last.resumeCursor, 500)).toEqual({
    messages: [],
    next: null,
    resumeCursor: last.resumeCursor,
  });
  await appendFile(file, '\n');
  const tail = await reader.readListPage(last.resumeCursor, 500);
  expect(tail.messages).toEqual([JSON.parse(partial)]);
  expect(tail.resumeCursor).toBe(String(Buffer.byteLength(prefix + partial + '\n')));
});

it('opens a long live list at the latest complete lines and then reads only new rows', async () => {
  const rec = await recording();
  const file = DanmakuStore.sidecarPathFor(rec);
  await mkdir(path.dirname(file), { recursive: true });
  const rows = Array.from({ length: 600 }, (_, index) => ({
    id: String(index), tMs: 123, text: '弹幕'.repeat(512),
  }));
  const prefix = rows.map(row => JSON.stringify(row) + '\n').join('');
  const tail = { id: 'partial', tMs: 123, text: '还未写完的弹幕' };
  await writeFile(file, prefix + JSON.stringify(tail));
  const reader = (await DanmakuStore.openExisting(rec))!;
  const page = await reader.readListPage('latest', 10);
  expect(page).toMatchObject({
    messages: rows.slice(-10), next: null, resumeCursor: String(Buffer.byteLength(prefix)),
    previous: page.rowCursors?.[0],
  });
  expect(page.previous).toBeTruthy();
  const older = await reader.readListPage(`before:${page.previous}`, 10);
  expect(older.messages).toEqual(rows.slice(-20, -10));
  expect((await reader.readListPage(page.previous!, 10)).messages).toEqual(page.messages);
  // Walk several byte windows with one oversized row among valid rows.
  const broken = JSON.stringify({ ...rows[300], text: "x".repeat(300_000) });
  await writeFile(file, prefix.replace(JSON.stringify(rows[300]), broken) + JSON.stringify(tail));
  const newest = await reader.readListPage("latest", 500);
  const collected = [...newest.messages];
  let cursor = newest.previous;
  while (cursor) {
    const older = await reader.readListPage(`before:${cursor}`, 500);
    expect(Number(older.previous)).toBeLessThan(Number(cursor));
    collected.unshift(...older.messages);
    cursor = older.previous;
  }
  expect(collected).toEqual(rows.filter(row => row.id !== "300"));
  await writeFile(file, prefix + JSON.stringify(tail));
  expect((await reader.readListPage(page.resumeCursor, 10)).messages).toEqual([]);
  await appendFile(file, '\n');
  expect((await reader.readListPage(page.resumeCursor, 10)).messages).toEqual([tail]);
  expect((await reader.readListPage('0', 10)).messages).toEqual(rows.slice(0, 10));
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

it('skips legacy preview rows in recorded lists without changing byte cursor progress', async () => {
  const rec = await recording(), store = await DanmakuStore.open(rec);
  const legacy = { id: 'preview', tMs: null, wallMs: 1, text: '之前误转存的预览弹幕', beforeRecording: true } as const;
  const saved = { id: 'saved', tMs: 100, wallMs: 2, text: '录像弹幕' };
  store.append(legacy);
  store.append(saved);
  await store.close();
  const page = await store.readListPage('0', 1);
  expect(page.messages).toEqual([saved]);
  expect(page.next).toBeNull();
  expect((await store.readRange(0, 1000, { includeUnmappable: true })).messages).toEqual([saved]);
  expect((await store.readListPage(page.resumeCursor, 1)).messages).toEqual([]);
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

it('stays unavailable throughout a retry and returns to collecting when it succeeds', async () => {
  const store = await DanmakuStore.open(await recording());
  let attempts = 0;
  let finishRetry!: () => void;
  const retry = new Promise<void>(resolve => { finishRetry = resolve; });
  vi.useFakeTimers();
  const collector = DanmakuCollector.start({
    recordingId: 'preview:retry', store, roomUrl: '', cookie: null, sink: { status: () => undefined }, mediaNow: () => null,
    adapter: {
      platform: 'xiaohongshu',
      async *collect(_url, _cookie, signal, ready) {
        if (++attempts <= 8) throw new Error('官网请求未完成');
        await retry;
        if (signal.aborted) return;
        ready?.();
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      },
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(150_000);
    expect(attempts).toBe(9);
    expect(collector.status.state).toBe('unavailable');
    finishRetry();
    await vi.advanceTimersByTimeAsync(0);
    expect(collector.status.state).toBe('collecting');
  } finally {
    finishRetry();
    vi.useRealTimers();
    await collector.stop();
  }
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
