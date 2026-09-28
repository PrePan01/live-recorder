import { mkdir, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import type { Services } from './services.js';
import type { PipelineConfig } from '../types/index.js';
import { PipelineRepository } from '../db/repositories/pipeline.repo.js';
import { checkFileIntegrity, checkFileIntegrityDetailed } from '../recorder/integrity.js';
import { resolveBin } from '../utils/ffmpeg.js';
import { extractCoverFrame, segmentFile, exportAudioToMp3, convertToMp4, compressOrRemux, archiveTo, cleanupDir } from '../recorder/pipeline-ffmpeg.js';
import type { PipelineArtifact, PipelineStep, Recording, PipelineRun, PipelineRunStatus } from '../types/index.js';

interface QueueEntry {
  recordingId: string;
  attempt: number;
  runId?: string;
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
  private lastProgressEmitAt = new Map<string, number>();
  get busy(): boolean { return this.running.size > 0 || this.queue.length > 0; }
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
    return { enabled: false, verify: true, segmentSeconds: 0, crf: null, archiveDirectory: '', maxConcurrency: 2, exportAudio: false, exportCover: true, outputFormat: 'source', ...(stored ?? {}) };
  }

  /** 录制完成时入队（录制优先：仅当运行中 < N 立即执行，否则 FIFO 排队）。 */
  enqueue(recordingId: string, attempt = 0, force = false): void {
    const config = this.pipelineConfig();
    // 手动启动/继续（force）按用户意图直接跑管线；自动路径保留「未启用=not_required+触发上传」原语义。
    if (!config.enabled && !force) {
      // 未启用管线：录制保持 completed，pipelineStatus=not_required；仍触发 OpenList 自动上传（uploader 自身校验 enabled/token）。
      this.services.recordings.update(recordingId, { pipelineStatus: 'not_required' });
      void this.services.uploader.enqueue(recordingId, { automatic: true }).catch(() => undefined);
      return;
    }
    // 同录制单飞：已排队/运行中则忽略。
    if (this.running.has(recordingId) || this.queue.some((q) => q.recordingId === recordingId)) return;
    // 入队即建 run 行：调用方（启动/继续/重试）立刻拿到真实 run，不再有「run=null 像失败」的观感。
    const run = this.pipelineRepo.createRun({ recordingId, configSnapshot: { ...config, attempt } });
    this.queue.push({ recordingId, attempt, runId: run.id });
    this.services.recordings.update(recordingId, { state: 'processing', pipelineStatus: 'queued' });
    this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(recordingId)! });
    this.pump();
  }

  /** 重试：为失败/部分成功的录制重新入队（新 run，快照当前配置）。 */
  retry(recordingId: string, force = false): { ok: boolean; run: PipelineRun | null } {
    const rec = this.services.recordings.get(recordingId);
    if (!rec || !rec.filePath) return { ok: false, run: null };
    const existing = this.pipelineRepo.runForRecording(recordingId);
    if (existing && (existing.status === 'queued' || existing.status === 'running')) return { ok: false, run: null };
    this.enqueue(recordingId, (existing?.configSnapshot.attempt as number ?? 0) + 1, force);
    return { ok: true, run: this.pipelineRepo.runForRecording(recordingId) };
  }

  /** FIFO 泵：最多 N=2 并发，录制主链路永远不被阻塞（异步执行）。 */
  private pump(): void {
    let maxConcurrency = 2;
    try {
      const configured = this.pipelineConfig().maxConcurrency;
      // ffmpeg/post-processing competes with the recorder for disk and CPU.
      // Do not interrupt existing runs; simply stop dispatching additional work
      // while any live recording is active.
      maxConcurrency = this.services.manager.activeRoomIds().length > 0 ? 1 : configured;
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
      await this.runInner(entry, entry.runId);
      if (entry.runId) this.finishInterruptedArtifacts(entry.runId);
    } catch {
      // 服务关闭/管线异常：静默收束（管线非关键路径）。
    } finally {
      this.running.delete(entry.recordingId);
      this.pump();
    }
  }

  /** 收束服务重启前遗留、但本次未继续执行到的步骤，避免详情页永远显示“运行中”。 */
  private finishInterruptedArtifacts(runId: string): void {
    for (const artifact of this.pipelineRepo.listArtifacts(runId)) {
      if (artifact.status === 'queued' || artifact.status === 'running') {
        this.pipelineRepo.setArtifact(artifact.id, {
          status: 'failed',
          error: '服务重启中断，可重试',
          endedAt: this.services.clock.iso(),
        });
      }
    }
  }

  private static readonly STEPS = ['verify', 'sidecar', 'cover', 'segment', 'audio', 'convert', 'compress', 'archive'] as const;

  /** 复用既有步骤产物（续跑）或新建；顺带推进进度（步骤名/百分比/心跳/ETA）并推送事件。 */
  private stepStart(run: PipelineRun, step: PipelineStep): PipelineArtifact {
    const existing = this.pipelineRepo.listArtifacts(run.id).find((a) => a.step === step);
    const art = existing ?? this.pipelineRepo.createArtifact({ runId: run.id, step });
    const idx = PipelineManager.STEPS.indexOf(step as (typeof PipelineManager.STEPS)[number]) + 1;
    const pct = Math.round(((idx - 1) / PipelineManager.STEPS.length) * 100);
    const startedAt = run.startedAt ? Date.parse(run.startedAt) : Date.now();
    const elapsed = Math.max(1, Date.now() - startedAt);
    const eta = pct > 0 ? Math.round(((elapsed / pct) * (100 - pct)) / 1000) : null;
    this.pipelineRepo.setRunProgress(run.id, {
      progressStep: step,
      progressPct: pct,
      heartbeatAt: this.services.clock.iso(),
      etaSeconds: eta,
    });
    const fresh = this.pipelineRepo.getRun(run.id);
    if (fresh) {
      this.services.events.emit({ type: 'pipeline:updated', data: { run: fresh, artifacts: this.pipelineRepo.listArtifacts(run.id) } });
    }
    return art;
  }

  /** 跳步判定=状态 ok 且产物有效（存在且非空）；无产物步骤只看状态。 */
  private stepDone(art: PipelineArtifact): boolean {
    if (art.status !== 'ok') return false;
    if (!art.path) return true;
    try {
      return statSync(art.path).size > 0;
    } catch {
      return false;
    }
  }

  private configForRun(run: PipelineRun): PipelineConfig {
    // Every queued run already has a complete snapshot.  Keep explicit defaults
    // for pre-snapshot rows created by older versions.
    return {
      enabled: false,
      verify: true,
      segmentSeconds: 0,
      crf: null,
      archiveDirectory: '',
      maxConcurrency: 2,
      exportAudio: false,
      exportCover: true,
      outputFormat: 'source',
      ...(run.configSnapshot as Partial<PipelineConfig>),
    };
  }

  private async runInner(entry: QueueEntry, resumeRunId?: string): Promise<void> {
    const recording = this.services.recordings.get(entry.recordingId);
    let run: PipelineRun;
    if (resumeRunId) {
      run = this.pipelineRepo.getRun(resumeRunId)!;
    } else if (entry.runId) {
      run = this.pipelineRepo.getRun(entry.runId)!;
    } else {
      const currentConfig = this.pipelineConfig();
      run = this.pipelineRepo.createRun({ recordingId: entry.recordingId, configSnapshot: { ...currentConfig, attempt: entry.attempt } });
    }
    const config = this.configForRun(run);
    this.pipelineRepo.setRunStatus(run.id, 'running');
    this.services.recordings.update(entry.recordingId, { state: 'processing', pipelineStatus: 'running' });
    this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(entry.recordingId)! });

    let finalStatus: PipelineRunStatus = 'ok';
    try {
      if (!recording || !recording.filePath) throw new Error('recording 无文件');

      // ① verify：ffprobe 校验源文件可播（损坏 → failed，保留源文件）。
      // verify 开关门控（默认开，关=本步 skipped 不探测，run 快照语义——task #73 修「说谎开关」）。
    const verify = this.stepStart(run, 'verify');
      if (config.verify) {
        this.pipelineRepo.setArtifact(verify.id, { status: 'running', startedAt: this.services.clock.iso() });
        const integrity = this.stepDone(verify) ? "verified" : await checkFileIntegrity(recording.filePath);
        if (integrity === 'failed') {
          this.pipelineRepo.setArtifact(verify.id, { status: 'failed', error: '源文件损坏或截断', endedAt: this.services.clock.iso() });
          this.services.recordings.update(recording.id, { integrity: 'failed', state: 'completed', pipelineStatus: 'failed' });
          this.finish(run.id, 'failed');
          return;
        }
        if (integrity === 'verified') this.services.recordings.update(recording.id, { integrity: 'verified' });
        this.pipelineRepo.setArtifact(verify.id, { status: 'ok', endedAt: this.services.clock.iso() });
      } else {
        this.pipelineRepo.setArtifact(verify.id, { status: 'skipped', endedAt: this.services.clock.iso() });
      }

      // ② sidecar：写入元数据（真实时长/片段数/清晰度/大小）。
    const sidecar = this.stepStart(run, 'sidecar');
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

      // ③ cover：封面帧（可选，失败不阻断；exportCover 默认开，关=本步 skipped 不执行——task #71，run 快照语义同 exportAudio）。
    const coverArt = this.stepStart(run, 'cover');
      if (config.exportCover) {
        const coverDir = path.join(path.dirname(recording.filePath), '.covers');
        await mkdir(coverDir, { recursive: true });
        const cover = this.stepDone(coverArt) && coverArt.path ? { coverPath: coverArt.path, sizeBytes: coverArt.sizeBytes ?? 0 } : await extractCoverFrame(recording.filePath, coverDir, path.basename(recording.filePath).replace(/\.[^.]+$/, ''));
        if (cover) {
          this.services.recordings.update(recording.id, { coverPath: cover.coverPath });
        }
        this.pipelineRepo.setArtifact(coverArt.id, cover ? { status: 'ok', path: cover.coverPath, sizeBytes: cover.sizeBytes, endedAt: this.services.clock.iso() } : { status: 'skipped', endedAt: this.services.clock.iso() });
      } else {
        this.pipelineRepo.setArtifact(coverArt.id, { status: 'skipped', endedAt: this.services.clock.iso() });
      }

      // ④ segment：切片（segmentSeconds>0 时）。
      if (config.segmentSeconds > 0) {
        const segDir = path.join(path.dirname(recording.filePath), '.segments');
        await mkdir(segDir, { recursive: true });
    const segArt = this.stepStart(run, 'segment');
        this.pipelineRepo.setArtifact(segArt.id, { status: 'running', startedAt: this.services.clock.iso() });
        const seg = this.stepDone(segArt) && segArt.path ? { segments: [segArt.path] } : await segmentFile(recording.filePath, segDir, path.basename(recording.filePath).replace(/\.[^.]+$/, ''), config.segmentSeconds);
        if (seg) {
          this.pipelineRepo.setArtifact(segArt.id, { status: 'ok', path: seg.segments[0] ?? null, sizeBytes: seg.segments.length, endedAt: this.services.clock.iso() });
        } else {
          this.pipelineRepo.setArtifact(segArt.id, { status: 'failed', error: '切片失败', endedAt: this.services.clock.iso() });
          finalStatus = 'partial';
        }
      }

      // ④b audio：导出音频（pipeline.exportAudio，默认关——评估稿 c0e54a5f）。
      // 吃源文件：此时 recording.filePath 尚未被 compress 更新，避免 crf 压缩的音频二次世代损失；失败隔离同 compress 口径。
      if (config.exportAudio) {
    const audioArt = this.stepStart(run, 'audio');
        this.pipelineRepo.setArtifact(audioArt.id, { status: 'running', startedAt: this.services.clock.iso() });
        const audio = this.stepDone(audioArt) && audioArt.path ? { ok: true as const, outPath: audioArt.path, sizeBytes: audioArt.sizeBytes ?? 0 } : await exportAudioToMp3(recording.filePath);
        if (audio.ok) {
          this.pipelineRepo.setArtifact(audioArt.id, { status: 'ok', path: audio.outPath!, sizeBytes: audio.sizeBytes!, endedAt: this.services.clock.iso() });
        } else {
          const reason = audio.reason === 'no_audio' ? '源文件无音轨，无法导出音频' : '音频转码失败，保留源文件';
          this.pipelineRepo.setArtifact(audioArt.id, { status: 'failed', error: reason, endedAt: this.services.clock.iso() });
          finalStatus = 'partial';
          // 失败不静默（同 compress 口径）：仅本步 partial，视频产物/其余步骤/上传不受影响。
          this.services.alerts.create({
            level: 'warning',
            source: 'pipeline',
            message: `音频导出失败（${reason}），视频产物与上传不受影响（${recording.id}）`,
            occurredAt: this.services.clock.iso(),
          });
        }
      }

      // ⑤ convert：格式转换独立于压缩；产物校验完成前不触碰源文件。
      {
        const convertArt = this.stepStart(run, 'convert');
        const ext = path.extname(recording.filePath).toLowerCase();
        if (config.outputFormat !== 'mp4') {
          this.pipelineRepo.setArtifact(convertArt.id, { status: 'skipped', error: '保留原格式', endedAt: this.services.clock.iso() });
        } else if (ext === '.mp4') {
          this.pipelineRepo.setArtifact(convertArt.id, { status: 'skipped', error: '源文件已是 MP4', endedAt: this.services.clock.iso() });
        } else {
          this.pipelineRepo.setArtifact(convertArt.id, { status: 'running', startedAt: this.services.clock.iso() });
          const durationMs = metadata.durationMs ?? 0;
          const space = await this.services.diskGuard.inspect(path.dirname(recording.filePath));
          // 转换写同目录临时文件；可用空间不足时在启动 ffmpeg 前失败，源文件不会被触碰。
          const converted = space.totalBytes > 0 && space.freeBytes < st.size
            ? null
            : this.stepDone(convertArt) && convertArt.path
              ? { outPath: convertArt.path, sizeBytes: convertArt.sizeBytes ?? 0 }
              : await convertToMp4(recording.filePath, {
                onProgress: ({ outTimeMs }) => {
                  const now = Date.now();
                  if (now - (this.lastProgressEmitAt.get(run.id) ?? 0) < 1_000) return;
                  this.lastProgressEmitAt.set(run.id, now);
                  const ratio = durationMs > 0 ? Math.min(0.99, outTimeMs / durationMs) : 0;
                  const progressPct = 62 + Math.round(ratio * 13);
                  this.pipelineRepo.setRunProgress(run.id, { progressStep: 'convert', progressPct, heartbeatAt: this.services.clock.iso(), etaSeconds: null });
                  const fresh = this.pipelineRepo.getRun(run.id);
                  if (fresh) this.services.events.emit({ type: 'pipeline:updated', data: { run: fresh, artifacts: this.pipelineRepo.listArtifacts(run.id) } });
                },
                });
          if (converted) {
            this.services.recordings.update(recording.id, { filePath: converted.outPath, fileSizeBytes: converted.sizeBytes });
            recording.filePath = converted.outPath;
            this.pipelineRepo.setArtifact(convertArt.id, { status: 'ok', path: converted.outPath, sizeBytes: converted.sizeBytes, endedAt: this.services.clock.iso() });
          } else {
            this.pipelineRepo.setArtifact(convertArt.id, { status: 'failed', error: '格式转换失败，已保留并使用源文件', endedAt: this.services.clock.iso() });
            finalStatus = 'partial';
          }
        }
      }

      // ⑥ compress：只做重编码；未启用时明确跳过。
      {
    const compArt = this.stepStart(run, 'compress');
        if (config.crf === null) {
          this.pipelineRepo.setArtifact(compArt.id, { status: 'skipped', endedAt: this.services.clock.iso() });
        } else {
          this.pipelineRepo.setArtifact(compArt.id, { status: 'running', startedAt: this.services.clock.iso() });
          const comp = this.stepDone(compArt) && compArt.path ? { outPath: compArt.path, sizeBytes: compArt.sizeBytes ?? 0 } : await compressOrRemux(recording.filePath, config.crf, {
            onProgress: ({ outTimeMs }) => {
              const now = Date.now();
              if (now - (this.lastProgressEmitAt.get(run.id) ?? 0) < 1_000) return;
              this.lastProgressEmitAt.set(run.id, now);
              const durationMs = metadata.durationMs ?? 0;
              const ratio = durationMs > 0 ? Math.min(0.99, outTimeMs / durationMs) : 0;
              const progressPct = 75 + Math.round(ratio * 13);
              this.pipelineRepo.setRunProgress(run.id, { progressStep: 'compress', progressPct, heartbeatAt: this.services.clock.iso(), etaSeconds: null });
              const fresh = this.pipelineRepo.getRun(run.id);
              if (fresh) this.services.events.emit({ type: 'pipeline:updated', data: { run: fresh, artifacts: this.pipelineRepo.listArtifacts(run.id) } });
            },
          });
          if (comp) {
            // 成功后只切换后续步骤的输入，始终保留源文件。
            this.services.recordings.update(recording.id, { filePath: comp.outPath, fileSizeBytes: comp.sizeBytes });
            recording.filePath = comp.outPath;
            this.pipelineRepo.setArtifact(compArt.id, { status: 'ok', path: comp.outPath, sizeBytes: comp.sizeBytes, endedAt: this.services.clock.iso() });
          } else {
            this.pipelineRepo.setArtifact(compArt.id, { status: 'failed', error: '压缩失败，已保留并使用源文件', endedAt: this.services.clock.iso() });
            finalStatus = 'partial';
            // #229 ①压缩失败告警降级：明确告知上传的将是源文件（不缩容），不静默。
            this.services.alerts.create({
              level: 'warning',
              source: 'pipeline',
              message: `压缩/转封装失败，将上传源文件（${recording.id}）`,
              occurredAt: this.services.clock.iso(),
            });
          }
        }
      }

      // ⑥ archive：归档（copy 到归档目录，保留源文件）。
      if (config.archiveDirectory) {
    const archArt = this.stepStart(run, 'archive');
        this.pipelineRepo.setArtifact(archArt.id, { status: 'running', startedAt: this.services.clock.iso() });
        const archived = this.stepDone(archArt) && archArt.path ? archArt.path : await archiveTo(recording.filePath, config.archiveDirectory);
        if (archived) {
          this.pipelineRepo.setArtifact(archArt.id, { status: 'ok', path: archived, sizeBytes: (await stat(archived as string).catch(() => ({ size: 0 }))).size, endedAt: this.services.clock.iso() });
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

  /** 启动/继续管线的前置检查：只挡「无文件/空文件」。可读即可跑——损坏/截断的判定交给管线
   * 内的 verify 步（给明确原因），不在此处误挡尾部截断等可救文件。 */
  async quickMediaCheck(filePath: string): Promise<{ ok: boolean; reason?: string }> {
    const st = await stat(filePath).catch(() => null);
    if (!st || st.size === 0) return { ok: false, reason: '文件为空或不存在' };
    return { ok: true };
  }

  /** 断点续跑：已完成且产物有效的步骤跳过，缺损步骤从该步重跑（用原 run 配置快照）。 */
  async resumeRunById(runId: string): Promise<boolean> {
    const run = this.pipelineRepo.getRun(runId);
    if (!run || run.status === 'ok' || run.status === 'failed') return false;
    const rec = this.services.recordings.get(run.recordingId);
    if (!rec || !rec.filePath) return false;
    if (this.running.has(run.recordingId) || this.queue.some((entry) => entry.recordingId === run.recordingId)) return false;
    const entry: QueueEntry = { recordingId: run.recordingId, attempt: (run.configSnapshot.attempt as number | undefined) ?? 0 };
    // Recovery must share the normal FIFO and concurrency ceiling: a restart
    // can otherwise launch every orphaned ffmpeg job at once.
    this.queue.push({ ...entry, runId: run.id });
    this.services.recordings.update(run.recordingId, { state: 'processing', pipelineStatus: 'queued' });
    this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(run.recordingId)! });
    this.pump();
    return true;
  }

  private finish(runId: string, status: PipelineRunStatus): void {
    this.lastProgressEmitAt.delete(runId);
    this.pipelineRepo.setRunStatus(runId, status, this.services.clock.iso());
    const run = this.pipelineRepo.getRun(runId);
    if (run) {
      // 同步 recordings.pipelineStatus 与 state。
      const pipelineStatus = status === 'ok' ? 'ok' : status === 'partial' ? 'partial' : status === 'failed' ? 'failed' : 'queued';
      this.services.recordings.update(run.recordingId, { state: 'completed', pipelineStatus });
      this.services.events.emit({ type: 'recording:updated', data: this.services.recordings.get(run.recordingId)! });
      // 管线完成（ok/partial）后触发 OpenList 上传（若启用）。
      if (status === 'ok' || status === 'partial') {
        void this.services.uploader.enqueue(run.recordingId, { automatic: true }).catch(() => undefined);
      }
    }
  }
}

async function probeDurationMs(filePath: string): Promise<number | null> {
  try {
    const { spawn } = await import('node:child_process');
    return await new Promise<number | null>((resolve) => {
      const child = spawn(resolveBin('ffprobe'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath], { windowsHide: true });
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
