import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SharedDanmakuAdapter } from '../../src/danmaku/shared-adapter.js';
import { DanmakuPreviewBuffer } from '../../src/danmaku/preview-buffer.js';
import { DanmakuManager } from '../../src/danmaku/manager.js';
import { DanmakuStore } from '../../src/danmaku/store.js';
import type { DanmakuAdapter, DanmakuMessage } from '../../src/danmaku/types.js';
import type { Services } from '../../src/core/services.js';
import type { Room } from '../../src/types/room.js';

function transport() {
  let seq = 0, calls = 0, active = 0;
  const clients = new Set<{ queue: DanmakuMessage[]; wake: () => void; error?: Error }>();
  const adapter: DanmakuAdapter = {
    platform: 'fake',
    async *collect(_url, _cookie, signal, ready) {
      calls++; active++;
      const client: { queue: DanmakuMessage[]; wake: () => void; error?: Error } = { queue: [], wake: () => {} };
      clients.add(client);
      const abort = () => client.wake();
      signal.addEventListener('abort', abort);
      ready?.();
      try {
        while (!signal.aborted) {
          if (client.error) throw client.error;
          if (client.queue.length) yield client.queue.shift()!;
          else await new Promise<void>(resolve => { client.wake = resolve; });
        }
      } finally { clients.delete(client); active--; signal.removeEventListener('abort', abort); }
    },
  };
  return {
    adapter, calls: () => calls, active: () => active,
    fail() { for (const c of clients) { c.error = new Error('断连'); c.wake(); } },
    publish(text: string) { for (const c of clients) { c.queue.push({ id: String(++seq), tMs: null, wallMs: Date.now(), text }); c.wake(); } },
  };
}
const room = { id: 'room', platform: 'fake', url: 'https://fake/1', danmakuEnabled: true } as unknown as Room;
const token = '12345678-1234-1234';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())); vi.restoreAllMocks(); });
function manager(fake: ReturnType<typeof transport>) {
  const services = { settings: { load: () => ({ danmaku: { enabled: false } }) }, platformCookie: async () => '', events: { emit: vi.fn() } } as unknown as Services;
  const instance = new DanmakuManager(services, () => fake.adapter);
  cleanup.push(() => instance.shutdown());
  return instance;
}

it('shares one platform stream and releases it only after the final consumer closes', async () => {
  const fake = transport(), shared = new SharedDanmakuAdapter(fake.adapter);
  const a = new AbortController(), b = new AbortController();
  const ready = vi.fn();
  const first = shared.collect(room.url, null, a.signal, ready)[Symbol.asyncIterator]();
  const second = shared.collect(room.url, null, b.signal, ready)[Symbol.asyncIterator]();
  const one = first.next(), two = second.next();
  fake.publish('消息');
  expect((await one).value.text).toBe('消息'); expect((await two).value.text).toBe('消息');
  expect(fake.calls()).toBe(1); expect(ready).toHaveBeenCalledTimes(2);
  a.abort(); await first.return?.(); expect(fake.active()).toBe(1);
  const next = second.next(); fake.publish('继续'); expect((await next).value.text).toBe('继续');
  b.abort(); await second.return?.(); await vi.waitFor(() => expect(fake.active()).toBe(0));
});

it('bounds preview history by age, item count and bytes while supporting incremental cursors', () => {
  const buffer = new DanmakuPreviewBuffer();
  for (let i = 0; i < 5000; i++) buffer.append({ id: String(i), tMs: 1000, wallMs: 1, text: 'a' });
  const first = buffer.read(0, 1000), second = buffer.read(first.cursor, 1000);
  expect(first.messages).toHaveLength(1000); expect(second.messages).toHaveLength(1000);
  expect(first.messages[0]!.id).toBe('3000');
  expect(buffer.read(second.cursor, 1000).messages).toHaveLength(0);
  expect(buffer.read(0, 32000).messages).toHaveLength(0);
  for (let i = 0; i < 500; i++) buffer.append({ id: String(i), tMs: 40000, wallMs: 1, text: 'x'.repeat(16000) });
  expect(buffer.read(0, 40000).messages.length).toBeLessThanOrEqual(65);
  expect(buffer.append({ id: 'huge', tMs: 40000, wallMs: 1, text: 'x'.repeat(33000) })).toBe(false);
});

