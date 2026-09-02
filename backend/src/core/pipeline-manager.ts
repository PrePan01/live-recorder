import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Services } from './services.js';
import type { PipelineConfig } from '../types/index.js';
import { PipelineRepository } from '../db/repositories/pipeline.repo.js';
import { checkFileIntegrity } from '../recorder/integrity.js';
import { extractCoverFrame, segmentFile, compressOrRemux, archiveTo, cleanupDir } from '../recorder/pipeline-ffmpeg.js';
import type { Recording, PipelineRun, PipelineRunStatus } from '../types/index.js';

interface QueueEntry {
  recordingId: string;
  attempt: number;
}

/**
 * 后处理管线（V5 Batch2 #114）：并发 N=2 FIFO、录制主链路优先（不占录制线程）。
 * 步骤：verify(ffprobe) → sidecar(元数据) → cover(封面帧) → segment(切片) → compress(压缩/remux) → archive(归档)。
 * 单步失败 → partial（保成功产物）；致命校验失败（源文件损坏）→ failed 但保留源文件。
 * 配置快照随 run 存储，改配置不追溯历史 run。
 */
export class PipelineManager {
  private queue: QueueEntry[] = [];
  private running = new Set<string>();
  private pipelineRepo: PipelineRepository;

  constructor(private services: Services) {
    this.pipelineRepo = new PipelineRepository(services.db);
  }

  get repo(): PipelineRepository {
    return this.pipelineRepo;
  }

  pipelineConfig(): PipelineConfig {
    const settings = this.services.settings.load();
    const stored = settings?.pipeline;
    return { enabled: false, verify: true, segmentSeconds: 0, crf: null, archiveDirectory: '', maxConcurrency: 2, ...(stored ?? {}) };
  }

