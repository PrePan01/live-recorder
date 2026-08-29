import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import type { Services } from '../core/services.js';
import type { AppEvent } from '../core/events.js';

export class SSEBroadcaster {
  private clients = new Set<ServerResponse>();
  private unsubscribe: (() => void) | null = null;

  start(services: Services): void {
    if (this.unsubscribe) return;
    this.unsubscribe = services.events.on((event) => this.dispatch(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  private dispatch(event: AppEvent): void {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}

export function registerSse(app: FastifyInstance, services: Services, broadcaster: SSEBroadcaster): void {
  app.get('/api/v1/events', (req, reply) => {
    broadcaster.start(services);
    // 跨域 EventSource（Tauri WebView http://tauri.localhost / 浏览器 dev origin）必须回 CORS 头，
    // 否则浏览器/WebView 会拦截 SSE 连接，导致前端拿不到实时事件。
    // 注意：hijack 后 addClient 直接 writeHead，会覆盖 reply 对象上的 CORS 头，所以在此先写到原始响应。
    const origin = req.headers.origin;
    if (origin) {
      reply.raw.setHeader('Access-Control-Allow-Origin', origin);
      reply.raw.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      reply.raw.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      reply.raw.setHeader('Vary', 'Origin');
    }
    reply.hijack();
    broadcaster.addClient(reply.raw);
  });
}