it('shows preview without recording or persistence being enabled and shares its connection with recording', async () => {
  const fake = transport(), instance = manager(fake);
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-live-danmaku-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  instance.subscribePreview({ ...room, danmakuEnabled: false }, token);
  await vi.waitFor(() => expect(fake.active()).toBe(1));
  fake.publish('纯观看');
  await vi.waitFor(() => expect(instance.readPreview(room.id, token, 0).messages).toHaveLength(1));
  expect(await readdir(dir)).toEqual([]);
  const file = path.join(dir, 'rec.flv');
  instance.startForRecording('rec', file, room, () => 500);
  await vi.waitFor(() => expect(instance.statusFor('rec')?.state).toBe('collecting'));
  expect(fake.calls()).toBe(1);
  fake.publish('同步录制');
  await vi.waitFor(() => expect(instance.readPreview(room.id, token, 0).messages).toHaveLength(2));
  await instance.stopForRecording('rec', 600);
  expect(fake.active()).toBe(1);
  const store = (await DanmakuStore.openExisting(file))!;
  expect((await store.readRange(0, 1000)).messages).toMatchObject([{ tMs: 500, text: '同步录制' }]);
  await instance.unsubscribePreview(room.id, token);
  await vi.waitFor(() => expect(fake.active()).toBe(0));
});

it('closing preview preserves recording, and multiple preview leases share one bounded source', async () => {
  const fake = transport(), instance = manager(fake);
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-live-recording-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rec.flv');
  instance.startForRecording('rec', file, room, () => 1000);
  await vi.waitFor(() => expect(instance.statusFor('rec')?.state).toBe('collecting'));
  instance.subscribePreview(room, token); instance.subscribePreview(room, token + '-2');
  await vi.waitFor(() => expect(instance.readPreview(room.id, token, 0).status.state).toBe('collecting'));
  expect(fake.calls()).toBe(1);
  await instance.unsubscribePreview(room.id, token);
  expect(instance.readPreview(room.id, token + '-2', 0).status.state).toBe('collecting');
  await instance.unsubscribePreview(room.id, token + '-2');
  expect(fake.active()).toBe(1);
  fake.publish('还在录制');
  await vi.waitFor(async () => {
    const data = await instance.readRange('rec', file, 0, 2000);
    expect(data.messages).toMatchObject([{ tMs: 1000, text: '还在录制' }]);
  });
  await instance.stopForRecording('rec');
  const store = (await DanmakuStore.openExisting(file))!;
  expect((await store.readRange(0, 2000)).messages).toMatchObject([{ tMs: 1000, text: '还在录制' }]);
  await vi.waitFor(() => expect(fake.active()).toBe(0));
});

it('expires abandoned leases and immediately cancels a stalled credential request', async () => {
  const fake = transport(), instance = manager(fake);
  let now = 1000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  instance.subscribePreview(room, token);
  await vi.waitFor(() => expect(fake.active()).toBe(1));
  now += 16000;
  expect(() => instance.readPreview(room.id, token, 0)).toThrow('过期');
  await vi.waitFor(() => expect(fake.active()).toBe(0));
  const stalled = new DanmakuManager({ platformCookie: () => new Promise<string>(() => {}) } as unknown as Services, () => fake.adapter);
  stalled.subscribePreview(room, token);
  await stalled.unsubscribePreview(room.id, token);
  await stalled.shutdown();
  expect(fake.active()).toBe(0);
});

it('keeps persisting when preview starts first and is repeatedly hidden and reopened', async () => {
  const fake = transport(), instance = manager(fake);
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-preview-toggle-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rec.flv');
  instance.subscribePreview(room, token);
  await vi.waitFor(() => expect(fake.active()).toBe(1));
  instance.startForRecording('rec', file, room, () => 1000);
  await vi.waitFor(() => expect(instance.statusFor('rec')?.state).toBe('collecting'));
  for (let i = 0; i < 3; i++) {
    await instance.unsubscribePreview(room.id, token);
    fake.publish(`隐藏后${i}`);
    await vi.waitFor(async () => {
      expect((await instance.readRange('rec', file, 0, 2000)).messages).toHaveLength(i + 1);
    });
    instance.subscribePreview(room, token);
    await vi.waitFor(() => expect(instance.readPreview(room.id, token, 0).status.state).toBe('collecting'));
  }
  expect(fake.calls()).toBe(1);
  await instance.unsubscribePreview(room.id, token);
  await instance.stopForRecording('rec');
  const store = (await DanmakuStore.openExisting(file))!;
  expect((await store.readRange(0, 2000)).messages.map(m => m.text)).toEqual(['隐藏后0', '隐藏后1', '隐藏后2']);
});

