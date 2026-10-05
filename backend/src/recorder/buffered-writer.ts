import { createReadStream, readdirSync, type WriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { AppError } from "../types/error.js";

export const RECORDING_MEMORY_BYTES = 32 * 1024 ** 2;
export const RECORDING_SPOOL_BYTES = 512 * 1024 ** 2;
const GLOBAL_SPOOL_BYTES = 2 * 1024 ** 3;
const RESERVE_BYTES = 1024 ** 3;
let reservedSpoolBytes = 0;
const scannedRoots = new Map<string, Promise<void>>();
async function accountExistingSpool(root: string): Promise<void> {
  let scan = scannedRoots.get(root);
  if (!scan) {
    scan = (async () => {
      for (const dir of await readdir(root).catch(() => [] as string[])) {
        if (!/^[a-f0-9]{64}$/.test(dir)) continue;
        for (const name of await readdir(path.join(root, dir)).catch(
          () => [] as string[],
        )) {
          if (!/^\d+-[a-f0-9-]+\.buffer$/.test(name)) continue;
          reservedSpoolBytes +=
            (await stat(path.join(root, dir, name)).catch(() => null))?.size ??
            0;
        }
      }
    })();
    scannedRoots.set(root, scan);
  }
  await scan;
}

interface Entry {
  offset: number;
  length: number;
  data: Buffer;
  spool?: string;
  committed?: () => void;
}
export interface BufferedWriterOptions {
  directory?: string;
  baseBytes?: number;
  memoryBytes?: number;
  spoolBytes?: number;
  idleTimeoutMs?: number;
  recordingId?: string;
}
export function recordingSpoolDirectory(root: string, target: string): string {
  return path.join(
    root,
    createHash("sha256").update(path.resolve(target)).digest("hex"),
  );
}

/** One ordered writer for both recording paths. Admission applies backpressure;
 * it never drops media. Only successful target write callbacks commit progress. */
export class BufferedRecordingWriter {
  private entries: Entry[] = [];
  private memory = 0;
  private disk = 0;
  private offset: number;
  private pump: Promise<void> | null = null;
  private error: Error | null = null;
  private closed = false;
  private admitting = false;
  private admissions = 0;
  private changed = new Set<() => void>();
  private readonly directory: string;
  private readonly root: string;
  private closing: Promise<void> | null = null;
  private manifestReady = false;
  private readonly manifest: {
    version: number;
    target: string;
    recordingId?: string;
  };
  private readonly memoryLimit: number;
  private readonly diskLimit: number;
  private readonly idleTimeout: number;

  constructor(
    private readonly stream: WriteStream,
    target: string,
    options: BufferedWriterOptions = {},
  ) {
    this.offset = options.baseBytes ?? 0;
    this.manifest = {
      version: 1,
      target: path.resolve(target),
      ...(options.recordingId ? { recordingId: options.recordingId } : {}),
    };
    this.memoryLimit = options.memoryBytes ?? RECORDING_MEMORY_BYTES;
    this.diskLimit = options.spoolBytes ?? RECORDING_SPOOL_BYTES;
    this.idleTimeout = options.idleTimeoutMs ?? 180_000;
    this.root =
      options.directory ?? path.join(tmpdir(), "live-recorder-buffer");
    this.directory = recordingSpoolDirectory(this.root, target);
    stream.on("error", (error) => {
      this.error ??= error;
      this.wake();
    });
  }
  get pendingBytes(): number {
    return this.memory;
  }
  get spooledBytes(): number {
    return this.disk;
  }
  failed(): Error | null {
    return this.error;
  }

  private wake(): void {
    for (const fn of this.changed) fn();
    this.changed.clear();
  }
  private async wait(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.changed.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.changed.delete(done);
        reject(
          new AppError(
            "RECORDING_WRITE_SLOW",
            "存储写入持续阻塞，已保留可恢复的暂存内容",
            {
              retryable: false,
              details: { pendingBytes: this.memory, spooledBytes: this.disk },
            },
          ),
        );
      }, this.idleTimeout);
      this.changed.add(done);
    });
  }

  private async spill(entry: Entry, source?: string): Promise<boolean> {
    if (entry.spool) return true;
    await accountExistingSpool(this.root);
    if (
      this.disk + entry.length > this.diskLimit ||
      reservedSpoolBytes + entry.length > GLOBAL_SPOOL_BYTES
    )
      return false;
    await mkdir(this.directory, { recursive: true });
    const fs = await statfs(this.directory);
    if (
      fs.bavail * fs.bsize < RESERVE_BYTES + entry.length ||
      reservedSpoolBytes + entry.length > GLOBAL_SPOOL_BYTES
    )
      return false;
    if (!this.manifestReady) {
      await writeFile(
        path.join(this.directory, "manifest.json.part"),
        JSON.stringify(this.manifest),
      );
      await rename(
        path.join(this.directory, "manifest.json.part"),
        path.join(this.directory, "manifest.json"),
      );
      this.manifestReady = true;
    }
    const file = path.join(
      this.directory,
      `${entry.offset}-${randomUUID()}.buffer`,
    );
    // Other recording writers may have reserved space during manifest I/O.
    if (reservedSpoolBytes + entry.length > GLOBAL_SPOOL_BYTES) return false;
    reservedSpoolBytes += entry.length;
    this.disk += entry.length;
    try {
      // Atomic publication: recovery never sees an incomplete spool record.
      if (source) await copyFile(source, file + ".part");
      else await writeFile(file + ".part", entry.data);
      await rename(file + ".part", file);
      entry.spool = file;
      return true;
    } catch (error) {
      this.disk -= entry.length;
      reservedSpoolBytes -= entry.length;
      await rm(file + ".part", { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async write(data: Buffer, committed?: () => void): Promise<void> {
    if (this.closed) throw new Error("recording writer is closed");
    if (this.error) throw this.error;
    // Calls are serialized by the input consumer, while target writes run independently.
    this.admissions++;
    this.admitting = true;
    try {
      while (
        this.memory + data.length > this.memoryLimit &&
        this.entries.length > 0
      ) {
        // Persist the entire pending prefix before publishing later offsets. On
        // restart, this permits ordered replay even if a target write was partial.
        for (const entry of this.entries) {
          if (!(await this.spill(entry))) break;
        }
        // Spooling keeps only the current target block in RAM. Queued blocks are
        // read back individually by the pump.
        for (const entry of this.entries.slice(1)) {
          if (entry.spool && entry.data.length > 0) {
            this.memory -= entry.data.length;
            entry.data = Buffer.alloc(0);
          }
        }
        if (
          this.memory + data.length <= this.memoryLimit ||
          this.entries.every((entry) => entry.spool)
        )
          break;
        this.admitting = false;
        this.startPump();
        await this.wait();
        if (this.error) throw this.error;
        this.admitting = true;
      }
      const entry: Entry = {
        offset: this.offset,
        length: data.length,
        data: Buffer.from(data),
        ...(committed ? { committed } : {}),
      };
      if (this.disk > 0 || data.length > this.memoryLimit) {
        while (!(await this.spill(entry))) {
          this.admitting = false;
          this.startPump();
          await this.wait();
          if (this.error) throw this.error;
          this.admitting = true;
        }
      }
      if (entry.spool) entry.data = Buffer.alloc(0);
      this.offset += data.length;
      this.memory += entry.data.length;
      this.entries.push(entry);
    } finally {
      this.admissions--;
      this.admitting = false;
      this.startPump();
      this.wake();
    }
  }

  /** Admit a fully downloaded HLS segment without loading it into RAM. */
  async writeStagedFile(
    source: string,
    length: number,
    committed: () => void,
  ): Promise<void> {
    if (this.closed) throw new Error("recording writer is closed");
    if (this.error) throw this.error;
    this.admissions++;
    this.admitting = true;
    try {
      const entry: Entry = {
        offset: this.offset,
        length,
        data: Buffer.alloc(0),
        committed,
      };
      for (;;) {
        let prefixSaved = true;
        for (const pending of this.entries)
          if (!(await this.spill(pending))) {
            prefixSaved = false;
            break;
          }
        if (prefixSaved && (await this.spill(entry, source))) break;
        this.admitting = false;
        this.startPump();
        await this.wait();
        if (this.error) throw this.error;
        this.admitting = true;
      }
      this.offset += length;
      this.entries.push(entry);
    } finally {
      this.admissions--;
      this.admitting = false;
      this.startPump();
      this.wake();
    }
  }

  private startPump(): void {
    if (this.pump || this.error || this.admitting || this.entries.length === 0)
      return;
    this.pump = (async () => {
      while (this.entries.length > 0 && !this.admitting) {
        const entry = this.entries[0]!;
        const writeTarget = async (data: Buffer) => {
          await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
              cleanup();
              reject(error);
            };
            const onClose = () => {
              cleanup();
              reject(new Error("录制写入器提前关闭"));
            };
            const cleanup = () => {
              this.stream.removeListener("error", onError);
              this.stream.removeListener("close", onClose);
              clearTimeout(timer);
            };
            const timer = setTimeout(() => {
              const error = new AppError(
                "RECORDING_WRITE_SLOW",
                "磁盘写入持续阻塞",
                { retryable: false },
              );
              cleanup();
              this.stream.destroy(error);
              reject(error);
            }, this.idleTimeout);
            this.stream.once("error", onError);
            this.stream.once("close", onClose);
            this.stream.write(data, (error) => {
              cleanup();
              error ? reject(error) : resolve();
            });
          });
        };
        if (entry.data.length) await writeTarget(entry.data);
        else
          for await (const chunk of createReadStream(entry.spool!, {
            highWaterMark: 256 * 1024,
          }))
            await writeTarget(Buffer.from(chunk));
        // Admission may have spooled this in-flight entry while write waited.
        while (this.admitting)
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        entry.committed?.();
        this.memory -= entry.data.length;
        this.entries.shift();
        if (entry.spool) {
          await rm(entry.spool, { force: true });
          this.disk -= entry.length;
          reservedSpoolBytes -= entry.length;
        }
        this.wake();
      }
    })()
      .catch((error) => {
        this.error ??= error;
        this.wake();
      })
      .finally(() => {
        this.pump = null;
        this.startPump();
      });
  }

  close(): Promise<void> {
    this.closing ??= this.finish();
    return this.closing;
  }

  private async finish(): Promise<void> {
    this.closed = true;
    // Admission already owns its bounded wait; closing must await its cleanup.
    while (this.admissions > 0)
      await new Promise<void>((resolve) => this.changed.add(resolve));
    this.startPump();
    while (this.pump) await this.pump;
    if (this.error) {
      // Best effort salvage; leave durable records for startup recovery.
      for (const entry of this.entries)
        if (entry.data.length) await this.spill(entry).catch(() => false);
      await this.waitForClose();
      throw this.error;
    }
    await new Promise<void>((resolve, reject) => {
      const error = (e: Error) => {
        this.stream.removeListener("finish", finish);
        reject(e);
      };
      const finish = () => {
        this.stream.removeListener("error", error);
        resolve();
      };
      this.stream.once("error", error);
      this.stream.once("finish", finish);
      this.stream.end();
    });
    await this.waitForClose();
    if (this.error) throw this.error;
    await rm(path.join(this.directory, "manifest.json"), { force: true });
    await rmdir(this.directory).catch(() => undefined);
  }
  private async waitForClose(): Promise<void> {
    if (this.stream.closed) return;
    await new Promise<void>((resolve) => {
      this.stream.once("close", resolve);
      this.stream.destroy();
    });
  }
}

