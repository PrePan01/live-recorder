import { parentPort, workerData } from 'node:worker_threads';
import { mkdtemp, open, stat, rm, unlink, type FileHandle } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { AppError } from '../types/error.js';
import { DanmakuStore } from './store.js';
import { AssRenderer, validSubtitleMessage, srtHeader, srtText } from './subtitle-renderer.js';
import type { DanmakuExportOptions, DanmakuExportResult } from './export.js';
import type { DanmakuMessage } from './types.js';

/** Flush at 64 KiB; even a huge group at the same timestamp never accumulates in JS. */
class SubtitleWriter {
  private parts: string[] = [];
  private bytes = 0;
  constructor(private file: FileHandle) {}
  async append(text: string): Promise<void> {
    this.parts.push(text); this.bytes += Buffer.byteLength(text);
    if (this.bytes >= 65536) await this.flush();
  }
  async flush(): Promise<void> {
    if (!this.bytes) return;
    await this.file.writeFile(this.parts.join(''), 'utf8');
    this.parts = []; this.bytes = 0;
  }
}
async function reserveFiles(recording: string, directory: string) {
  const stem = basename(recording, extname(recording)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '') || '录像';
  for (let index = 0; index < 10000; index++) {
    const name = `${stem}${index ? ` (${index})` : ''}`;
    const assPath = join(directory, `${name}.ass`), srtPath = join(directory, `${name}.srt`);
    const ass = await open(assPath, 'wx').catch(error => {
      if (error.code === 'EEXIST') return null;
      throw error;
    });
    if (!ass) continue;
    try { return { assPath, srtPath, ass, srt: await open(srtPath, 'wx') }; }
    catch (error) {
      await ass.close(); await unlink(assPath);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new AppError('RECORDING_WRITE_FAILED', '导出目录中同名文件过多');
}
async function run(recordingFilePath: string, options: DanmakuExportOptions): Promise<DanmakuExportResult> {
  if (!isAbsolute(options.directory) || !(await stat(options.directory).catch(() => null))?.isDirectory()) {
    throw new AppError('RECORDING_DIRECTORY_INVALID', '请选择有效的导出目录');
  }
  const store = await DanmakuStore.openExisting(recordingFilePath);
  if (!store) throw new AppError('RECORDING_EMPTY', '该录像没有可导出的弹幕');
  const scratch = await mkdtemp(join(tmpdir(), 'lr-danmaku-export-'));
  let db: Database.Database | undefined;
  let files: Awaited<ReturnType<typeof reserveFiles>> | undefined;
  let success = false;
  try {
    db = new Database(join(scratch, 'sort.sqlite'));
    // Sorting and ordered traversal use disk, with a fixed SQLite page cache.
    db.pragma('journal_mode = OFF'); db.pragma('synchronous = OFF');
    db.pragma('temp_store = FILE'); db.pragma('cache_size = -2048');
    db.exec('CREATE TABLE messages (seq INTEGER PRIMARY KEY, tMs REAL NOT NULL, start INTEGER NOT NULL, text TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO messages (tMs,start,text) VALUES (?,?,?)');
    const gaps = await store.readGaps();
    let count = 0;
    db.exec('BEGIN');
    for await (const m of store.readMessages()) {
      if (!validSubtitleMessage(m, gaps, options)) continue;
      insert.run(m.tMs, Math.floor(m.tMs!), m.text);
      if (++count % 1000 === 0) db.exec('COMMIT; BEGIN');
    }
    db.exec('COMMIT');
    if (!count) throw new AppError('RECORDING_EMPTY', '该录像没有可定位到视频时间的弹幕');
    db.exec('CREATE INDEX ordered_messages ON messages(start,tMs,seq)');
    files = await reserveFiles(recordingFilePath, options.directory);
    const ass = new AssRenderer(options), assFile = new SubtitleWriter(files.ass), srtFile = new SubtitleWriter(files.srt);
    await assFile.append(ass.header());
    const starts = db.prepare('SELECT DISTINCT start FROM messages ORDER BY start').iterate() as IterableIterator<{ start: number }>;
    let current = starts.next(), next = starts.next(), previous = -1, group = 0;
    for (const row of db.prepare('SELECT tMs,start,text FROM messages ORDER BY start,tMs,seq').iterate() as IterableIterator<{ tMs: number; start: number; text: string }>) {
      if (row.start !== previous) {
        if (group) { await srtFile.append('\n'); current = next; next = starts.next(); }
        await srtFile.append(srtHeader(++group, current.value!.start, next.done ? Infinity : next.value.start, options.durationMs));
        previous = row.start;
      }
      await srtFile.append(srtText(row.text) + '\n');
      const line = ass.line({ tMs: row.tMs, text: row.text } as DanmakuMessage);
      if (line) await assFile.append(line);
    }
    await Promise.all([assFile.flush(), srtFile.flush()]);
    await Promise.all([files.ass.close(), files.srt.close()]);
    success = true;
    return { assPath: files.assPath, srtPath: files.srtPath, count, assCount: ass.count };
  } finally {
    db?.close();
    if (files && !success) {
      await Promise.allSettled([files.ass.close(), files.srt.close()]);
      await Promise.allSettled([unlink(files.assPath), unlink(files.srtPath)]);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}
const input = workerData as { recordingFilePath: string; options: DanmakuExportOptions };
run(input.recordingFilePath, input.options).then(
  result => parentPort!.postMessage({ result }),
  error => parentPort!.postMessage({ error: { code: error instanceof AppError ? error.code : 'RECORDING_WRITE_FAILED', message: error instanceof Error ? error.message : '弹幕导出失败' } }),
);
