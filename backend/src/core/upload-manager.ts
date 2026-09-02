import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import type { Services } from './services.js';
import type { OpenListConfig, UploadJob } from '../types/index.js';
import { UploadRepository } from '../db/repositories/upload.repo.js';
import { OPENLIST_TOKEN_KEY } from '../security/keys.js';

export interface WebDavClient {
  put(remotePath: string, localPath: string, username: string, token: string, onProgress: (pct: number) => void): Promise<void>;
}

/** 真实 WebDAV 上传：PUT 直传 OpenList（HTTP 基本认证，令牌作密码）。 */
export class RealWebDavClient implements WebDavClient {
  async put(remotePath: string, localPath: string, username: string, token: string, onProgress: (pct: number) => void): Promise<void> {
    const size = statSync(localPath).size;
    const res = await fetch(remotePath, {
      method: 'PUT',
      headers: {
        Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
      },
      body: createReadStream(localPath),
      // Node >=18 undici fetch 发送流 body 必须带 duplex: 'half'，否则抛「duplex option is required when sending a body」。
      duplex: 'half',
      signal: AbortSignal.timeout(300_000),
    });
    onProgress(100);
    if (!res.ok) throw new Error(`WebDAV PUT ${res.status}`);
  }
}

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/**
 * OpenList 自动上传（V5 Batch2 #116）：上传队列、进度、重试、取消。
 * 令牌进 SecretStore（OPENLIST_TOKEN_KEY）不落盘；远端对象用 recordingId 幂等键，失败不删本地原件。
 */
export class UploadManager {
  private queue: string[] = [];
  private running = new Set<string>();
  private repo: UploadRepository;
  private client: WebDavClient;

  constructor(private services: Services, client?: WebDavClient) {
    this.repo = new UploadRepository(services.db);
    this.client = client ?? new RealWebDavClient();
  }

  get uploadRepo(): UploadRepository {
    return this.repo;
  }

  /**
   * 启动恢复（#195）：DB 中 queued/running 的上传任务重新入队续传——上传队列为内存态，重启后不恢复会永远停在排队。
   * running=上次进程中断于上传中（PUT 被中止），改为 queued 重传（WebDAV PUT 覆盖幂等）；随后 pump 串行执行。
   */
  resumePending(): number {
    const pending = this.repo.list({ limit: 1000 }).filter((j) => j.status === 'queued' || j.status === 'running');
    for (const job of pending) {
      if (job.status === 'running') {
        this.repo.update(job.id, { status: 'queued', error: '上次上传中断，已重新排队' });
      }
      this.queue.push(job.id);
    }
    if (pending.length > 0) this.pump();
    return pending.length;
  }

  async config(): Promise<OpenListConfig | null> {
    const settings = this.services.settings.load();
    const stored = settings?.openlist as Partial<OpenListConfig> | undefined;
    if (!stored) return null;
    const hasToken = await this.services.secretStore.has(OPENLIST_TOKEN_KEY);
    return { enabled: false, serverUrl: '', directoryTemplate: '{room}/{date}', username: '', hasToken, ...stored };
  }

  /** 录制完成时入队上传（openlist.enabled 且令牌已配置时）。 */
  async enqueue(recordingId: string): Promise<UploadJob | null> {
    const config = await this.config();
    if (!config?.enabled || !config.hasToken || !config.serverUrl) return null;
    const rec = this.services.recordings.get(recordingId);
    if (!rec || !rec.filePath) return null;
    const existing = this.repo.jobForRecording(recordingId);
    // 幂等：recording 已有上传任务（任何状态，含 ok/failed/cancelled）→ 直接返回既有 job，不新建。
    if (existing) return existing;
    // 原子幂等（QA #178）：INSERT OR IGNORE——并发窗口内对方已插入同 idempotency_key 时返回 null，
    // 回查既有 job，绝不抛 UNIQUE 500。
    const created = this.repo.create({ recordingId, idempotencyKey: `rec_${recordingId}` });
    if (!created) return this.repo.jobForRecording(recordingId);
    this.queue.push(created.id);
    this.services.events.emit({ type: 'upload:updated', data: created });
    void this.pump();
    return created;
  }