/** Replay only the explicitly supplied recording's spool. Positional writes
 * make a restart during replay idempotent; a missing prefix is never invented. */
export async function recoverRecordingBuffer(
  root: string,
  target: string,
): Promise<number> {
  await accountExistingSpool(root);
  const directory = recordingSpoolDirectory(root, target);
  const names = (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => /^\d+-[a-f0-9-]+\.buffer$/.test(name))
    .sort((a, b) => Number(a.split("-")[0]) - Number(b.split("-")[0]));
  if (!names.length) return 0;
  const handle = await open(target, "r+");
  let recovered = 0;
  try {
    let size = (await handle.stat()).size;
    for (const name of names) {
      const offset = Number(name.split("-")[0]);
      const file = path.join(directory, name);
      if (!Number.isSafeInteger(offset) || offset > size)
        throw new Error("暂存前缺少媒体数据，保留缓存等待人工恢复");
      const st = await stat(file);
      if (st.size > RECORDING_SPOOL_BYTES)
        throw new Error("invalid recording buffer size");
      let position = offset;
      let added = 0;
      for await (const chunk of createReadStream(file, {
        highWaterMark: 256 * 1024,
      })) {
        const data = Buffer.from(chunk);
        const overlap = Math.min(data.length, Math.max(0, size - position));
        if (overlap) {
          const existing = Buffer.alloc(overlap);
          let read = 0;
          while (read < overlap) {
            const result = await handle.read(
              existing,
              read,
              overlap - read,
              position + read,
            );
            if (!result.bytesRead)
              throw new Error("recording recovery made no read progress");
            read += result.bytesRead;
          }
          if (!existing.equals(data.subarray(0, overlap)))
            throw new Error("暂存与录像内容不一致，保留缓存");
        }
        let written = overlap;
        while (written < data.length) {
          const result = await handle.write(
            data,
            written,
            data.length - written,
            position + written,
          );
          if (!result.bytesWritten)
            throw new Error("recording recovery made no write progress");
          written += result.bytesWritten;
        }
        added += data.length - overlap;
        position += data.length;
      }
      await handle.sync();
      size = Math.max(size, offset + st.size);
      recovered += added;
      await rm(file);
      reservedSpoolBytes = Math.max(0, reservedSpoolBytes - st.size);
    }
  } finally {
    await handle.close();
  }
  await rm(path.join(directory, "manifest.json"), { force: true });
  await rmdir(directory).catch(() => undefined);
  return recovered;
}

