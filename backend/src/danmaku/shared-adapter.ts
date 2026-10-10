import type { DanmakuAdapter, DanmakuMessage } from './types.js';

interface Consumer {
  queue: DanmakuMessage[];
  head: number;
  bytes: number;
  discardedBytes: number;
  wake?: (() => void) | undefined;
  error?: Error;
  ready?: (() => void) | undefined;
}
interface Connection {
  abort: AbortController;
  consumers: Set<Consumer>;
  connected: boolean;
  ended: boolean;
  error?: Error;
}
/** Share the platform connection; retry and media timestamping remain owned by DanmakuCollector. */
export class SharedDanmakuAdapter implements DanmakuAdapter {
  readonly platform: string;
  private connections = new Map<string, Connection>();
  constructor(private readonly adapter: DanmakuAdapter) { this.platform = adapter.platform; }

  async *collect(roomUrl: string, cookie: string | null, signal: AbortSignal, onConnected?: () => void): AsyncIterable<DanmakuMessage> {
    signal.throwIfAborted();
    let connection = this.connections.get(roomUrl);
    const fresh = !connection || connection.ended;
    if (fresh) {
      connection = { abort: new AbortController(), consumers: new Set(), connected: false, ended: false };
      this.connections.set(roomUrl, connection);
    }
    const current = connection!;
    const consumer: Consumer = { queue: [], head: 0, bytes: 0, discardedBytes: 0, ready: onConnected };
    current.consumers.add(consumer);
    const notify = () => { consumer.wake?.(); consumer.wake = undefined; };
    const detach = () => {
      current.consumers.delete(consumer);
      notify();
      if (!current.consumers.size) {
        current.ended = true;
        current.abort.abort();
        if (this.connections.get(roomUrl) === current) this.connections.delete(roomUrl);
      }
    };
    signal.addEventListener('abort', detach, { once: true });
    if (fresh) void this.run(roomUrl, cookie, current);
    else if (current.connected) onConnected?.();
    try {
      while (!signal.aborted) {
        if (consumer.error) throw consumer.error;
        if (consumer.head < consumer.queue.length) {
          const message = consumer.queue[consumer.head++]!;
          const bytes = Buffer.byteLength(message.text);
          consumer.bytes -= bytes; consumer.discardedBytes += bytes;
          if (consumer.head >= 256 || consumer.discardedBytes >= 256 * 1024) {
            consumer.queue.splice(0, consumer.head); consumer.head = 0; consumer.discardedBytes = 0;
          }
          yield message;
        } else if (current.ended) {
          if (current.error) throw current.error;
          return;
        } else await new Promise<void>(resolve => { consumer.wake = resolve; });
      }
    } finally {
      signal.removeEventListener('abort', detach);
      detach();
      consumer.queue = [];
    }
  }

  private async run(roomUrl: string, cookie: string | null, connection: Connection): Promise<void> {
    try {
      for await (const message of this.adapter.collect(roomUrl, cookie, connection.abort.signal, () => {
        if (connection.ended) return;
        connection.connected = true;
        for (const c of connection.consumers) c.ready?.();
      })) {
        const bytes = Buffer.byteLength(message.text);
        for (const c of connection.consumers) {
          if (c.error) continue;
          if (c.queue.length - c.head >= 1024 || c.bytes + bytes > 1024 * 1024) {
            // A slow consumer reconnects and records a gap without stalling the other consumers.
            c.error = new Error('弹幕消费积压');
          } else { c.queue.push(message); c.bytes += bytes; }
          c.wake?.(); c.wake = undefined;
        }
      }
    } catch (error) { connection.error = error instanceof Error ? error : new Error(String(error)); }
    finally {
      connection.ended = true;
      for (const c of connection.consumers) { c.wake?.(); c.wake = undefined; }
      if (this.connections.get(roomUrl) === connection) this.connections.delete(roomUrl);
    }
  }
}
