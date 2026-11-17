import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DanmakuListPage } from "./store.js";
import type { DanmakuMessage } from "./types.js";

const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_LINE_BYTES = 32 * 1024;
const LEGACY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Migrate away from the old on-disk cache. Leave recent or foreign directories alone. */
export async function cleanLegacyPreviewCaches(base = tmpdir(), now = Date.now()): Promise<void> {
  const dirs = await readdir(base, { withFileTypes: true }).catch(() => []);
  const uid = process.getuid?.();
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^live-recorder-danmaku-[a-zA-Z0-9]{6}$/.test(dir.name)) continue;
    const root = path.join(base, dir.name);
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || now - info.mtimeMs < LEGACY_MAX_AGE_MS) continue;
      const files = await readdir(root);
      if (files.length && (files.length !== 1 || files[0] !== ".danmaku")) continue;
      if (files.length) {
        const sub = path.join(root, ".danmaku");
        const subInfo = await lstat(sub);
        if (!subInfo.isDirectory() || now - subInfo.mtimeMs < LEGACY_MAX_AGE_MS) continue;
        const children = await readdir(sub);
        if (children.some(name => name !== "preview.danmaku.jsonl")) continue;
        if (children.length) {
          const file = await lstat(path.join(sub, children[0]!));
          if (!file.isFile() || now - file.mtimeMs < LEGACY_MAX_AGE_MS) continue;
        }
      }
      await rm(root, { recursive: true, force: true });
    } catch { /* Best-effort cleanup, independent of preview startup. */ }
  }
}

/** Recent unrecorded messages, owned by the preview lease. Never writes to disk. */
export class DanmakuPreviewCache {
  private items: Buffer[] = [];
  private head = 0;
  private bytes = 0;
  private seq = 0;
  private discarded = false;
  private skipped = false;

  append(message: DanmakuMessage): void {
    const line = Buffer.from(JSON.stringify({ ...message, tMs: null, unmappable: true, beforeRecording: true }));
    if (line.length >= MAX_LINE_BYTES) {
      this.skipped = true;
      return;
    }
    this.items.push(line);
    this.seq++;
    this.bytes += line.length;
    while (this.bytes > MAX_BYTES || this.items.length - this.head > MAX_ROWS) {
      this.discarded = true;
      this.bytes -= this.items[this.head]!.length;
      this.items[this.head++] = EMPTY;
    }
    if (this.head >= 128) {
      this.items.splice(0, this.head);
      this.head = 0;
    }
  }

  readListPage(cursor: string, limit: number): DanmakuListPage {
    const oldest = this.seq - (this.items.length - this.head);
    const backwards = cursor === "latest" || cursor.startsWith("before:");
    const boundary = cursor === "latest" ? this.seq : Number(backwards ? cursor.slice("before:".length) : cursor);
    const clamped = Math.max(oldest, Math.min(boundary, this.seq));
    const offset = backwards ? Math.max(oldest, clamped - limit) : clamped;
    const end = backwards ? clamped : Math.min(this.seq, offset + limit);
    const messages = this.items.slice(this.head + offset - oldest, this.head + end - oldest)
      .map(line => JSON.parse(line.toString("utf8")) as DanmakuMessage);
    return {
      messages,
      rowCursors: messages.map((_, index) => String(offset + index)),
      next: !backwards && end < this.seq ? String(end) : null,
      resumeCursor: String(end),
      ...(backwards ? { previous: offset > oldest ? String(offset) : null } : {}),
      ...(this.discarded ? { cacheTruncated: true } : {}),
      ...(this.skipped ? { cacheSkipped: true } : {}),
    };
  }
}
const EMPTY = Buffer.alloc(0);
