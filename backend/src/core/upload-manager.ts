import { createReadStream, statSync } from 'node:fs';
import { Transform } from 'node:stream';
import path from 'node:path';
import type { Services } from './services.js';
import type { OpenListConfig, UploadJob } from '../types/index.js';
import { UploadRepository } from '../db/repositories/upload.repo.js';
import { OPENLIST_TOKEN_KEY } from '../security/keys.js';

export interface WebDavClient {
  put(remotePath: string, localPath: string, username: string, token: string, onProgress: (pct: number) => void, serverUrl?: string): Promise<void>;
}

/** 真实 WebDAV 上传：PUT 直传 OpenList（HTTP 基本认证，令牌作密码）。 */
export class RealWebDavClient implements WebDavClient {
  private ensuredCollections = new Set<string>();

  private async ensureParentCollections(remotePath: string, authorization: string, serverUrl?: string): Promise<void> {
    const target = new URL(remotePath);
    const parentParts = target.pathname.split('/').filter(Boolean).slice(0, -1);
    const baseParts = serverUrl ? new URL(serverUrl).pathname.split('/').filter(Boolean) : [];
    const parts = parentParts.slice(baseParts.length);
    let pathname = baseParts.length > 0 ? `/${baseParts.join('/')}` : '';
    for (const part of parts) {
      pathname += `/${part}`;
      const collection = new URL(target.origin);
      collection.pathname = pathname;
      const url = collection.toString().replace(/\/$/, '');
      if (this.ensuredCollections.has(url)) continue;
      const res = await fetch(url, {
        method: 'MKCOL',
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(15_000),
      });
      // 405 是 WebDAV 对“目录已存在”的标准响应；2xx 表示创建成功。
      if (!res.ok && res.status !== 405) throw new Error(`WebDAV MKCOL ${res.status}`);
      this.ensuredCollections.add(url);
    }
  }

  async put(remotePath: string, localPath: string, username: string, token: string, onProgress: (pct: number) => void, serverUrl?: string): Promise<void> {
    const size = statSync(localPath).size;
    const authorization = `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
    await this.ensureParentCollections(remotePath, authorization, serverUrl);
    let uploaded = 0;
    let lastPct = -1;
    const controller = new AbortController();
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      // 总时长不设上限；只在连续 2 分钟没有上传数据/响应时中断，避免大文件慢速上传被固定 5 分钟误杀。
      inactivityTimer = setTimeout(() => controller.abort(new Error('WebDAV 上传长时间无响应')), 120_000);
    };
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        uploaded += chunk.length;
        const pct = size <= 0 ? 99 : Math.min(99, Math.floor((uploaded / size) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress(pct);
        }
        touch();
        callback(null, chunk);
      },
    });
    const body = createReadStream(localPath).pipe(progress);
    touch();
    try {
      const res = await fetch(remotePath, {
        method: 'PUT',
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
        },
        body,
        // Node >=18 undici fetch 发送流 body 必须带 duplex: 'half'，否则抛「duplex option is required when sending a body」。
        duplex: 'half',
        signal: controller.signal,
      });
      touch();
      if (!res.ok) throw new Error(`WebDAV PUT ${res.status}`);
      onProgress(100);
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer);
    }
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
  private pumping = false;
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
        this.emit(job.id);
      }
      this.enqueueJob(job.id);
    }
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
    const rec = this.services.recordings.get(recordingId);
    if (!rec || !rec.filePath) return null;
    const room = this.services.rooms.get(rec.roomId);
    const enabled = room?.uploadEnabled ?? config?.enabled ?? false;
    if (!enabled || !config?.hasToken || !config.serverUrl) return null;
    const existing = this.repo.jobForRecording(recordingId);
    // 幂等：recording 已有上传任务（任何状态，含 ok/failed/cancelled）→ 直接返回既有 job，不新建。
    if (existing) {
      // queued 记录可能来自异常中断或早期泵失败；再次触发时应自愈入队，不能永久停在“排队”。
      if (existing.status === 'queued') this.enqueueJob(existing.id);
      return existing;
    }
    // 原子幂等（QA #178）：INSERT OR IGNORE——并发窗口内对方已插入同 idempotency_key 时返回 null，
    // 回查既有 job，绝不抛 UNIQUE 500。
    const created = this.repo.create({ recordingId, idempotencyKey: `rec_${recordingId}` });
    if (!created) return this.repo.jobForRecording(recordingId);
    this.services.events.emit({ type: 'upload:updated', data: created });
    this.enqueueJob(created.id);
    return created;
  }

  async retry(jobId: string): Promise<UploadJob | null> {
    const job = this.repo.get(jobId);
    if (!job) return null;
    if (job.status === 'queued') {
      this.enqueueJob(jobId);
      return this.repo.get(jobId);
    }
    if (job.status === 'running') {
      if (!this.running.has(jobId)) {
        this.repo.update(jobId, { status: 'queued', error: '上传任务已自动恢复' });
        this.emit(jobId);
        this.enqueueJob(jobId);
      }
      return this.repo.get(jobId);
    }
    this.repo.update(jobId, { status: 'queued', error: null });
    this.emit(jobId);
    this.enqueueJob(jobId);
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
    this.emit(jobId);
    return this.repo.get(jobId);
  }

  private enqueueJob(jobId: string): void {
    if (!this.queue.includes(jobId) && !this.running.has(jobId)) this.queue.push(jobId);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return; // 单泵串行，避免重入风暴
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const jobId = this.queue.shift()!;
        if (this.running.has(jobId)) continue;
        this.running.add(jobId);
        try {
          await this.run(jobId);
        } catch (err) {
          const message = err instanceof Error ? err.message : '上传任务异常';
          this.repo.update(jobId, { status: 'failed', error: message });
          this.emit(jobId);
        } finally {
          this.running.delete(jobId);
        }
      }
    } finally {
      this.pumping = false;
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

    try {
      let lastProgress = -1;
      await this.client.put(remotePath, rec.filePath, config.username, token, (pct) => {
        const current = this.repo.get(jobId);
        if (current?.status !== 'running') return;
        const normalized = Math.max(0, Math.min(100, Math.floor(pct)));
        if (normalized === lastProgress) return;
        lastProgress = normalized;
        this.repo.update(jobId, { progress: normalized });
        this.emit(jobId);
      }, config.serverUrl);
      if (this.repo.get(jobId)?.status === 'cancelled') return;
      this.repo.update(jobId, { status: 'ok', progress: 100, error: null });
      this.emit(jobId);
    } catch (err) {
      if (this.repo.get(jobId)?.status === 'cancelled') return;
      const message = err instanceof Error ? err.message : '上传失败';
      const retryCount = job.retryCount + 1;
      if (retryCount <= MAX_RETRIES) {
        const delayMs = RETRY_DELAYS_MS[retryCount - 1] ?? 5_000;
        this.repo.update(jobId, {
          status: 'queued',
          retryCount,
          error: `${message}；${Math.round(delayMs / 1000)} 秒后自动重试`,
        });
        this.emit(jobId);
        // 退避不占住串行泵，后续文件可继续上传，避免一条失败任务让整列长期卡住。
        this.services.clock.setTimeout(() => {
          if (this.repo.get(jobId)?.status === 'queued') this.enqueueJob(jobId);
        }, delayMs);
      } else {
        this.repo.update(jobId, { status: 'failed', retryCount, error: message });
        this.emit(jobId);
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
}
