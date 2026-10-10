import { afterEach, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { douyinDanmakuAdapter } from '../../src/danmaku/adapters/douyin.js';
import { fields, parseFetchResponse, parsePushFrame } from '../../src/danmaku/adapters/douyin-protocol.js';
const vint = (value: bigint) => {
  const bytes: number[] = [];
  do { bytes.push(Number(value & 127n) | (value > 127n ? 128 : 0)); value >>= 7n; } while (value);
  return Buffer.from(bytes);
};
const integer = (key: number, value: bigint) => Buffer.concat([vint(BigInt(key * 8)), vint(value)]);
const field = (key: number, value: Buffer | string) => { const data = Buffer.from(value); return Buffer.concat([vint(BigInt(key * 8 + 2)), vint(BigInt(data.length)), data]); };
const chat = (id: bigint, text: string) => field(1, Buffer.concat([field(1, 'WebcastChatMessage'), field(2, field(3, text)), integer(3, id)]));
const page = (cursor: string, messages = Buffer.alloc(0), interval = 1000n) => Buffer.concat([messages, field(2, cursor), integer(3, interval), field(5, 'server-state')]);
const response = (data: Buffer) => new Response(new Uint8Array(data), { headers: { 'content-type': 'application/protobuffer' } });
const cookie = 'ttwid=guest; sessionid=secret';
const room = 'https://live.douyin.com/123';
const enter = () => new Response(JSON.stringify({ status_code: 0, data: { data: [{ id_str: '7694320472611228431', status: 2 }] } }));
afterEach(() => vi.unstubAllGlobals());

it('decodes pull responses with exact 64-bit message IDs and reuses the websocket chat decoder', () => {
  const id = 7694320472611228431n, payload = page('cursor-1', chat(id, '聊天'));
  const decoded = parseFetchResponse(gzipSync(payload));
  expect(decoded).toMatchObject({ messages: [{ id: String(id), text: '聊天' }], cursor: 'cursor-1', internalExt: 'server-state', intervalMs: 1000 });
  expect(parsePushFrame(field(8, payload)).texts).toEqual(['聊天']);
  expect(parseFetchResponse(page('c', Buffer.alloc(0), 0n)).intervalMs).toBe(1000);
  expect(parseFetchResponse(page('c', Buffer.alloc(0), 999999n)).intervalMs).toBe(10000);
  expect(() => parseFetchResponse(Buffer.from('{"status_code":8}'))).toThrow();
  expect(() => parseFetchResponse(field(1, Buffer.alloc(0)))).toThrow('游标');
});

it('uses the supported pull endpoint without im/info or websocket discovery and carries cursor/state incrementally', async () => {
  const urls: URL[] = [];
  let requests = 0;
  const fetch = vi.fn(async (url: string) => {
    const parsed = new URL(url); urls.push(parsed);
    if (parsed.pathname.includes('/enter/')) return enter();
    requests++;
    return response(requests === 1 ? page('first', chat(100n, '第一条')) : page('second', Buffer.concat([chat(100n, '第一条'), chat(101n, '第二条')])));
  });
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController(), connected = vi.fn();
  const stream = douyinDanmakuAdapter.collect(room, cookie, controller.signal, connected)[Symbol.asyncIterator]();
  expect((await stream.next()).value).toMatchObject({ id: 'douyin:7694320472611228431:100', text: '第一条' });
  expect(connected).toHaveBeenCalledTimes(1);
  const next = await stream.next();
  expect(next.value?.text).toBe('第二条'); // repeated message in the next page is excluded
  expect(urls.map(url => url.pathname)).toEqual(['/webcast/room/web/enter/', '/webcast/im/fetch/', '/webcast/im/fetch/']);
  expect(urls[2]!.searchParams.get('cursor')).toBe('first');
  expect(urls[2]!.searchParams.get('internal_ext')).toBe('server-state');
  expect(urls[1]!.searchParams.get('room_id')).toBe('7694320472611228431');
  expect(urls[1]!.searchParams.get('resp_content_type')).toBe('protobuf');
  expect(urls[2]!.searchParams.get('user_unique_id')).toBe(urls[1]!.searchParams.get('user_unique_id'));
  const pending = stream.next(); controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(requests).toBe(2);
});

it('marks a quiet valid connection collecting, respects server pacing and cancels the wait immediately', async () => {
  const fetch = vi.fn(async (url: string) => url.includes('/enter/') ? enter() : response(page('quiet', Buffer.alloc(0), 10000n)));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  let ready!: () => void;
  const connected = new Promise<void>(resolve => { ready = resolve; });
  const stream = douyinDanmakuAdapter.collect(room, cookie, controller.signal, ready)[Symbol.asyncIterator]();
  const pending = stream.next();
  await connected;
  await new Promise(resolve => setImmediate(resolve));
  expect(fetch).toHaveBeenCalledTimes(2);
  const started = Date.now(); controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(Date.now() - started).toBeLessThan(500);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('fails oversized, malformed and unsuccessful responses instead of reporting a fake connection', async () => {
  for (const bad of [new Response('failure', { status: 429 }), new Response('{"status_code":8}'), new Response(new Uint8Array(4 * 1024 * 1024 + 1))]) {
    const connected = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/enter/') ? enter() : bad));
    const controller = new AbortController();
    const stream = douyinDanmakuAdapter.collect(room, cookie, controller.signal, connected)[Symbol.asyncIterator]();
    await expect(stream.next()).rejects.toThrow();
    expect(connected).not.toHaveBeenCalled();
  }
});

it('aborts a pending network read without dispatching another request', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url.includes('/enter/')) return enter();
    return new Promise<Response>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
  }));
  const controller = new AbortController(), stream = douyinDanmakuAdapter.collect(room, cookie, controller.signal)[Symbol.asyncIterator]();
  const pending = stream.next();
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
