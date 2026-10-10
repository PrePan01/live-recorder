import type { DB } from "../connection.js";
import type { Clock } from "../../core/clock.js";
import { newId } from "../../utils/id.js";
import type { RecordingMarker } from "../../types/index.js";

export type ClipQueueState =
  | "queued"
  | "running"
  | "cancelling"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface ClipQueueItem {
  id: string;
  recordingTitle?: string | undefined;
  recordingId: string;
  batchId: string;
  markerId: string | null;
  outputRecordingId: string | null;
  startSecond: number;
  endSecond: number;
  fileName: string;
  encodePolicy: { encodingMode: "auto" | "software" };
  state: ClipQueueState;
  sortOrder: number;
  attempts: number;
  error: string | null;
  actualEncoder: string | null;
  fallbackReason: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}
function map(row: Record<string, unknown>): ClipQueueItem {
  return {
    recordingTitle: row.recording_title as string | undefined,
    id: row.id as string,
    recordingId: row.recording_id as string,
    batchId: row.batch_id as string,
    markerId: row.marker_id as string | null,
    outputRecordingId: row.output_recording_id as string | null,
    startSecond: row.start_second as number,
    endSecond: row.end_second as number,
    fileName: row.file_name as string,
    encodePolicy: JSON.parse(row.encode_policy as string),
    state: row.state as ClipQueueState,
    sortOrder: row.sort_order as number,
    attempts: row.attempts as number,
    error: row.error as string | null,
    actualEncoder: row.actual_encoder as string | null,
    fallbackReason: row.fallback_reason as string | null,
    createdAt: row.created_at as string,
    startedAt: row.started_at as string | null,
    endedAt: row.ended_at as string | null,
  };
}
export class ClipQueueRepo {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock,
  ) {}
  list(recordingId?: string, batchId?: string): ClipQueueItem[] {
    const where: string[] = [];
    const params: string[] = [];
    if (recordingId) {
      where.push("recording_id = ?");
      params.push(recordingId);
    }
    if (batchId) {
      where.push("batch_id = ?");
      params.push(batchId);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM clip_queue ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY sort_order`,
        )
        .all(...params) as Record<string, unknown>[]
    ).map(map);
  }
  page(
    recordingId: string | undefined,
    page: number,
  ): { items: ClipQueueItem[]; hasMore: boolean } {
    const where = recordingId ? "WHERE recording_id = ?" : "";
    const params: (string | number)[] = recordingId ? [recordingId] : [];
    const batches = this.db
      .prepare(
        `SELECT id FROM clip_batches ${where} ORDER BY created_at DESC, id DESC LIMIT 6 OFFSET ?`,
      )
      .all(...params, (page - 1) * 5) as { id: string }[];
    const ids = batches.slice(0, 5).map((b) => b.id);
    const items = ids.length
      ? (
          this.db
            .prepare(
              `SELECT q.*, r.stream_title AS recording_title FROM clip_queue q LEFT JOIN recordings r ON r.id = q.recording_id WHERE q.batch_id IN (${ids.map(() => "?").join(",")}) ORDER BY q.sort_order`,
            )
            .all(...ids) as Record<string, unknown>[]
        ).map(map)
      : [];
    return { items, hasMore: batches.length > 5 };
  }
  get(id: string): ClipQueueItem | null {
    const row = this.db
      .prepare("SELECT * FROM clip_queue WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? map(row) : null;
  }
  findBatch(recordingId: string, requestId: string): string | null {
    return (
      (
        this.db
          .prepare(
            "SELECT id FROM clip_batches WHERE recording_id = ? AND request_id = ?",
          )
          .get(recordingId, requestId) as { id: string } | undefined
      )?.id ?? null
    );
  }
  createBatch(
    recordingId: string,
    requestId: string,
    markers: Array<Pick<RecordingMarker, "positionSeconds" | "endPositionSeconds" | "text"> & { id: string | null }>,
    encodingMode: "auto" | "software",
  ): string {
    return this.db.transaction(() => {
      const existing = this.findBatch(recordingId, requestId);
      if (existing) return existing;
      const batchId = newId("cq");
      const now = this.clock.iso();
      this.db
        .prepare(
          "INSERT INTO clip_batches (id, recording_id, request_id, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(batchId, recordingId, requestId, now);
      const max =
        (
          this.db
            .prepare("SELECT MAX(sort_order) AS n FROM clip_queue")
            .get() as { n: number | null }
        ).n ?? 0;
      const insert = this.db.prepare(
        `INSERT INTO clip_queue (id, recording_id, batch_id, marker_id, start_second, end_second, file_name, encode_policy, state, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      );
      markers.forEach((marker, i) =>
        insert.run(
          newId("cq"),
          recordingId,
          batchId,
          marker.id,
          marker.positionSeconds,
          marker.endPositionSeconds,
          marker.text,
          JSON.stringify({ encodingMode }),
          max + i + 1,
          now,
        ),
      );
      return batchId;
    })();
  }
  setState(
    id: string,
    state: ClipQueueState,
    patch: {
      error?: string | null;
      outputRecordingId?: string | null;
      actualEncoder?: string | null;
      fallbackReason?: string | null;
      attemptsInc?: boolean;
    } = {},
  ): void {
    const sets = ["state = ?"];
    const values: unknown[] = [state];
    for (const [field, column] of [
      ["error", "error"],
      ["outputRecordingId", "output_recording_id"],
      ["actualEncoder", "actual_encoder"],
      ["fallbackReason", "fallback_reason"],
    ] as const) {
      if (patch[field] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[field]);
      }
    }
    if (patch.attemptsInc) sets.push("attempts = attempts + 1");
    if (state === "running") {
      sets.push("started_at = ?", "ended_at = NULL");
      values.push(this.clock.iso());
    }
    if (["done", "failed", "cancelled", "interrupted"].includes(state)) {
      sets.push("ended_at = ?");
      values.push(this.clock.iso());
    }
    if (state === "queued") sets.push("started_at = NULL", "ended_at = NULL");
    this.db
      .prepare(`UPDATE clip_queue SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, id);
  }
  nextQueued(): ClipQueueItem | null {
    const row = this.db
      .prepare(
        "SELECT * FROM clip_queue WHERE state = 'queued' ORDER BY sort_order LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    return row ? map(row) : null;
  }
  reconcileOnBoot(): void {
    this.db
      .prepare(
        "UPDATE clip_queue SET state = 'interrupted', error = '程序重启中断', ended_at = ? WHERE state IN ('running','cancelling')",
      )
      .run(this.clock.iso());
  }
  deleteByRecording(recordingId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM clip_queue WHERE recording_id = ?")
        .run(recordingId);
      this.db
        .prepare("DELETE FROM clip_batches WHERE recording_id = ?")
        .run(recordingId);
    })();
  }
}
