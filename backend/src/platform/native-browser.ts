import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../types/error.js';

export interface NativeBrowserResponse { status: number; text: string }

interface NativeBrowserJob {
  url: string;
  sessionHash?: string;
  expiresAt: number;
  interactive?: boolean;
}

interface PendingJob extends NativeBrowserJob {
  delivered: boolean;
  finish: (response?: NativeBrowserResponse) => void;
}

/** A local queue for requests performed by the desktop's website session. */
export class NativeBrowserBroker {
  private heartbeat = 0;
  private closed = false;
  private pending = new Map<string, PendingJob>();

  constructor(
    private readonly accepts: (url: string) => boolean,
    private readonly unavailable: () => AppError,
    private readonly incomplete: () => AppError,
    private readonly timeoutMs = 45_000,
    private readonly deliveryLimit = 8,
  ) {}

  request(url: string, signal?: AbortSignal, sessionHash?: string, interactive = false): Promise<NativeBrowserResponse> {
    if (this.closed || !this.accepts(url) || signal?.aborted ||
        Date.now() - this.heartbeat > 5000 || this.pending.size >= 8) {
      return Promise.reject(this.unavailable());
    }
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const finish = (response?: NativeBrowserResponse) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (response) resolve(response);
        else reject(this.incomplete());
      };
      const abort = () => finish();
      const timer = setTimeout(abort, this.timeoutMs);
      this.pending.set(id, {
        url, ...(sessionHash ? { sessionHash } : {}), ...(interactive ? { interactive } : {}),
        expiresAt: Date.now() + this.timeoutMs, delivered: false, finish,
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  activeRequestIds(): string[] { return [...this.pending.keys()]; }

  take(): Array<NativeBrowserJob & { id: string }> {
    this.heartbeat = Date.now();
    const available = this.deliveryLimit - [...this.pending.values()].filter(job => job.delivered).length;
    const queue = [...this.pending].filter(([, job]) => !job.delivered)
      .sort(([, a], [, b]) => Number(Boolean(b.interactive)) - Number(Boolean(a.interactive)));
    return queue.slice(0, Math.max(0, available)).map(([id, job]) => {
      job.delivered = true;
      return { id, url: job.url, expiresAt: job.expiresAt, ...(job.sessionHash ? { sessionHash: job.sessionHash } : {}) };
    });
  }

  complete(id: string, response?: NativeBrowserResponse): void { this.pending.get(id)?.finish(response); }

  close(): void {
    this.closed = true;
    for (const job of this.pending.values()) job.finish();
  }
}

export function registerNativeBrowserRoutes(app: FastifyInstance, platform: string, broker: NativeBrowserBroker): void {
  const endpoint = `/api/v1/platform/${platform}/native-requests`;
  app.get(endpoint, async () => ({ requests: broker.take(), activeRequestIds: broker.activeRequestIds() }));
  app.post(`${endpoint}/:id`, { bodyLimit: 2 * 1024 * 1024 }, async req => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<NativeBrowserResponse> | null;
    if (body && Number.isInteger(body.status) && typeof body.text === 'string' && Buffer.byteLength(body.text) <= 1024 * 1024) {
      broker.complete(id, { status: body.status!, text: body.text });
    } else broker.complete(id);
    return { ok: true };
  });
  app.addHook('preClose', async () => broker.close());
}
