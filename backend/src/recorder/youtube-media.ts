import { MediaWorkQueue } from "./media-work-queue.js";
import {
  recoverRecordingBuffer,
  hasPendingRecordingBuffer,
} from "./buffered-writer.js";
import {
  readFile,
  writeFile,
  rename,
  stat,
  rm,
  mkdtemp,
  link,
  open,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { runFfmpegTracked } from "./ffmpeg-run.js";
import { AppError } from "../types/error.js";

export interface YoutubePart {
  path: string;
  offsetMs: number;
  durationMs: number;
}
export const youtubeManifest = (file: string) => `${file}.youtube.json`;
const publishJournal = (file: string) => `${file}.youtube-publish.json`;
type MediaIdentity = { dev: number; ino: number; size: number; mtimeMs: number };
type PublishJournal = { version: 1; output: MediaIdentity; parts: YoutubePart[] };
const mediaLocks = new Map<string, { queue: MediaWorkQueue; users: number }>();
async function withMediaLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  let entry = mediaLocks.get(key);
  if (!entry) { entry = { queue: new MediaWorkQueue(1), users: 0 }; mediaLocks.set(key, entry); }
  entry.users++;
  try { return await entry.queue.run(work); }
  finally { if (--entry.users === 0) mediaLocks.delete(key); }
}
function validateParts(file: string, value: unknown): asserts value is YoutubePart[] {
  if (!Array.isArray(value) || value.length > 10_000 || value.some(p =>
    !p || typeof p !== 'object' || typeof p.path !== 'string' ||
    !(path.resolve(p.path) === path.resolve(file) ||
      (path.resolve(p.path).startsWith(path.resolve(file) + '.part-') &&
        /^\d+\.mkv$/.test(path.resolve(p.path).slice(path.resolve(file).length + 6)))) ||
    /[\r\n]/.test(p.path) || !Number.isFinite(p.offsetMs) || p.offsetMs < 0 ||
    !Number.isFinite(p.durationMs) || p.durationMs < 0)) throw new Error('Invalid segment manifest');
}
async function readPublishJournal(file: string): Promise<PublishJournal | null> {
  let data;
  try { data = JSON.parse(await readFile(publishJournal(file), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  validateParts(file, data?.parts);
  if (data.version !== 1 || !data.output ||
    !['dev', 'ino', 'size', 'mtimeMs'].every(key => Number.isFinite(data.output[key]) && data.output[key] >= 0) ||
    data.output.size === 0) throw new Error('Invalid YouTube publication journal');
  return data as PublishJournal;
}
async function matchesIdentity(file: string, expected: MediaIdentity): Promise<boolean> {
  const info = await stat(file).catch(() => null);
  return !!info && info.dev === expected.dev && info.ino === expected.ino &&
    info.size === expected.size && info.mtimeMs === expected.mtimeMs;
}
/** Complete an interrupted publication before exposing the source to a reader. */
async function recoverPublication(file: string): Promise<void> {
  const journal = await readPublishJournal(file);
  if (!journal) return;
  if (!await matchesIdentity(file, journal.output)) {
    const temp = `${file}.finalizing.mkv`;
    if (!await matchesIdentity(temp, journal.output))
      throw new AppError('RECORDING_REMUX_FAILED', '录像整理状态无法确认，已保留原文件与分段供恢复');
    await rename(temp, file);
  }
  for (const part of journal.parts) if (path.resolve(part.path) !== path.resolve(file))
    await rm(part.path, { force: true });
  await rm(youtubeManifest(file), { force: true });
  await rm(`${youtubeManifest(file)}.tmp`, { force: true });
  await rm(publishJournal(file), { force: true });
}
export async function readYoutubeParts(file: string): Promise<YoutubePart[]> {
  try {
    const journal = await readPublishJournal(file);
    // A crash after replacement must not concatenate the merged file with its
    // old parts a second time. Readers pin under the same lock as publication.
    if (journal && await matchesIdentity(file, journal.output)) return [];
    const parts: YoutubePart[] = JSON.parse(
      await readFile(youtubeManifest(file), "utf8"),
    );
    validateParts(file, parts);
    return parts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function saveYoutubeParts(
  file: string,
  parts: YoutubePart[],
): Promise<void> {
  const manifest = youtubeManifest(file);
  await writeFile(`${manifest}.tmp`, JSON.stringify(parts));
  await rename(`${manifest}.tmp`, manifest);
}
export interface YoutubeMediaInput {
  args: string[];
  fileDescriptors: number[];
  readHeader(): Promise<Buffer>;
  dispose(): Promise<void>;
}
/** Pin file identities with hard links: clipping/seek snapshots survive finalization and renames without copying video bytes. */
export async function youtubeInput(
  file: string,
  snapshot = true,
  hardLink: typeof link = link,
): Promise<YoutubeMediaInput> {
  return withMediaLock(file, async () => {
    await recoverPublication(file);
    return openYoutubeInput(file, snapshot, hardLink);
  });
}
async function openYoutubeInput(file: string, snapshot: boolean, hardLink: typeof link): Promise<YoutubeMediaInput> {
  const saved = await readYoutubeParts(file);
  const candidates = saved.length
    ? saved
    : [{ path: file, durationMs: 0, offsetMs: 0 }];
  const parts: YoutubePart[] = [];
  for (const part of candidates) {
    const info = await stat(part.path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && part.durationMs === 0) return null;
      throw error;
    });
    // A failed initial connection may leave an empty first part before a
    // successful reconnect. It must not poison the valid later segments.
    if (info?.size) parts.push(part);
    else if (part.durationMs > 0) throw new AppError('RECORDING_NOT_AVAILABLE', '录像分段为空，已保留原始分段供恢复');
  }
  if (!parts.length) throw new AppError('RECORDING_NOT_AVAILABLE', '暂无可读取的有效录像分段');
  const directory = await mkdtemp(
    path.join(path.dirname(file), ".lr-youtube-read-"),
  );
  const handles: FileHandle[] = [];
  let disposal: Promise<void> | undefined;
  const dispose = () => disposal ??= (async () => {
    await Promise.all(handles.map(handle => handle.close()));
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  })();
  try {
    const pinned: Array<{ path: string; durationMs: number; handle?: FileHandle }> = [];
    for (const [index, part] of parts.entries()) {
      const target = path.join(directory, `${index}.mkv`);
      let source = part.path;
      let inherited: FileHandle | undefined;
      if (snapshot) {
        try { await hardLink(part.path, target); source = target; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS'].includes(code ?? '')) throw error;
          if (process.platform === 'win32') throw new AppError('RECORDING_NOT_AVAILABLE', '此磁盘不支持录像快照，请使用支持硬链接的 NTFS 目录');
          // ExFAT cannot hard-link. Inherit an open file descriptor instead:
          // /dev/fd remains bound to the inode through rename/unlink, with no
          // whole-video copy and no lock on recording finalization.
          const handle = await open(part.path, 'r');
          inherited = handle;
          source = `/dev/fd/${3 + handles.length}`;
          handles.push(handle);
        }
      }
      pinned.push({
        path: source,
        durationMs: part.durationMs,
        ...(inherited ? { handle: inherited } : {}),
      });
    }
    const list = path.join(directory, "input.ffconcat");
    await writeFile(
      list,
      "ffconcat version 1.0\n" +
        pinned
          .map(
            (p) =>
              `file '${p.path.replaceAll("'", "'\\''")}'\n${p.durationMs > 0 ? `duration ${p.durationMs / 1000}\n` : ""}`,
          )
          .join(""),
    );
    return {
      // A completed single file already has a seekable container duration and
      // cues. Wrapping it in an unknown-duration concat hides both from readers.
      args: pinned.length === 1 ? ['-i', pinned[0]!.path] : ["-f", "concat", "-safe", "0", "-i", list],
      fileDescriptors: handles.map(handle => handle.fd),
      async readHeader() {
        // Inspect the same pinned inode that FFmpeg reads, even after rename or
        // finalization. /dev/fd/3 is a child descriptor, not a parent file path.
        const first = pinned[0]!;
        const handle = first.handle ?? await open(first.path, 'r');
        try {
          const head = Buffer.alloc(128 * 1024);
          const { bytesRead } = await handle.read(head, 0, head.length, 0);
          return head.subarray(0, bytesRead);
        } finally { if (!first.handle) await handle.close(); }
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
export async function youtubeSize(file: string): Promise<number> {
  const parts = await readYoutubeParts(file);
  const sizes = await Promise.all(
    (parts.length ? parts.map((p) => p.path) : [file]).map((p) =>
      stat(p).then(
        (s) => s.size,
        () => 0,
      ),
    ),
  );
  return sizes.reduce((sum, size) => sum + size, 0);
}
export async function removeYoutubeParts(file: string): Promise<void> {
  // A deleting record must not be resurrected by a finalizer finishing later.
  await finalizations.get(path.resolve(file))?.catch(() => undefined);
  await withMediaLock(file, async () => {
    for (const related of await youtubeStorageFiles(file))
      if (path.resolve(related) !== path.resolve(file)) await rm(related, { force: true });
  });
}
/** All owned paths, including an interrupted publication, for reset/deletion. */
export async function youtubeStorageFiles(file: string): Promise<string[]> {
  const journal = await readPublishJournal(file);
  return [...new Set([file, ...(await readYoutubeParts(file)).map(part => part.path),
    ...(journal?.parts ?? []).map(part => part.path), `${file}.finalizing.mkv`,
    youtubeManifest(file), `${youtubeManifest(file)}.tmp`, `${publishJournal(file)}.tmp`, publishJournal(file)])];
}
/** Finalize once, rather than rewriting hours of video on every reconnect. */
async function finalizeYoutubeInner(
  file: string,
  bufferDirectory?: string,
): Promise<void> {
  const parts = await withMediaLock(file, async () => {
    await recoverPublication(file);
    return readYoutubeParts(file);
  });
  if (!parts.length) return;
  if (bufferDirectory)
    for (const part of parts) {
      await recoverRecordingBuffer(bufferDirectory, part.path);
      if (hasPendingRecordingBuffer(bufferDirectory, part.path))
        throw new AppError(
          "RECORDING_WRITE_FAILED",
          "录像分段仍有待恢复的暂存数据，已保留原始内容",
        );
    }
  const temp = `${file}.finalizing.mkv`;
  const input = await youtubeInput(file, false);
  let result;
  try {
    result = await runFfmpegTracked([
      "-y",
      ...input.args,
      "-map",
      "0:v?",
      "-map",
      "0:a?",
      "-c",
      "copy",
      temp,
    ]);
  } finally {
    await input.dispose();
  }
  if (!result.ok || !(await stat(temp).catch(() => null))?.size) {
    await rm(temp, { force: true });
    throw new AppError(
      "RECORDING_REMUX_FAILED",
      "YouTube 录像合并失败，原始分段已保留，可重新处理",
      { retryable: true },
    );
  }
  await withMediaLock(file, async () => {
    const info = await stat(temp);
    const journal: PublishJournal = { version: 1, parts,
      output: { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs } };
    await writeFile(`${publishJournal(file)}.tmp`, JSON.stringify(journal));
    await rename(`${publishJournal(file)}.tmp`, publishJournal(file));
    await recoverPublication(file);
  });
  await rm(`${file}.youtube.ffconcat`, { force: true });
}

const finalizations = new Map<string, Promise<void>>();
const finalizationQueue = new MediaWorkQueue(2);
export function finalizeYoutube(
  file: string,
  bufferDirectory?: string,
): Promise<void> {
  file = path.resolve(file);
  const previous = finalizations.get(file);
  if (previous) return previous;
  if (finalizations.size >= 32)
    return Promise.reject(
      new AppError("CONCURRENT_LIMIT_REACHED", "录像整理任务过多，请稍后重试"),
    );
  const task = finalizationQueue
    .run(() => finalizeYoutubeInner(file, bufferDirectory))
    .finally(() => finalizations.delete(file));
  finalizations.set(file, task);
  return task;
}
