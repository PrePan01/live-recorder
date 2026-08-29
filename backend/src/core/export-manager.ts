import { mkdir, copyFile, writeFile, stat, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Services } from './services.js';
import type { ExportJob } from '../types/index.js';
import { ExportRepository } from '../db/repositories/export.repo.js';
import { APP_VERSION } from '../sidecar/types.js';

/**
 * 录制备份与导出（V5 Batch3 #127）：单场/批量打包为目录（源文件 + sidecar 元数据 + 封面），
 * 生成 manifest.json（含哈希/版本，不含密钥）。缺失 sidecar/封面标部分成功，不损坏源文件。
 */
export class ExportManager {
  private repo: ExportRepository;

  constructor(private services: Services) {
    this.repo = new ExportRepository(services.db);
  }

  get exportRepo(): ExportRepository {
    return this.repo;
  }

  /** 创建导出任务（目标目录 = 用户选择的导出根目录/export_<ts>/）。 */
  async create(recordingIds: string[], baseDir: string): Promise<ExportJob> {
    const job = this.repo.create({ recordingIds });
    const dir = path.join(baseDir, `export_${this.services.clock.iso().replace(/[-:]/g, '').replace('.', '_')}`);
    void this.run(job.id, dir);
    return job;
  }

  cancel(jobId: string): ExportJob | null {
    const job = this.repo.get(jobId);
    if (!job) return null;
    if (job.status === 'queued' || job.status === 'running') {
      this.repo.update(jobId, { status: 'cancelled' });
    }
    return this.repo.get(jobId);
  }

  private async run(jobId: string, dir: string): Promise<void> {
    const job = this.repo.get(jobId);
    if (!job) return;
    const manifest: {
      version: string;
      appVersion: string;
      exportedAt: string;
      recordings: Array<{ id: string; file: string | null; hash: string | null; metadata: Record<string, unknown> | null; cover: string | null; status: string }>;
    } = { version: '1', appVersion: APP_VERSION, exportedAt: this.services.clock.iso(), recordings: [] };

    try {
      await mkdir(dir, { recursive: true });
      this.repo.update(jobId, { status: 'running', progress: 5 });
      let missing = 0;
      let idx = 0;
      for (const recId of job.recordingIds) {
        if (this.repo.get(jobId)?.status === 'cancelled') return;
        const rec = this.services.recordings.get(recId);
        if (!rec) {
          manifest.recordings.push({ id: recId, file: null, hash: null, metadata: null, cover: null, status: 'missing' });
          missing += 1;
          continue;
        }
        const entry: { id: string; file: string | null; hash: string | null; metadata: Record<string, unknown> | null; cover: string | null; status: string } = {
          id: rec.id,
          file: null,
          hash: null,
          metadata: rec.metadata ? { ...rec.metadata } : null,
          cover: null,
          status: 'ok',
        };
        // 源文件。
        if (rec.filePath) {
          try {
            const dest = path.join(dir, path.basename(rec.filePath));
            await copyFile(rec.filePath, dest);
            entry.file = path.basename(rec.filePath);
            entry.hash = await sha256(rec.filePath);
          } catch {
            entry.status = 'partial';
            missing += 1;
          }
        } else {
          entry.status = 'partial';
          missing += 1;
        }
        // 封面（缺失 → partial 但不失败）。
        if (rec.coverPath) {
          try {
            const coverDest = path.join(dir, path.basename(rec.coverPath));
            await copyFile(rec.coverPath, coverDest);
            entry.cover = path.basename(rec.coverPath);
          } catch {
            entry.status = entry.status === 'ok' ? 'partial' : entry.status;
          }
        }
        manifest.recordings.push(entry);
        idx += 1;
        this.repo.update(jobId, { progress: 5 + Math.round((idx / job.recordingIds.length) * 90) });
      }
      // manifest.json。
      const manifestPath = path.join(dir, 'manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
      const size = (await stat(dir).catch(() => ({ size: 0 }))).size;
      this.repo.update(jobId, {
        status: missing > 0 ? 'partial' : 'ok',
        outputPath: dir,
        manifestPath,
        sizeBytes: size,
        progress: 100,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '导出失败';
      this.repo.update(jobId, { status: 'failed', error: message });
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** SHA-256 文件哈希（manifest 完整性校验，不含密钥）。 */
async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (c: string | Buffer) => hash.update(c));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}