it('closing preview during recording startup does not cancel the pending recording collector', async () => {
  const fake = transport();
  let resolveCookie!: (cookie: string) => void;
  const cookie = new Promise<string>(resolve => { resolveCookie = resolve; });
  const services = {
    settings: { load: () => ({ danmaku: { enabled: false } }) },
    platformCookie: vi.fn().mockResolvedValueOnce('').mockReturnValue(cookie),
    events: { emit: vi.fn() },
  } as unknown as Services;
  const instance = new DanmakuManager(services, () => fake.adapter);
  cleanup.push(() => instance.shutdown());
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-preview-startup-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rec.flv');
  instance.subscribePreview(room, token);
  await vi.waitFor(() => expect(fake.active()).toBe(1));
  instance.startForRecording('rec', file, room, () => 1000);
  await vi.waitFor(() => expect(services.platformCookie).toHaveBeenCalledTimes(2));
  await instance.unsubscribePreview(room.id, token);
  await vi.waitFor(() => expect(fake.active()).toBe(0));
  resolveCookie('');
  await vi.waitFor(() => expect(instance.statusFor('rec')?.state).toBe('collecting'));
  fake.publish('启动后仍录制');
  await vi.waitFor(async () => {
    expect((await instance.readRange('rec', file, 0, 2000)).messages).toMatchObject([{ text: '启动后仍录制' }]);
  });
  await instance.stopForRecording('rec');
  const store = (await DanmakuStore.openExisting(file))!;
  expect((await store.readRange(0, 2000)).messages).toMatchObject([{ text: '启动后仍录制' }]);
});

it('room recording preference disables persistence even while preview displays messages', async () => {
  const fake = transport(), instance = manager(fake);
  const dir = await mkdtemp(path.join(tmpdir(), 'lr-preview-disabled-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const disabledRoom = { ...room, danmakuEnabled: false };
  instance.startForRecording('rec', path.join(dir, 'rec.flv'), disabledRoom, () => 1000);
  instance.subscribePreview(disabledRoom, token);
  await vi.waitFor(() => expect(fake.active()).toBe(1));
  fake.publish('只展示');
  await vi.waitFor(() => expect(instance.readPreview(room.id, token, 0).messages).toHaveLength(1));
  expect(instance.statusFor('rec')).toBeNull();
  await instance.unsubscribePreview(room.id, token);
  expect(await readdir(dir)).toEqual([]);
});

it('rejects excess leases and can recover an expired subscription without retaining prior history', async () => {
  const fake = transport(), instance = manager(fake);
  for (let i = 0; i < 8; i++) instance.subscribePreview(room, token + i);
  expect(() => instance.subscribePreview(room, token + 'extra')).toThrow('上限');
  await instance.shutdown();
  const next = instance.subscribePreview(room, token);
  expect(next.messages).toEqual([]);
});


it('isolates a stalled consumer with bounded buffering while the recording consumer continues', async () => {
  const fake = transport(), shared = new SharedDanmakuAdapter(fake.adapter);
  const a = new AbortController(), b = new AbortController();
  const slow = shared.collect(room.url, null, a.signal)[Symbol.asyncIterator]();
  const fast = shared.collect(room.url, null, b.signal)[Symbol.asyncIterator]();
  const one = slow.next(), two = fast.next(); fake.publish('first'); await Promise.all([one, two]);
  for (let i = 0; i < 1100; i++) {
    const next = fast.next(); fake.publish(String(i)); expect((await next).value.text).toBe(String(i));
  }
  await expect(slow.next()).rejects.toThrow('积压');
  expect(fake.calls()).toBe(1); expect(fake.active()).toBe(1);
  b.abort(); await fast.return?.(); await vi.waitFor(() => expect(fake.active()).toBe(0));
});

it('propagates disconnects to both collectors and shares their next connection attempt', async () => {
  const fake = transport(), shared = new SharedDanmakuAdapter(fake.adapter);
  const a = new AbortController(), b = new AbortController();
  const first = shared.collect(room.url, null, a.signal)[Symbol.asyncIterator]();
  const second = shared.collect(room.url, null, b.signal)[Symbol.asyncIterator]();
  const one = expect(first.next()).rejects.toThrow('断连'), two = expect(second.next()).rejects.toThrow('断连');
  fake.fail(); await Promise.all([one, two]); expect(fake.active()).toBe(0);
  const retry1 = shared.collect(room.url, null, a.signal)[Symbol.asyncIterator]();
  const retry2 = shared.collect(room.url, null, b.signal)[Symbol.asyncIterator]();
  const next1 = retry1.next(), next2 = retry2.next(); fake.publish('重连');
  expect((await next1).value.text).toBe('重连'); expect((await next2).value.text).toBe('重连');
  expect(fake.calls()).toBe(2);
  a.abort(); b.abort(); await Promise.all([retry1.return?.(), retry2.return?.()]);
});
