import { createReadStream, statSync, openSync, readSync, closeSync } from 'node:fs';
import { Transform } from 'node:stream';
import path from 'node:path';
import type { Services } from './services.js';
import type { OpenListConfig, UploadJob } from '../types/index.js';
import { UploadRepository } from '../db/repositories/upload.repo.js';
import { OPENLIST_TOKEN_KEY } from '../security/keys.js';

export interface WebDavClient {
  put(remotePath: string, localPath: string, username: string, token: string, onProgress: (pct: number) => void, serverUrl?: string): Promise<void>;
  /** 提交 2FA 一次性码换取短期 API token（#13）。 */
  submit2fa?(root: string, username: string, password: string, otpCode: string): Promise<{ ok: boolean; message?: string }>;
  /** 该 root 是否需要 2FA 一次性码。 */
  needs2fa?(root: string): boolean;
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
  /** #229 分片并发上传：启用开关与参数（大小单位字节）。 */
  multipartEnabled: boolean;
  multipartThresholdBytes: number;
  multipartChunkSizeBytes: number;
  multipartConcurrency: number;
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
  // #229 分片并发上传：≥50MB 走 multipart（8MB×4 并发），能力探测失败自动回退单 PUT。
  multipartEnabled: true,
  multipartThresholdBytes: 50 * 1024 * 1024,
  multipartChunkSizeBytes: 8 * 1024 * 1024,
  multipartConcurrency: 4,
};

interface OpenListTaskInfo {
  id: string;
  state: string;
  status?: string;
  progress: number;
  total_bytes?: number;
  error?: string;
}

/** OpenList 需要 2FA 一次性码时抛出的标识错误（job.error 含此标记，FE 据此弹窗输入验证码）。 */
export const OPENLIST_2FA_REQUIRED = 'OpenList 需要 2FA 验证';

/** 真实 WebDAV 上传：PUT 直传 OpenList（HTTP 基本认证，令牌作密码）。 */
export class RealWebDavClient implements WebDavClient {
  private ensuredCollections = new Set<string>();
  private apiTokens = new Map<string, string | null>();
  private pending2fa = new Set<string>();

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
      const payload = await res.json() as { code?: number; message?: string; data?: { token?: string } };
      if (payload.code === 402) {
        // OpenList 账号启用了 2FA：仅账号密码无法换取 token，需用户输入一次性码（#13）。
        this.pending2fa.add(root);
        this.apiTokens.set(root, null);
        return null;
      }
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

