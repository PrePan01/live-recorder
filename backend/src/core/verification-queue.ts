import { statSync } from 'node:fs';
import type { Recording } from '../types/index.js';
import type { Services } from './services.js';
import { checkFileIntegrityDetailed } from '../recorder/integrity.js';
import { AppError } from '../types/error.js';

interface VerifyJob {
  recordingId: string;
  filePath: string;
  key: string;
  createdAt: string;
}

const VERIFY_CONCURRENCY = 2;
const VERIFY_TTL_MS = 10 * 60_000;

/**
 * 完整性校验队列：收尾/启动恢复/手动重试三个入口共用。
 * 幂等键=文件路径+修改时间（同一文件不重复入队）；新录优先；单任务超时兜底（不永挂）。
 */
export class VerificationQueue {
  private queue: VerifyJob[] = [];
  private keys = new Set<string>();
  private active = 0;

  constructor(private services: Services) {}

  positionOf(recordingId: string): number | null {
    const idx = this.queue.findIndex((job) => job.recordingId === recordingId);
    return idx >= 0 ? idx + 1 : null;
  }

  enqueue(rec: Recording): boolean {
    if (!rec.filePath) return false;
    let mtime = 0;
    try {
      mtime = statSync(rec.filePath).mtimeMs;
    } catch {
      // 文件可能已被删除/卷未挂载：仍然允许以 0 修正一次（缺文件会得到 failed）。
    }
    const key = `${rec.filePath}|${mtime}`;
    if (this.keys.has(key)) return false;
    this.keys.add(key);
    this.queue.push({ recordingId: rec.id, filePath: rec.filePath, key, createdAt: rec.createdAt });
    // 新录优先：用户正在等的先校验，历史积压垫后。
    this.queue.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    this.services.recordings.update(rec.id, { integrityState: 'queued' } as never);
    // 排队态变化也实时上屏（与其余校验态同口径配对事件）。
    this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(rec.id)! });
    console.log(`[verify] 入队 ${rec.id}（第 ${this.positionOf(rec.id)} 位）`);
    this.pump();
    return true;
  }

  /** 启动恢复：把被打断/从未校验过的记录全部重新入队（不设年龄阈值，全量捡起）。 */
  requeuePending(): number {
    const rows = this.services.recordings.list({ pageSize: 100000, page: 1 }).items;
    let count = 0;
    for (const rec of rows) {
      const state = (rec as { integrityState?: string | null }).integrityState;
      const stale = state == null || state === 'pending' || state === 'queued' || state === 'verifying';
      if (stale && this.enqueue(rec)) count += 1;
    }
    return count;
  }

  private pump(): void {
    while (this.active < VERIFY_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async run(job: VerifyJob): Promise<void> {
    let settled = false;
    const ttl = this.services.clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      this.keys.delete(job.key);
      this.services.recordings.update(job.recordingId, {
        integrityState: 'unverifiable',
        integrityError: '校验超时，可重试',
      } as never);
      console.log(`[verify] 超时未完成 ${job.recordingId}`);
      this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(job.recordingId)! });
    }, VERIFY_TTL_MS);
    try {
      const prev = this.services.recordings.get(job.recordingId);
      this.services.recordings.update(job.recordingId, {
        integrityState: 'verifying',
        integrityAttempts: ((prev as { integrityAttempts?: number } | null)?.integrityAttempts ?? 0) + 1,
        integrityLastAttempt: this.services.clock.iso(),
      } as never);
      this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(job.recordingId)! });
      const { outcome, detail } = await checkFileIntegrityDetailed(job.filePath);
      if (settled) return;
      settled = true;
      const state = outcome === 'ok' ? 'ok' : outcome === 'failed' ? 'failed' : 'unverifiable';
      const legacy = outcome === 'ok' ? 'verified' : outcome === 'failed' ? 'failed' : 'pending';
      this.services.recordings.update(job.recordingId, {
        integrity: legacy,
        integrityState: state,
        integrityError: outcome === 'ok' ? null : detail,
      } as never);
      console.log(`[verify] ${job.recordingId} → ${state}${detail ? `（${detail}）` : ''}`);
      if (outcome === 'failed') {
        this.services.alerts.createOrRefresh({
          level: 'warning',
          source: 'recorder',
          message: '录制文件校验失败，可能损坏或截断',
          occurredAt: this.services.clock.iso(),
          roomId: this.services.recordings.get(job.recordingId)?.roomId ?? null,
          errorCode: 'RECORDING_FILE_CORRUPTED',
          retryable: false,
        });
      }
      this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(job.recordingId)! });
    } catch (error) {
      if (settled) return;
      settled = true;
      this.services.recordings.update(job.recordingId, {
        integrityState: 'unverifiable',
        integrityError: error instanceof AppError ? error.message : '校验异常，可重试',
      } as never);
      this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(job.recordingId)! });
    } finally {
      this.services.clock.clearTimeout(ttl);
      this.keys.delete(job.key);
    }
  }
}
