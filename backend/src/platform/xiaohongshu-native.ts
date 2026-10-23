import { randomUUID } from 'node:crypto';
import { AppError } from '../types/error.js';
import type { FastifyInstance } from 'fastify';

export interface XhsNativeResponse { status: number; text: string }
const PATHS = new Map([
  ['/api/sns/web/v1/user/selfinfo', 'edith.xiaohongshu.com'],
  ['/api/sns/web/v1/user/otherinfo', 'edith.xiaohongshu.com'],
  ['/api/sns/web/v1/user/hover_card', 'edith.xiaohongshu.com'],
  ['/api/sns/red/live/h5/v1/interaction/get_simple_interaction', 'live-room.xiaohongshu.com'],
  ['/api/sns/red/live/h5/v1/core/current_live_status', 'live-room.xiaohongshu.com'],
]);
export function isXhsNativeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && PATHS.get(url.pathname) === url.hostname;
  } catch { return false; }
}

/** Local desktop transport only. Native WebView owns its cookies and website signer. */
export class XiaohongshuNativeBroker {
  private heartbeat = 0;
  private closed = false;
  private pending = new Map<string, { url: string; sessionHash?: string; expiresAt: number; delivered: boolean; finish: (result?: XhsNativeResponse) => void }>();
  request(url: string, signal?: AbortSignal, sessionHash?: string): Promise<XhsNativeResponse> {
    if (this.closed || !isXhsNativeUrl(url) || signal?.aborted || Date.now() - this.heartbeat > 5000 || this.pending.size >= 8) {
      return Promise.reject(new AppError('PLATFORM_ACCESS_RESTRICTED', '请在桌面客户端登录小红书后重试', { retryable: true }));
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = (result?: XhsNativeResponse) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (result) resolve(result);
        else reject(new AppError('NETWORK_UNAVAILABLE', '小红书官网请求未完成，请稍后重试', { retryable: true }));
      };
      const abort = () => finish();
      const timer = setTimeout(abort, 45000);
      this.pending.set(id, { url, ...(sessionHash ? { sessionHash } : {}), expiresAt: Date.now() + 45000, delivered: false, finish });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  activeRequestIds(): string[] { return [...this.pending.keys()]; }
  take(): Array<{ id: string; url: string; sessionHash?: string; expiresAt: number }> {
    this.heartbeat = Date.now();
    const result = [];
    for (const [id, item] of this.pending) {
      if (!item.delivered) { item.delivered = true; result.push({ id, url: item.url, expiresAt: item.expiresAt, ...(item.sessionHash ? { sessionHash: item.sessionHash } : {}) }); }
    }
    return result;
  }
  complete(id: string, response?: XhsNativeResponse): void { this.pending.get(id)?.finish(response); }
  close(): void { this.closed = true; for (const item of [...this.pending.values()]) item.finish(); }
}

export function registerXhsNativeRoutes(app: FastifyInstance, broker: XiaohongshuNativeBroker): void {
  app.get('/api/v1/platform/xiaohongshu/native-requests', async () => ({ requests: broker.take(), activeRequestIds: broker.activeRequestIds() }));
  app.post('/api/v1/platform/xiaohongshu/native-requests/:id', { bodyLimit: 2 * 1024 * 1024 }, async req => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<XhsNativeResponse> | null;
    if (body && Number.isInteger(body.status) && typeof body.text === 'string' && Buffer.byteLength(body.text) <= 1024 * 1024) {
      broker.complete(id, { status: body.status!, text: body.text });
    } else broker.complete(id);
    return { ok: true };
  });
  app.addHook('preClose', async () => broker.close());
}