/** Only used at recording completion, never in the media hot path. */
export function hasPendingRecordingBuffer(
  root: string,
  target: string,
): boolean {
  try {
    return readdirSync(recordingSpoolDirectory(root, target)).some((name) =>
      /^\d+-[a-f0-9-]+\.buffer$/.test(name),
    );
  } catch {
    return false;
  }
}

export async function listRecordingBufferTargets(
  root: string,
): Promise<Array<{ recordingId: string; target: string }>> {
  const targets: Array<{ recordingId: string; target: string }> = [];
  for (const directory of await readdir(root).catch(() => [] as string[])) {
    if (!/^[a-f0-9]{64}$/.test(directory)) continue;
    try {
      const file = path.join(root, directory, "manifest.json");
      if ((await stat(file)).size > 8192) continue;
      const manifest = JSON.parse(await readFile(file, "utf8"));
      if (
        manifest.version !== 1 ||
        typeof manifest.target !== "string" ||
        typeof manifest.recordingId !== "string"
      )
        continue;
      if (
        !path.isAbsolute(manifest.target) ||
        recordingSpoolDirectory(root, manifest.target) !==
          path.join(root, directory)
      )
        continue;
      if (hasPendingRecordingBuffer(root, manifest.target))
        targets.push({
          recordingId: manifest.recordingId,
          target: manifest.target,
        });
    } catch {
      /* An incomplete manifest is never a replay authority. */
    }
  }
  return targets;
}

