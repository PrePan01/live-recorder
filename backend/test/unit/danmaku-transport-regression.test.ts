import { afterEach, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
const mock = vi.hoisted(() => ({ sockets: [] as Array<EventEmitter & { terminated: boolean; readyState: number }> }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1; readyState = 0; terminated = false;
    constructor() { super(); mock.sockets.push(this); }
    terminate() { this.terminated = true; this.readyState = 3; queueMicrotask(() => { this.emit('error', new Error('terminated')); this.emit('close'); }); }
  } };
});
import { platformFetch, socketTextStream } from '../../src/danmaku/adapters/transport.js';
afterEach(() => { mock.sockets = []; vi.useRealTimers(); vi.unstubAllGlobals(); });
it('aborts a connecting socket and clears all retry/heartbeat timers and listeners', async () => {
  vi.useFakeTimers(); const controller = new AbortController();
  const stream = socketTextStream('wss://test', {}, controller.signal, { open: () => undefined, frame: () => [], heartbeat: () => undefined })[Symbol.asyncIterator]();
  const pending = stream.next(); const socket = mock.sockets[0]!;
  controller.abort(); expect(await pending).toMatchObject({ done: true });
  await Promise.resolve(); expect(socket.terminated).toBe(true); expect(socket.listenerCount('message')).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it('reports a quiet ready connection and terminates the socket when a consumer returns', async () => {
  const connected = vi.fn(), controller = new AbortController();
  const stream = socketTextStream('wss://test', {}, controller.signal, { open: (_socket, ready) => ready(), frame: () => ['hello'], heartbeat: () => undefined }, connected)[Symbol.asyncIterator]();
  const pending = stream.next(), socket = mock.sockets[0]!;
  socket.readyState = 1; socket.emit('open'); expect(connected).toHaveBeenCalledTimes(1);
  socket.emit('message', Buffer.from('frame')); expect((await pending).value?.text).toBe('hello');
  await stream.return?.(); expect(socket.terminated).toBe(true);
});
it('does not issue an HTTP request for a pre-aborted platform lookup', () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const controller = new AbortController(); controller.abort();
  expect(() => platformFetch('https://test', {}, controller.signal)).toThrow(); expect(fetch).not.toHaveBeenCalled();
});
