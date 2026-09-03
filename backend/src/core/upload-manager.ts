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

interface WebDavClientOptions {
  /** 请求体仍在发送时，连续无数据的最大时间。 */
  uploadIdleTimeoutMs: number;
  /** 请求体发送完毕后，等待 OpenList/存储端确认的最大时间。 */
  responseTimeoutMs: number;
  /** PUT 结果不确定时，远端文件核验的退避间隔。首个 0 表示立即核验。 */
  verifyDelaysMs: number[];
  verifyTimeoutMs: number;
  /** 优先使用 OpenList 官方后台任务上传，以获得服务端落盘进度。 */
  taskApiEnabled: boolean;
  taskPollIntervalMs: number;
  taskPollTimeoutMs: number;
  /** #228：后台上传任务进度长时间无变化的卡滞判定窗口；超过则用远端文件核验兜底判定。 */
  taskStallTimeoutMs: number;
}

const DEFAULT_WEBDAV_OPTIONS: WebDavClientOptions = {
  uploadIdleTimeoutMs: 120_000,
  // OpenList 挂载网盘时，PUT body 收完后还需要服务端完成远端落盘；这不是上传停滞。
  responseTimeoutMs: 10 * 60_000,
  verifyDelaysMs: [0, 2_000, 5_000, 10_000],
  verifyTimeoutMs: 20_000,
  taskApiEnabled: true,
  taskPollIntervalMs: 1_000,
  // #228：后台上传任务等待上限 6h 过长 → 30min；配合 taskStallTimeoutMs 卡滞判定，避免 99% 无限挂起。
  taskPollTimeoutMs: 30 * 60_000,
  taskStallTimeoutMs: 10 * 60_000,
};

interface OpenListTaskInfo {
  id: string;
  state: string;
  status?: string;
  progress: number;
  total_bytes?: number;
  error?: string;
}

/** 真实 WebDAV 上传：PUT 直传 OpenList（HTTP 基本认证，令牌作密码）。 */
export class RealWebDavClient implements WebDavClient {
  private ensuredCollections = new Set<string>();
  private apiTokens = new Map<string, string | null>();

  private options: WebDavClientOptions;

  constructor(options: Partial<WebDavClientOptions> = {}) {
    this.options = { ...DEFAULT_WEBDAV_OPTIONS, ...options };
  }