  /** 提交 2FA 一次性码换取短期 API token；成功缓存并清除待验证标记，返回是否成功。 */
  async submit2fa(root: string, username: string, password: string, otpCode: string): Promise<{ ok: boolean; message?: string }> {
    if (!otpCode || !otpCode.trim()) {
      return { ok: false, message: '请输入 2FA 一次性验证码' };
    }
    try {
      const res = await fetch(`${root}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, otp_code: otpCode.trim() }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = await res.json() as { code?: number; message?: string; data?: { token?: string } };
      if (payload.code === 200 && typeof payload.data?.token === 'string') {
        this.apiTokens.set(root, payload.data.token);
        this.pending2fa.delete(root);
        return { ok: true };
      }
      return { ok: false, message: payload.message || `OpenList 2FA 验证失败（HTTP ${res.status}）` };
    } catch {
      return { ok: false, message: '无法连接 OpenList，请检查服务地址与网络' };
    }
  }

  /** 该 root 是否需要 2FA 一次性码（最近一次登录被 402 拒绝）。 */
  needs2fa(root: string): boolean {
    return this.pending2fa.has(root);
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
    // 账号启用了 2FA：无法静默换取 token。抛出标识错误让 job 落「需要 2FA 验证」，
    // FE 检测后弹窗输入一次性码（#13）；不再回退单 PUT（服务端对 PUT 返回 405）。
    if (this.needs2fa(target.root)) {
      throw new Error(OPENLIST_2FA_REQUIRED);
    }
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
        // #229 ⑤真实进度透传：云盘写入完成（serverPct=100）但任务未翻 succeeded 时，
        // 透传为收尾确认态（进度 100），不再封顶 99 形成「死区」；FE 据此显示「最终确认 + 已等待时长」。
        onProgress(serverPct >= 100 ? 100 : Math.min(99, 50 + Math.floor(serverPct * 0.49)));
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

  /**
   * #229 分片并发上传：OpenList PUT /api/fs/multipart?action=upload|complete（PR #1877）。
   * 能力探测 + 严格回退：分片端点不支持（404/405）或响应 schema 未知 → 返回 false 走既有单 PUT/As-Task，
   * 绝不影响既有上传路径。大文件按 chunk 分片并发上传（分片幂等=断点续传只传缺失片），complete 走 As-Task 轮询。
   */
  private async putAsMultipart(remotePath: string, localPath: string, username: string, token: string, onProgress: (pct: number) => void, serverUrl?: string): Promise<boolean> {
    if (!this.options.multipartEnabled || !serverUrl) return false;
    const size = statSync(localPath).size;
    if (size < this.options.multipartThresholdBytes) return false;
    const target = this.apiTarget(serverUrl, remotePath);
    if (!target) return false;
    const authorization = `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
    const chunkSize = this.options.multipartChunkSizeBytes;
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
    const concurrency = Math.max(1, Math.min(this.options.multipartConcurrency, totalChunks));

    let uploadId: string | null = null;
    let unsupported = false;
    const failUnsupported = () => { unsupported = true; throw new Error('multipart-unsupported'); };

    const chunkHeaders = (index: number): Record<string, string> => {
      const headers: Record<string, string> = {
        Authorization: authorization,
        'File-Path': encodeURIComponent(target.filePath),
        'X-Chunk-Index': String(index),
        Overwrite: 'true',
        'As-Task': 'false',
      };
      if (index === 0) {
        headers['X-File-Size'] = String(size);
        headers['X-Chunk-Size'] = String(chunkSize);
      } else if (uploadId) {
        headers['X-Upload-Id'] = uploadId;
      }
      return headers;
    };

    const uploadChunk = async (index: number): Promise<void> => {
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, size);
      const chunk = readRange(localPath, start, end);
      const res = await fetch(`${target.root}/api/fs/multipart?action=upload`, {
        method: 'PUT',
        headers: chunkHeaders(index),
        body: chunk,
        duplex: 'half',
        signal: AbortSignal.timeout(this.options.uploadIdleTimeoutMs + 30_000),
      });
      if (!res.ok) return failUnsupported();
      if (index === 0) {
        try {
          const payload = await res.json() as { data?: Record<string, unknown> };
          const d = payload.data ?? {};
          uploadId = (d.upload_id as string | undefined) ?? (d.uploadId as string | undefined) ?? (d.id as string | undefined) ?? null;
        } catch {
          return failUnsupported();
        }
        if (!uploadId) return failUnsupported();
      }
      // 进度：已传分片累计到本地阶段（0~49% 上限映射沿用约定）。
      onProgress(Math.min(49, Math.floor(((index + 1) / totalChunks) * 49)));
    };

    try {
      // ①分片 0 先传：探测端点 + 建立会话（拿到 upload_id）。
      await uploadChunk(0);
      // ②其余分片并发上传（幂等重传安全；上传失败的重试只重传缺失分片=断点续传）。
      const remaining = Array.from({ length: totalChunks - 1 }, (_, i) => i + 1);
      for (let i = 0; i < remaining.length; i += concurrency) {
        await Promise.all(remaining.slice(i, i + concurrency).map((idx) => uploadChunk(idx).catch((err) => {
          if (unsupported) throw err;
          // 网络类单分片失败：重试一次（幂等，安全）。
          return uploadChunk(idx);
        })));
      }
      // ③complete：合并分片；As-Task=true 让云端落盘走既有任务轮询+校验兜底。
      const completeRes = await fetch(`${target.root}/api/fs/multipart?action=complete`, {
        method: 'PUT',
        headers: {
          Authorization: authorization,
          'File-Path': encodeURIComponent(target.filePath),
          'X-Upload-Id': uploadId!,
          'X-File-Size': String(size),
          'As-Task': 'true',
          Overwrite: 'true',
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (!completeRes.ok) return failUnsupported();
      const completePayload = await completeRes.json() as { code?: number; data?: { task?: { id?: string } } };
      const taskId = completePayload.data?.task?.id;
      if (!taskId) return failUnsupported();
      await this.pollTaskUntilDone(remotePath, size, username, token, taskId, onProgress, serverUrl);
      onProgress(100);
      return true;
    } catch (err) {
      if (unsupported) return false;
      throw err;
    }
  }

  /** 复用既有任务轮询语义：轮询 OpenList 后台上传任务至 succeeded/failed/超时，卡滞用远端文件核验兜底。 */
  private async pollTaskUntilDone(remotePath: string, size: number, username: string, token: string, taskId: string, onProgress: (pct: number) => void, serverUrl: string): Promise<void> {
    const target = this.apiTarget(serverUrl, remotePath);
    const base = target ? target.root : '';
    const authorization = `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
    const startedAt = Date.now();
    let lastServerPct = -1;
    let lastProgressChangeAt = Date.now();
    let consecutiveFailures = 0;
    while (Date.now() - startedAt < this.options.taskPollTimeoutMs) {
      await this.delay(this.options.taskPollIntervalMs);
      try {
        const res = await fetch(`${base}/api/task/upload/info?tid=${encodeURIComponent(taskId)}`, {
          method: 'POST',
          headers: { Authorization: authorization },
          signal: AbortSignal.timeout(20_000),
        });
        const payload = await res.json() as { data?: OpenListTaskInfo };
        if (!res.ok || !payload.data) throw new Error('task poll failed');
        consecutiveFailures = 0;
        const serverPct = Math.max(0, Math.min(100, Number(payload.data.progress) || 0));
        onProgress(Math.min(99, 50 + Math.floor(serverPct * 0.49)));
        if (payload.data.state === 'succeeded') return;
        if (payload.data.state === 'failed' || payload.data.state === 'canceled') {
          throw new Error(`OpenList 分片合并/落盘${payload.data.state === 'canceled' ? '已取消' : '失败'}${payload.data.error ? `：${payload.data.error}` : ''}`);
        }
        if (serverPct !== lastServerPct) {
          lastServerPct = serverPct;
          lastProgressChangeAt = Date.now();
        } else if (Date.now() - lastProgressChangeAt >= this.options.taskStallTimeoutMs) {
          if (await this.remoteFileMatches(remotePath, size, authorization)) return;
          throw new Error('OpenList 分片合并/落盘进度长时间无变化，请检查云端存储');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.startsWith('OpenList 分片')) throw err;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 10) {
          if (await this.remoteFileMatches(remotePath, size, authorization)) return;
          throw new Error(`无法读取 OpenList 分片任务进度：${message}`);
        }
      }
    }
    throw new Error('OpenList 分片合并/落盘等待超时');
  }

  async put(remotePath: string, localPath: string, username: string, token: string, onProgress: (pct: number) => void, serverUrl?: string): Promise<void> {
    const size = statSync(localPath).size;
    const authorization = `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
    await this.ensureParentCollections(remotePath, authorization, serverUrl);
    // 先探测 OpenList API 登录态：#13 账号启用 2FA 时无法静默换取 token。
    // 探测一次（命中缓存则零开销），2FA 必需则抛标识错误交 FE 弹窗，不再回退 405 单 PUT。
    if (serverUrl) {
      const probeTarget = this.apiTarget(serverUrl, remotePath);
      if (probeTarget) {
        await this.apiToken(probeTarget.root, username, token);
        if (this.needs2fa(probeTarget.root)) {
          throw new Error(OPENLIST_2FA_REQUIRED);
        }
      }
    }
    // #229 分片并发：大文件优先走 OpenList multipart 分片上传（能力探测+严格回退，失败自动退回单 PUT）。
    if (await this.putAsMultipart(remotePath, localPath, username, token, onProgress, serverUrl)) return;
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

  /** 是否当前 OpenList 账号需要 2FA 一次性码（最近一次 API 登录被 402 拒绝）。 */
  async needs2fa(): Promise<boolean> {
    const config = await this.config();
    if (!config?.serverUrl) return false;
    const target = this.clientTarget(config.serverUrl);
    return Boolean(target && this.client.needs2fa?.(target.root));
  }

  /** 提交 2FA 一次性码换取短期 token；成功返回 ok（token 已缓存，后续上传复用）。 */
  async submit2fa(otpCode: string): Promise<{ ok: boolean; message?: string }> {
    const config = await this.config();
    if (!config?.serverUrl || !config.username) return { ok: false, message: 'OpenList 配置缺失' };
    const token = await this.services.secretStore.get(OPENLIST_TOKEN_KEY);
    if (!token) return { ok: false, message: 'OpenList 令牌未配置' };
    const target = this.clientTarget(config.serverUrl);
    if (!target) return { ok: false, message: 'OpenList 地址无效' };
    return this.client.submit2fa
      ? await this.client.submit2fa(target.root, config.username, token, otpCode)
      : { ok: false, message: '当前上传实现不支持 2FA' };
  }

  private clientTarget(serverUrl: string): { root: string } | null {
    try {
      const configured = new URL(serverUrl);
      const davIndex = configured.pathname.indexOf('/dav');
      if (davIndex < 0) return null;
      return { root: `${configured.origin}${configured.pathname.slice(0, davIndex)}`.replace(/\/+$/, '') };
    } catch {
      return null;
    }
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
      // #13：2FA 需要一次性码，重试无意义（没有码必然再 402）。直接失败交 FE 弹窗输入验证码，
      // 避免 5s/15s/45s 退避循环让用户等很久才看到弹窗（PrePan：提示后没有立即弹出）。
      if (message.includes(OPENLIST_2FA_REQUIRED)) {
        this.repo.update(jobId, { status: 'failed', retryCount: job.retryCount + 1, error: message });
        this.emit(jobId);
        return;
      }
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

/** #229 分片上传：同步读取文件 [start,end) 区间字节。 */
function readRange(filePath: string, start: number, end: number): Buffer {
  const length = end - start;
  const fd = openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const n = readSync(fd, buf, offset, length - offset, start + offset);
      if (n <= 0) break;
      offset += n;
    }
    return buf.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
