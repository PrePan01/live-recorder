import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import type { DanmakuMessage } from '../types.js';

export function platformFetch(url: string, options: RequestInit, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  return fetch(url, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
}
export interface SocketProtocol {
  open(ws: WebSocket, ready: () => void): void;
  frame(data: Buffer, ws: WebSocket, ready: () => void): string[];
  heartbeat(ws: WebSocket): void;
}
/** Own all listeners/timers and bound messages waiting for the async consumer. */
export async function* socketTextStream(
  url: string, headers: Record<string, string>, signal: AbortSignal,
  protocol: SocketProtocol, onConnected?: () => void,
): AsyncIterable<DanmakuMessage> {
  signal.throwIfAborted();
  const ws = new WebSocket(url, { headers, handshakeTimeout: 10000, maxPayload: 1024 * 1024 });
  const queue: DanmakuMessage[] = [];
  let head = 0, bytes = 0, finished = false, error: Error | null = null;
  let wake: (() => void) | undefined;
  let readyOnce = false, lastReceive = Date.now();
  let seq = 0;
  const prefix = randomUUID();
  const notify = () => { wake?.(); wake = undefined; };
  const finish = (reason?: Error) => {
    if (finished) return;
    finished = true; error = reason ?? null; notify();
    // terminate also closes a socket stuck in CONNECTING.
    ws.terminate();
  };
  const connectTimer = setTimeout(() => finish(new Error('弹幕连接确认超时')), 10000);
  connectTimer.unref?.();
  const ready = () => {
    if (readyOnce || finished) return;
    readyOnce = true; clearTimeout(connectTimer); onConnected?.();
  };
  const aborted = () => finish();
  const opened = () => { try { protocol.open(ws, ready); } catch (e) { finish(e as Error); } };
  const received = (data: RawData) => {
    if (finished) return;
    lastReceive = Date.now();
    try {
      const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      for (const text of protocol.frame(buffer, ws, ready)) {
        if (!text || Buffer.byteLength(text) > 16000) continue;
        bytes += Buffer.byteLength(text);
        if (queue.length - head >= 2048 || bytes > 1024 * 1024) {
          finish(new Error('弹幕接收积压')); return;
        }
        queue.push({ id: `${prefix}-${++seq}`, tMs: null, wallMs: Date.now(), text });
      }
      notify();
    } catch (e) { finish(e as Error); }
  };
  const closed = () => finish();
  const errored = (e: Error) => finish(e);
  ws.on('open', opened); ws.on('message', received); ws.on('close', closed); ws.on('error', errored);
  signal.addEventListener('abort', aborted, { once: true });
  if (signal.aborted) aborted();
  const heartbeat = setInterval(() => {
    if (finished) return;
    if (Date.now() - lastReceive > 90000) { finish(new Error('弹幕连接无响应')); return; }
    if (ws.readyState === WebSocket.OPEN) {
      try { protocol.heartbeat(ws); } catch (e) { finish(e as Error); }
    }
  }, 20000);
  heartbeat.unref?.();
  try {
    while (!finished || head < queue.length) {
      if (signal.aborted) break;
      if (head === queue.length) { await new Promise<void>(resolve => { wake = resolve; }); continue; }
      const message = queue[head++]!; bytes -= Buffer.byteLength(message.text);
      if (head >= 512) { queue.splice(0, head); head = 0; }
      yield message;
    }
    if (error && !signal.aborted) throw error;
  } finally {
    clearTimeout(connectTimer); clearInterval(heartbeat);
    signal.removeEventListener('abort', aborted);
    finish();
    ws.off('open', opened); ws.off('message', received); ws.off('close', closed);
    // Keep the error handler until the socket actually closes after terminate.
    ws.once('close', () => ws.off('error', errored));
  }
}