  async retry(jobId: string): Promise<UploadJob | null> {
    const job = this.repo.get(jobId);
    if (!job) return null;
    if (job.status === 'queued' || job.status === 'running') return job;
    this.repo.update(jobId, { status: 'queued', error: null });
    this.queue.push(jobId);
    void this.pump();
    return this.repo.get(jobId);
  }

  cancel(jobId: string): UploadJob | null {
    const job = this.repo.get(jobId);
    if (!job) return null;
    this.queue = this.queue.filter((id) => id !== jobId);
    if (this.running.has(jobId)) {
      this.repo.update(jobId, { status: 'cancelled', progress: job.progress });
    } else {
      this.repo.update(jobId, { status: 'cancelled' });
    }
    return this.repo.get(jobId);
  }

  private async pump(): Promise<void> {
    if (this.running.size > 0) return; // 单并发，避免重入风暴
    while (this.queue.length > 0) {
      const jobId = this.queue.shift()!;
      if (this.running.has(jobId)) continue;
      this.running.add(jobId);
      await this.run(jobId);
      this.running.delete(jobId);
    }
  }

  private async run(jobId: string): Promise<void> {
    const job = this.repo.get(jobId);
    if (!job) return;
    const rec = this.services.recordings.get(job.recordingId);
    const config = await this.config();
    if (!rec || !rec.filePath || !config || !config.serverUrl) {
      this.repo.update(jobId, { status: 'failed', error: '配置或文件缺失' });
      this.emit(jobId);
      return;
    }
    const token = await this.services.secretStore.get(OPENLIST_TOKEN_KEY);
    if (!token) {
      this.repo.update(jobId, { status: 'failed', error: 'OpenList 令牌未配置' });
      this.emit(jobId);
      return;
    }
    const remotePath = this.resolveRemotePath(config, rec.filePath, rec);
    this.repo.update(jobId, { status: 'running', progress: 0, remotePath });
    this.emit(jobId);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        await this.client.put(remotePath, rec.filePath, config.username, token, (pct) => this.repo.update(jobId, { progress: pct }));
        this.repo.update(jobId, { status: 'ok', progress: 100, retryCount: attempt, error: null });
        this.emit(jobId);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : '上传失败';
        if (attempt < MAX_RETRIES) {
          this.repo.update(jobId, { status: 'queued', retryCount: attempt + 1, error: message });
          await this.delay(RETRY_DELAYS_MS[attempt] ?? 5_000);
        } else {
          this.repo.update(jobId, { status: 'failed', retryCount: attempt + 1, error: message });
          this.emit(jobId);
        }
      }
    }
  }

  private resolveRemotePath(config: OpenListConfig, localPath: string, rec: { roomId: string; roomName: string; platform: string; startedAt?: string }): string {
    // 日期取录制 startedAt（YYYY-MM-DD），与命名规则 {date} 一致；文件基名形如 20260902_122631 无法直接 slice 出日期。
    const date = (rec.startedAt ?? path.basename(localPath)).slice(0, 10);
    const dir = (config.directoryTemplate ?? '{room}/{date}')
      .replaceAll('{room}', (rec.roomName || rec.roomId).replace(/[\\/:*?"<>|]/g, '_'))
      .replaceAll('{date}', date)
      .replaceAll('{platform}', rec.platform)
      .replaceAll('{roomId}', rec.roomId);
    // 仅去除 serverUrl 尾部斜杠后直接拼接；不做全局 /\/+/ 折叠（会把 http:// 压成 http:/）。
    return `${config.serverUrl.replace(/\/+$/, '')}/${dir}/${path.basename(localPath)}`;
  }

  private emit(jobId: string): void {
    const job = this.repo.get(jobId);
    if (job) this.services.events.emit({ type: 'upload:updated', data: job });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.services.clock.setTimeout(() => resolve(), ms));
  }
}