  private async delay(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private apiTarget(serverUrl: string, remotePath: string): { root: string; filePath: string } | null {
    try {
      const configured = new URL(serverUrl);
      const remote = new URL(remotePath);
      if (configured.origin !== remote.origin) return null;
      const davIndex = configured.pathname.indexOf('/dav');
      if (davIndex < 0) return null;
      const davPrefix = configured.pathname.slice(0, davIndex + 4);
      if (remote.pathname !== davPrefix && !remote.pathname.startsWith(`${davPrefix}/`)) return null;
      return {
        root: `${configured.origin}${configured.pathname.slice(0, davIndex)}`.replace(/\/+$/, ''),
        filePath: decodeURIComponent(remote.pathname.slice(davPrefix.length)) || '/',
      };
    } catch {
      return null;
    }
  }

  /** WebDAV 密码也是 OpenList 账号密码；无 2FA 时可换取短期 API JWT，仅缓存在内存。 */
  private async apiToken(root: string, username: string, password: string): Promise<string | null> {
    if (this.apiTokens.has(root)) return this.apiTokens.get(root) ?? null;
    try {
      const res = await fetch(`${root}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await res.json() as { code?: number; data?: { token?: string } };
      const token = res.ok && payload.code === 200 && typeof payload.data?.token === 'string'
        ? payload.data.token
        : null;
      this.apiTokens.set(root, token);
      return token;
    } catch {
      // 旧版 OpenList、2FA 或 API 被代理禁用时继续使用标准 WebDAV，不影响原功能。
      this.apiTokens.set(root, null);
      return null;
    }
  }

  /**
   * OpenList /api/fs/put + As-Task：请求体收完后立即返回任务 ID，云盘落盘在后台执行。
   * 总进度映射为 0~49%（客户端→OpenList）+ 50~99%（OpenList→云盘）。
   */
  private async putAsOpenListTask(
    remotePath: string,
    localPath: string,
    username: string,
    password: string,
    onProgress: (pct: number) => void,
    serverUrl?: string,
  ): Promise<boolean> {
    if (!this.options.taskApiEnabled || !serverUrl) return false;
    const target = this.apiTarget(serverUrl, remotePath);
    if (!target) return false;
    const token = await this.apiToken(target.root, username, password);
    if (!token) return false;

    const size = statSync(localPath).size;
    let uploaded = 0;
    let lastPct = -1;
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const clearTimer = () => {
      if (phaseTimer) clearTimeout(phaseTimer);
      phaseTimer = undefined;
    };
    const armTimer = (timeoutMs: number, message: string) => {
      clearTimer();
      phaseTimer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
    };
    const progress = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        uploaded += chunk.length;
        const localPct = size <= 0 ? 49 : Math.min(49, Math.floor((uploaded / size) * 50));
        if (localPct !== lastPct) {
          lastPct = localPct;
          onProgress(localPct);
        }
        armTimer(this.options.uploadIdleTimeoutMs, 'OpenList 接收上传数据长时间停滞');
        callback(null, chunk);
      },
      flush: (callback) => {
        armTimer(this.options.responseTimeoutMs, 'OpenList 创建后台上传任务超时');
        callback();
      },
    });

    let task: OpenListTaskInfo;
    try {
      armTimer(this.options.uploadIdleTimeoutMs, 'OpenList 接收上传数据长时间停滞');
      const res = await fetch(`${target.root}/api/fs/put`, {
        method: 'PUT',
        headers: {
          Authorization: token,
          'File-Path': encodeURIComponent(target.filePath),
          'As-Task': 'true',
          Overwrite: 'true',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(size),
          'Last-Modified': String(statSync(localPath).mtimeMs),
        },
        body: createReadStream(localPath).pipe(progress),
        duplex: 'half',
        signal: controller.signal,
      });
      const payload = await res.json() as { code?: number; message?: string; data?: { task?: OpenListTaskInfo } };
      if (res.status === 401) this.apiTokens.delete(target.root);
      if (!res.ok || payload.code !== 200 || !payload.data?.task?.id) {
        throw new Error(`OpenList 创建上传任务失败${payload.message ? `：${payload.message}` : `（HTTP ${res.status}）`}`);
      }
      task = payload.data.task;
    } finally {
      clearTimer();
    }

    onProgress(50);
    const startedAt = Date.now();
    let consecutivePollFailures = 0;
    let lastServerPct = -1;
    let lastProgressChangeAt = Date.now();
    while (Date.now() - startedAt < this.options.taskPollTimeoutMs) {
      await this.delay(this.options.taskPollIntervalMs);
      try {
        const res = await fetch(`${target.root}/api/task/upload/info?tid=${encodeURIComponent(task.id)}`, {
          method: 'POST',
          headers: { Authorization: token },
          signal: AbortSignal.timeout(20_000),
        });
        const payload = await res.json() as { code?: number; message?: string; data?: OpenListTaskInfo };
        if (!res.ok || payload.code !== 200 || !payload.data) {
          if (res.status === 401) this.apiTokens.delete(target.root);
          throw new Error(payload.message || `HTTP ${res.status}`);
        }
        consecutivePollFailures = 0;
        task = payload.data;
        const serverPct = Math.max(0, Math.min(100, Number(task.progress) || 0));
        onProgress(Math.min(99, 50 + Math.floor(serverPct * 0.49)));
        if (task.state === 'succeeded') {
          onProgress(100);
          return true;
        }
        if (task.state === 'failed' || task.state === 'canceled') {
          throw new Error(`OpenList 后台上传${task.state === 'canceled' ? '已取消' : '失败'}${task.error ? `：${task.error}` : ''}`);
        }
        // #228：进度卡滞判定——服务端任务仍在 running 但进度长时间无变化时，
        // 用远端文件核验兜底：文件已完整落盘则判定成功，否则给出明确失败原因。
        if (serverPct !== lastServerPct) {
          lastServerPct = serverPct;
          lastProgressChangeAt = Date.now();
        } else if (Date.now() - lastProgressChangeAt >= this.options.taskStallTimeoutMs) {
          if (await this.remoteFileMatches(remotePath, size, `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`)) {
            onProgress(100);
            return true;
          }
          throw new Error('OpenList 上传进度长时间无变化，请检查云端存储是否正常（文件可能未完整落盘）');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('OpenList 后台上传') || message.startsWith('OpenList 上传进度')) throw err;
        consecutivePollFailures += 1;
        // 短暂的反向代理/网络抖动不应让已经在 OpenList 中运行的任务被误判失败。
        if (consecutivePollFailures >= 10) {
          if (await this.remoteFileMatches(remotePath, size, `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`)) {
            onProgress(100);
            return true;
          }
          throw new Error(`无法读取 OpenList 后台上传进度：${message}`);
        }
      }
    }
    throw new Error('OpenList 后台上传任务等待超时');
  }

  /**
   * 504/连接中断并不代表 OpenList 写入失败：反向代理可能先超时，而存储端稍后完成。
   * 用 PROPFIND 的 Content-Length 做最终确认，大小完全一致才视为成功。
   */
  private async remoteFileMatches(remotePath: string, expectedSize: number, authorization: string): Promise<boolean> {
    for (const delayMs of this.options.verifyDelaysMs) {
      await this.delay(delayMs);
      try {
        const res = await fetch(remotePath, {
          method: 'PROPFIND',
          headers: {
            Authorization: authorization,
            Depth: '0',
            'Content-Type': 'application/xml',
          },
          body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/></d:prop></d:propfind>',
          signal: AbortSignal.timeout(this.options.verifyTimeoutMs),
        });
        if (!res.ok) continue;
        const xml = await res.text();
        const match = xml.match(/<(?:[A-Za-z][\w.-]*:)?getcontentlength\b[^>]*>\s*(\d+)\s*</i);
        if (match && Number(match[1]) === expectedSize) return true;
      } catch {
        // OpenList 可能仍在提交文件；按退避间隔继续核验。
      }
    }
    return false;
  }

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
    if (await this.putAsOpenListTask(remotePath, localPath, username, token, onProgress, serverUrl)) return;
    let uploaded = 0;
    let lastPct = -1;
    let bodyFinished = false;
    const controller = new AbortController();
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    const clearPhaseTimer = () => {
      if (phaseTimer) clearTimeout(phaseTimer);
      phaseTimer = undefined;
    };
    const armUploadIdleTimer = () => {
      clearPhaseTimer();
      phaseTimer = setTimeout(
        () => controller.abort(new Error('WebDAV 上传数据长时间停滞')),
        this.options.uploadIdleTimeoutMs,
      );
    };
    const armResponseTimer = () => {
      clearPhaseTimer();
      phaseTimer = setTimeout(
        () => controller.abort(new Error('WebDAV 服务端确认超时')),
        this.options.responseTimeoutMs,
      );
    };
    const progress = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        uploaded += chunk.length;
        const pct = size <= 0 ? 99 : Math.min(99, Math.floor((uploaded / size) * 100));
        if (pct !== lastPct) {
          lastPct = pct;
          onProgress(pct);
        }
        armUploadIdleTimer();
        callback(null, chunk);
      },
      flush(callback) {
        bodyFinished = true;
        // body 已完整交给 HTTP 客户端，后续静默通常是 OpenList/云盘正在落盘，不能继续套用 2 分钟上传停滞阈值。
        armResponseTimer();
        callback();
      },
    });
    const body = createReadStream(localPath).pipe(progress);
    armUploadIdleTimer();
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
      if (!res.ok) throw new Error(`WebDAV PUT ${res.status}`);
      onProgress(100);
    } catch (err) {
      clearPhaseTimer();
      const message = err instanceof Error ? err.message : String(err);
      const resultIsAmbiguous = bodyFinished && (
        /WebDAV PUT (408|425|429|500|502|503|504)\b/.test(message)
        || message.includes('服务端确认超时')
        || message.includes('fetch failed')
        || message.includes('ECONNRESET')
      );
      if (resultIsAmbiguous && await this.remoteFileMatches(remotePath, size, authorization)) {
        onProgress(100);
        return;
      }
      throw err;
    } finally {
      clearPhaseTimer();
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
    this.repo.update(jobId, { status: 'running', progress: 0, remotePath, error: null });
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
    // 日期取录制 startedAt 的【本地日期】（YYYY-MM-DD），与命名规则 {date} 一致（PrePan：凌晨录制跨 UTC 日期）。
    const dt = new Date(rec.startedAt ?? path.basename(localPath));
    const date = Number.isNaN(dt.getTime())
      ? (rec.startedAt ?? path.basename(localPath)).slice(0, 10)
      : `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
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
