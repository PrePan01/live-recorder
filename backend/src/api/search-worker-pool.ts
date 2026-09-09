import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SearchType, SearchResultItem } from './routes/search.js';

export interface WorkerSearchOutcome { items: SearchResultItem[]; total: number; page: number; pageSize: number; timeout: boolean }
export interface WorkerSearchOptions { q: string; type?: SearchType; tagId?: string; from?: string; to?: string; page?: number; pageSize?: number }
type Job = { id: number; options: WorkerSearchOptions; resolve: (value: WorkerSearchOutcome) => void; reject: (reason: Error) => void; signal?: AbortSignal | undefined; abort?: (() => void) | undefined };

/** One reusable read-only SQLite worker; at most eight requests wait behind it. */
export class SearchWorkerPool {
  private worker: Worker | null = null;
  private running: Job | null = null;
  private queue: Job[] = [];
  private seq = 0;
  constructor(private readonly databasePath: string) {}

  search(options: WorkerSearchOptions, signal?: AbortSignal): Promise<WorkerSearchOutcome> {
    if (this.queue.length + (this.running ? 1 : 0) >= 9) return Promise.reject(new Error('SEARCH_QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.seq, options, resolve, reject, ...(signal ? { signal } : {}) };
      const cancel = () => this.cancel(job);
      job.abort = cancel;
      if (signal?.aborted) { reject(new Error('SEARCH_CANCELLED')); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      this.queue.push(job);
      this.pump();
    });
  }

  close(): void { void this.worker?.terminate(); this.worker = null; }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const compiled = new URL('./search-worker.js', import.meta.url);
    // `tsx` development executes source modules directly; packaged builds use
    // the compiled sibling. Keep the worker usable in both environments.
    const workerUrl = existsSync(fileURLToPath(compiled)) ? compiled : new URL('./search-worker.ts', import.meta.url);
    const worker = new Worker(workerUrl, { workerData: { path: this.databasePath }, execArgv: workerUrl.pathname.endsWith('.ts') ? process.execArgv : [] });
    worker.on('message', (message: { id: number; result?: WorkerSearchOutcome; error?: string }) => {
      const job = this.running;
      if (!job || job.id !== message.id) return;
      this.running = null;
      message.result ? job.resolve(message.result) : job.reject(new Error(message.error ?? 'SEARCH_WORKER_FAILED'));
      this.pump();
    });
    worker.on('error', (error) => { this.running?.reject(error); this.running = null; if (this.worker === worker) this.worker = null; this.pump(); });
    worker.on('exit', () => { if (this.worker === worker) this.worker = null; });
    this.worker = worker;
    return worker;
  }

  private pump(): void {
    if (this.running) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    const worker = this.ensureWorker();
    const timeout = setTimeout(() => {
      if (this.running?.id !== job.id) return;
      this.running = null;
      job.reject(new Error('SEARCH_TIMEOUT'));
      void worker.terminate();
      this.worker = null;
      this.pump();
    }, 3_000);
    const originalResolve = job.resolve;
    const originalReject = job.reject;
    job.resolve = (value) => { clearTimeout(timeout); job.signal?.removeEventListener('abort', job.abort!); originalResolve(value); };
    job.reject = (reason) => { clearTimeout(timeout); job.signal?.removeEventListener('abort', job.abort!); originalReject(reason); };
    worker.postMessage({ id: job.id, opts: job.options });
  }

  private cancel(job: Job): void {
    const queued = this.queue.indexOf(job);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      job.reject(new Error('SEARCH_CANCELLED'));
      return;
    }
    if (this.running?.id === job.id) {
      this.running = null;
      job.reject(new Error('SEARCH_CANCELLED'));
      void this.worker?.terminate();
      this.worker = null;
      this.pump();
    }
  }
}