  /** 录制完成时入队（录制优先：仅当运行中 < N 立即执行，否则 FIFO 排队）。 */
  enqueue(recordingId: string, attempt = 0): void {
    const config = this.pipelineConfig();
    if (!config.enabled) {
      // 未启用管线：录制保持 completed，pipelineStatus=not_required；仍触发 OpenList 自动上传（uploader 自身校验 enabled/token）。
      this.services.recordings.update(recordingId, { pipelineStatus: 'not_required' });
      void this.services.uploader.enqueue(recordingId).catch(() => undefined);
      return;
    }
    // 同录制单飞：已排队/运行中则忽略。
    if (this.running.has(recordingId) || this.queue.some((q) => q.recordingId === recordingId)) return;
    this.queue.push({ recordingId, attempt });
    this.services.recordings.update(recordingId, { state: 'processing', pipelineStatus: 'queued' });
    this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(recordingId)! });
    this.pump();
  }

  /** 重试：为失败/部分成功的录制重新入队（新 run，快照当前配置）。 */
  retry(recordingId: string): { ok: boolean; run: PipelineRun | null } {
    const rec = this.services.recordings.get(recordingId);
    if (!rec || !rec.filePath) return { ok: false, run: null };
    const existing = this.pipelineRepo.runForRecording(recordingId);
    if (existing && (existing.status === 'queued' || existing.status === 'running')) return { ok: false, run: null };
    this.enqueue(recordingId, (existing?.configSnapshot.attempt as number ?? 0) + 1);
    return { ok: true, run: this.pipelineRepo.runForRecording(recordingId) };
  }

  /** FIFO 泵：最多 N=2 并发，录制主链路永远不被阻塞（异步执行）。 */
  private pump(): void {
    let maxConcurrency = 2;
    try {
      maxConcurrency = this.pipelineConfig().maxConcurrency;
    } catch {
      // 服务关闭中：不再派发新任务。
      return;
    }
    while (this.running.size < maxConcurrency && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (this.running.has(entry.recordingId)) continue;
      this.running.add(entry.recordingId);
      void this.run(entry);
    }
  }

  private async run(entry: QueueEntry): Promise<void> {
    try {
      await this.runInner(entry);
    } catch {
      // 服务关闭/管线异常：静默收束（管线非关键路径）。
    } finally {
      this.running.delete(entry.recordingId);
      this.pump();
    }
  }

  private async runInner(entry: QueueEntry): Promise<void> {
    const config = this.pipelineConfig();
    const recording = this.services.recordings.get(entry.recordingId);
    const run = this.pipelineRepo.createRun({ recordingId: entry.recordingId, configSnapshot: { ...config, attempt: entry.attempt } });
    this.services.recordings.update(entry.recordingId, { state: 'processing', pipelineStatus: 'running' });
    this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(entry.recordingId)! });

    let finalStatus: PipelineRunStatus = 'ok';
    try {
      if (!recording || !recording.filePath) throw new Error('recording 无文件');

      // ① verify：ffprobe 校验源文件可播（损坏 → failed，保留源文件）。
      const verify = this.pipelineRepo.createArtifact({ runId: run.id, step: 'verify' });
      this.pipelineRepo.setArtifact(verify.id, { status: 'running', startedAt: this.services.clock.iso() });
      const integrity = await checkFileIntegrity(recording.filePath);
      if (integrity === 'failed') {
        this.pipelineRepo.setArtifact(verify.id, { status: 'failed', error: '源文件损坏或截断', endedAt: this.services.clock.iso() });
        this.services.recordings.update(recording.id, { integrity: 'failed', state: 'completed', pipelineStatus: 'failed' });
        this.finish(run.id, 'failed');
        return;
      }
      if (integrity === 'verified') this.services.recordings.update(recording.id, { integrity: 'verified' });
      this.pipelineRepo.setArtifact(verify.id, { status: 'ok', endedAt: this.services.clock.iso() });

      // ② sidecar：写入元数据（真实时长/片段数/清晰度/大小）。
      const sidecar = this.pipelineRepo.createArtifact({ runId: run.id, step: 'sidecar' });
      this.pipelineRepo.setArtifact(sidecar.id, { status: 'running', startedAt: this.services.clock.iso() });
      const st = await stat(recording.filePath);
      const metadata = {
        durationMs: await probeDurationMs(recording.filePath),
        segmentCount: 1,
        quality: recording.quality ?? null,
        size: st.size,
      };
      this.services.recordings.update(recording.id, { metadata });
      this.pipelineRepo.setArtifact(sidecar.id, { status: 'ok', path: recording.filePath, sizeBytes: st.size, endedAt: this.services.clock.iso() });

      // ③ cover：封面帧（可选，失败不阻断）。
      const coverDir = path.join(path.dirname(recording.filePath), '.covers');
      await mkdir(coverDir, { recursive: true });
      const cover = await extractCoverFrame(recording.filePath, coverDir, path.basename(recording.filePath).replace(/\.[^.]+$/, ''));
      if (cover) {
        this.services.recordings.update(recording.id, { coverPath: cover.coverPath });
      }
      const coverArt = this.pipelineRepo.createArtifact({ runId: run.id, step: 'cover' });
      this.pipelineRepo.setArtifact(coverArt.id, cover ? { status: 'ok', path: cover.coverPath, sizeBytes: cover.sizeBytes, endedAt: this.services.clock.iso() } : { status: 'skipped', endedAt: this.services.clock.iso() });

      // ④ segment：切片（segmentSeconds>0 时）。
      if (config.segmentSeconds > 0) {
        const segDir = path.join(path.dirname(recording.filePath), '.segments');
        await mkdir(segDir, { recursive: true });
        const segArt = this.pipelineRepo.createArtifact({ runId: run.id, step: 'segment' });
        this.pipelineRepo.setArtifact(segArt.id, { status: 'running', startedAt: this.services.clock.iso() });
        const seg = await segmentFile(recording.filePath, segDir, path.basename(recording.filePath).replace(/\.[^.]+$/, ''), config.segmentSeconds);
        if (seg) {
          this.pipelineRepo.setArtifact(segArt.id, { status: 'ok', path: seg.segments[0] ?? null, sizeBytes: seg.segments.length, endedAt: this.services.clock.iso() });
        } else {
          this.pipelineRepo.setArtifact(segArt.id, { status: 'failed', error: '切片失败', endedAt: this.services.clock.iso() });
          finalStatus = 'partial';
        }
      }

      // ⑤ compress：压缩/remux（crf=null 仅 remux copy）。mp4 输入且 crf=null 时无需处理 → skipped，不改 finalStatus。
      {
        const compArt = this.pipelineRepo.createArtifact({ runId: run.id, step: 'compress' });
        const ext = path.extname(recording.filePath).toLowerCase();
        const transformNeeded = config.crf !== null || ext === '.flv' || ext === '.ts';
        if (!transformNeeded) {
          this.pipelineRepo.setArtifact(compArt.id, { status: 'skipped', endedAt: this.services.clock.iso() });
        } else {
          this.pipelineRepo.setArtifact(compArt.id, { status: 'running', startedAt: this.services.clock.iso() });
          const comp = await compressOrRemux(recording.filePath, config.crf);
          if (comp) {
            // 成功产物不删除源文件；更新 filePath 指向新产物（源仍在）。
            this.services.recordings.update(recording.id, { filePath: comp.outPath, fileSizeBytes: comp.sizeBytes });
            this.pipelineRepo.setArtifact(compArt.id, { status: 'ok', path: comp.outPath, sizeBytes: comp.sizeBytes, endedAt: this.services.clock.iso() });
          } else {
            this.pipelineRepo.setArtifact(compArt.id, { status: 'failed', error: '压缩/转封装失败，保留源文件', endedAt: this.services.clock.iso() });
            finalStatus = 'partial';
          }
        }
      }

      // ⑥ archive：归档（copy 到归档目录，保留源文件）。
      if (config.archiveDirectory) {
        const archArt = this.pipelineRepo.createArtifact({ runId: run.id, step: 'archive' });
        this.pipelineRepo.setArtifact(archArt.id, { status: 'running', startedAt: this.services.clock.iso() });
        const archived = await archiveTo(recording.filePath, config.archiveDirectory);
        if (archived) {
          this.pipelineRepo.setArtifact(archArt.id, { status: 'ok', path: archived, sizeBytes: (await stat(archived).catch(() => ({ size: 0 }))).size, endedAt: this.services.clock.iso() });
        } else {
          this.pipelineRepo.setArtifact(archArt.id, { status: 'failed', error: '归档失败', endedAt: this.services.clock.iso() });
          finalStatus = 'partial';
        }
      }

      this.finish(run.id, finalStatus);
    } catch (err) {
      const message = err instanceof Error ? err.message : '管线异常';
      // 管线异常：保留源文件，标记 failed（源文件完好）。
      this.services.recordings.update(entry.recordingId, { state: 'completed', pipelineStatus: 'failed' });
      this.finish(run.id, 'failed');
      this.services.alerts.create({ level: 'warning', source: 'pipeline', message: `后处理管线失败（${entry.recordingId}）：${message}`, occurredAt: this.services.clock.iso() });
    }
  }

  private finish(runId: string, status: PipelineRunStatus): void {
    this.pipelineRepo.setRunStatus(runId, status, this.services.clock.iso());
    const run = this.pipelineRepo.getRun(runId);
    if (run) {
      // 同步 recordings.pipelineStatus 与 state。
      const pipelineStatus = status === 'ok' ? 'ok' : status === 'partial' ? 'partial' : status === 'failed' ? 'failed' : 'queued';
      this.services.recordings.update(run.recordingId, { state: 'completed', pipelineStatus });
      this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(run.recordingId)! });
      // 管线完成（ok/partial）后触发 OpenList 上传（若启用）。
      if (status === 'ok' || status === 'partial') {
        void this.services.uploader.enqueue(run.recordingId).catch(() => undefined);
      }
    }
  }
}

async function probeDurationMs(filePath: string): Promise<number | null> {
  try {
    const { spawn } = await import('node:child_process');
    return await new Promise<number | null>((resolve) => {
      const child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath]);
      let out = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 15_000);
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          resolve(Math.round(Number((JSON.parse(out) as { format?: { duration?: string } }).format?.duration ?? 0) * 1000));
        } catch {
          resolve(null);
        }
      });
    });
  } catch {
    return null;
  }
}

export type { Recording };