export async function moveRecordingBuffer(
  root: string,
  from: string,
  to: string,
): Promise<void> {
  if (
    path.resolve(from) === path.resolve(to) ||
    !hasPendingRecordingBuffer(root, from)
  )
    return;
  const source = recordingSpoolDirectory(root, from);
  const destination = recordingSpoolDirectory(root, to);
  const manifest = JSON.parse(
    await readFile(path.join(source, "manifest.json"), "utf8"),
  );
  await rename(source, destination);
  try {
    await writeFile(
      path.join(destination, "manifest.json.part"),
      JSON.stringify({ ...manifest, target: path.resolve(to) }),
    );
    await rename(
      path.join(destination, "manifest.json.part"),
      path.join(destination, "manifest.json"),
    );
  } catch (error) {
    await rename(destination, source).catch(() => undefined);
    throw error;
  }
}

/** Keep the recording path and its recovery authority consistent on rename. */
export async function renameRecordingWithBuffer(
  root: string,
  from: string,
  to: string,
): Promise<void> {
  await rename(from, to);
  try {
    await moveRecordingBuffer(root, from, to);
  } catch (error) {
    await rename(to, from);
    throw error;
  }
}

export async function removeRecordingBuffer(
  root: string,
  target: string,
): Promise<void> {
  await accountExistingSpool(root);
  const directory = recordingSpoolDirectory(root, target);
  let bytes = 0;
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (/^\d+-[a-f0-9-]+\.buffer$/.test(name))
      bytes +=
        (await stat(path.join(directory, name)).catch(() => null))?.size ?? 0;
  }
  await rm(directory, { recursive: true, force: true });
  reservedSpoolBytes = Math.max(0, reservedSpoolBytes - bytes);
}
