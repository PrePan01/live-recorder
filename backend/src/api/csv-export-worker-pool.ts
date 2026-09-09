import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

export type CsvExportRow = { id: string; room_id: string; platform: string; stream_title: string; state: string; started_at: string; ended_at: string | null; file_size_bytes: number | null; quality: string | null; integrity: string | null };
export type CsvFilters = { roomId?: string | undefined; state?: string | undefined; sessionId?: string | undefined; dateFrom?: string | undefined; dateTo?: string | undefined };
type Cursor = { startedAt: string; id: string } | undefined;
type Pending = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

export class CsvExportLease {
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private released = false;
  constructor(private readonly worker: Worker, private readonly done: () => void, private readonly filters: CsvFilters) {
    worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
    });
    worker.on('error', (error) => this.rejectAll(error));
    worker.on('exit', () => this.rejectAll(new Error('CSV_WORKER_EXITED')));
  }
  async start(): Promise<void> { await this.call('start'); }
  async next(cursor: Cursor): Promise<CsvExportRow[]> { return this.call('next', cursor) as Promise<CsvExportRow[]>; }
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try { await this.call('close'); } catch { /* terminating still releases the SQLite snapshot */ }
    await this.worker.terminate();
    this.done();
  }
  private call(kind: 'start' | 'next' | 'close', cursor?: Cursor): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, kind, filters: this.filters, cursor });
    });
  }
  private rejectAll(error: Error): void { for (const pending of this.pending.values()) pending.reject(error); this.pending.clear(); }
}

/** One export may hold a long read snapshot; two more callers can wait. */
export class CsvExportWorkerPool {
  private active = false;
  private waiting: Array<{ filters: CsvFilters; resolve: (lease: CsvExportLease) => void }> = [];
  constructor(private readonly databasePath: string) {}
  acquire(filters: CsvFilters): Promise<CsvExportLease> {
    if (this.waiting.length + (this.active ? 1 : 0) >= 3) return Promise.reject(new Error('CSV_QUEUE_FULL'));
    return new Promise((resolve) => { this.waiting.push({ filters, resolve }); this.pump(); });
  }
  private pump(): void {
    if (this.active) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.active = true;
    const compiled = new URL('./csv-export-worker.js', import.meta.url);
    const url = existsSync(fileURLToPath(compiled)) ? compiled : new URL('./csv-export-worker.ts', import.meta.url);
    const worker = new Worker(url, { workerData: { path: this.databasePath }, execArgv: url.pathname.endsWith('.ts') ? process.execArgv : [] });
    next.resolve(new CsvExportLease(worker, () => { this.active = false; this.pump(); }, next.filters));
  }
}
