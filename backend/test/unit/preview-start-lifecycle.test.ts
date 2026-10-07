import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { attachWebSocketUpgrade, PreviewManager } from '../../src/api/websocket.js';
import type { Services } from '../../src/core/services.js';

async function setup() {
  let finishStart!: () => void;
  const starting = new Promise<void>((resolve) => { finishStart = resolve; });
  const stop = vi.fn(async () => {});
  const services = {
    rooms: { get: () => ({ id: 'hover-room', monitorState: 'idle', lastLiveStatus: 'live' }) },
    manager: { ensurePreviewStream: () => starting, stopPreviewStream: stop },
  } as unknown as Services;
  const server = createServer();
  const preview = new PreviewManager(services);
  const sockets: WebSocket[] = [];
  const binding = attachWebSocketUpgrade(services, preview, server, [], () => {
    const address = server.address();
    return typeof address === 'object' && address ? address.port : 0;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return {
    stop, finishStart,
    async connect() {
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/preview/hover-room`);
      sockets.push(socket);
      await once(socket, 'open');
      return socket;
    },
    async close() {
      finishStart();
      for (const socket of sockets) socket.terminate();
      preview.closeAll(1000);
      binding.dispose();
      await new Promise<void>((resolve) => binding.wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('preview startup after a hover has ended', () => {
  it('stops a late-starting stream when its viewer has already left', async () => {
    const fixture = await setup();
    try {
      const socket = await fixture.connect();
      socket.close();
      await once(socket, 'close');
      fixture.finishStart();
      await vi.waitFor(() => expect(fixture.stop).toHaveBeenCalledWith('hover-room'));
    } finally { await fixture.close(); }
  });

  it('keeps the stream when another viewer still uses the same room', async () => {
    const fixture = await setup();
    try {
      const first = await fixture.connect();
      await fixture.connect();
      first.close();
      await once(first, 'close');
      fixture.finishStart();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(fixture.stop).not.toHaveBeenCalled();
    } finally { await fixture.close(); }
  });
});
