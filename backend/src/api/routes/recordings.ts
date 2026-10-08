import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { open, stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { rename, unlink } from "node:fs/promises";
import { renameRecordingWithBuffer, removeRecordingBuffer } from "../../recorder/buffered-writer.js";
import { DanmakuStore } from "../../danmaku/store.js";
import { exportDanmakuFiles } from "../../danmaku/export.js";
import { AppError } from "../../types/error.js";
import { SeekRangeError } from "../../core/seek-service.js";
import type { Services } from "../../core/services.js";
import type { Recording, RecordingState } from "../../types/index.js";
import { CsvExportWorkerPool } from "../csv-export-worker-pool.js";
import {
  moveMarkerSidecar,
  removeMarkerSidecar,
  syncMarkerSidecar,
} from "../../storage/recording-markers.js";
import {
  moveSeekIndexSidecar,
  removeSeekIndexSidecar,
} from "../../storage/seek-index.js";
import { compositeClipProgress } from "../../core/task-progress.js";
import { openSystemPath } from "../../utils/open-system-path.js";

const STATES: RecordingState[] = [
  "pending",
  "recording",
  "reconnecting",
  "awaiting_confirmation",
  "completed",
  "failed",
];

function canVerifyRecording(state: RecordingState): boolean {
  return (
    state !== "recording" && state !== "reconnecting" && state !== "processing"
  );
}

function parseSingleRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (!header || header.includes(",")) return null; // Multi-range deliberately falls back to a complete stream.
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    const length = Number(rawEnd);
    if (!Number.isSafeInteger(length) || length <= 0) return "invalid";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

async function mediaType(filePath: string): Promise<string> {
  const file = await open(filePath, "r");
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    if (bytesRead >= 3 && head.subarray(0, 3).toString("ascii") === "FLV")
      return "video/x-flv";
    if (bytesRead >= 8 && head.subarray(4, 8).toString("ascii") === "ftyp")
      return "video/mp4";
    return "application/octet-stream";
  } finally {
    await file.close();
  }
}

export function registerRecordingRoutes(
  app: FastifyInstance,
  services: Services,
): void {
  // A file database can be safely opened read-only by the exporter. In-memory
  // test databases are connection-local, so retain the direct implementation.
  const csvWorkers =
    services.db.name === ":memory:"
      ? null
      : new CsvExportWorkerPool(services.db.name);

  const activeMarkerRecording = (id: string) => {
    const recording = services.recordings.get(id);
    if (!recording)
      throw new AppError("RESOURCE_NOT_FOUND", "录制不存在", {
        recordingId: id,
      });
    if (recording.state !== "recording" && recording.state !== "reconnecting") {
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        "仅录制中的录像可编辑标记",
        { recordingId: id },
      );
    }
    return recording;
  };

  const markerTail = (recording: Recording) =>
    services.manager.recordingMarkerTail(recording.roomId, recording.id) ??
    Math.max(0, Math.floor((services.clock.now() - Date.parse(recording.startedAt)) / 1000));

  app.get("/api/v1/recordings/:id/markers", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!services.recordings.get(id))
      throw new AppError("RESOURCE_NOT_FOUND", "录制不存在", {
        recordingId: id,
      });
    return reply.send({ markers: services.recordingMarkers.list(id) });
  });

  app.post("/api/v1/recordings/:id/markers", async (req, reply) => {
    const { id } = req.params as { id: string };
    const recording = activeMarkerRecording(id);
    const body = (req.body ?? {}) as {
      text?: unknown;
      positionSeconds?: unknown;
    };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 200)
      throw new AppError("CONFIG_INVALID", "标记文字需为 1-200 个字符", {
        recordingId: id,
      });
    // 回看按播放头落点，直播按文件媒体尾落点，断流等待不累计成录像秒数。
    const recordedSeconds = markerTail(recording);
    const rawPosition = body.positionSeconds;
    if (
      rawPosition !== undefined &&
      (typeof rawPosition !== "number" ||
        !Number.isInteger(rawPosition) ||
        rawPosition < 0 ||
        rawPosition > recordedSeconds)
    ) {
      throw new AppError("CONFIG_INVALID", "标记时间必须在当前已录制范围内", {
        recordingId: id,
      });
    }
    const positionSeconds =
      rawPosition !== undefined ? rawPosition : recordedSeconds;
    const marker = services.recordingMarkers.create(id, positionSeconds, text);
    await syncMarkerSidecar(recording, services.recordingMarkers.list(id));
    return reply.status(201).send({ marker });
  });

  app.patch("/api/v1/recordings/:id/markers/:markerId", async (req, reply) => {
    const { id, markerId } = req.params as { id: string; markerId: string };
    const body = (req.body ?? {}) as {
      text?: unknown;
      positionSeconds?: unknown;
    };
    // 完成后可补写说明，位置仍由录制期间确定，避免改动文件时间轴。
    const existing = services.recordings.get(id);
    const recording = existing?.state === "completed" &&
      typeof body.text === "string" && body.positionSeconds === undefined
      ? existing
      : activeMarkerRecording(id);
    const text = typeof body.text === "string" ? body.text.trim() : undefined;
    const positionSeconds = body.positionSeconds;
    if (text !== undefined && (!text || text.length > 200))
      throw new AppError("CONFIG_INVALID", "标记文字需为 1-200 个字符", {
        recordingId: id,
      });
    if (
      positionSeconds !== undefined &&
      (typeof positionSeconds !== "number" ||
        !Number.isInteger(positionSeconds) ||
        positionSeconds < 0 ||
        positionSeconds > markerTail(recording))
    ) {
      throw new AppError("CONFIG_INVALID", "标记时间必须在当前已录制范围内", {
        recordingId: id,
      });
    }
    const marker = services.recordingMarkers.update(id, markerId, {
      ...(text !== undefined ? { text } : {}),
      ...(positionSeconds !== undefined
        ? { positionSeconds: positionSeconds as number }
        : {}),
    });
    if (!marker)
      throw new AppError("RESOURCE_NOT_FOUND", "标记不存在", {
        recordingId: id,
      });
    await syncMarkerSidecar(recording, services.recordingMarkers.list(id));
    return reply.send({ marker });
  });

  app.delete("/api/v1/recordings/:id/markers/:markerId", async (req, reply) => {
    const { id, markerId } = req.params as { id: string; markerId: string };
    const recording = activeMarkerRecording(id);
    if (!services.recordingMarkers.remove(id, markerId))
      throw new AppError("RESOURCE_NOT_FOUND", "标记不存在", {
        recordingId: id,
      });
    await syncMarkerSidecar(recording, services.recordingMarkers.list(id));
    return reply.status(204).send();
  });

  app.post("/api/v1/recordings/:id/clip-export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      startSecond?: unknown;
      endSecond?: unknown;
      name?: unknown;
    };
    if (
      !Number.isInteger(body.startSecond) ||
      !Number.isInteger(body.endSecond)
    ) {
      throw new AppError("CONFIG_INVALID", "选区时间必须为整数秒", {
        recordingId: id,
      });
    }
    if (typeof body.name !== "string") {
      throw new AppError("CONFIG_INVALID", "片段名称必填", { recordingId: id });
    }
    const result = await services.manager.exportClip(
      id,
      body.startSecond as number,
      body.endSecond as number,
      body.name,
    );
    return reply.status(201).send(result);
  });
  async function hasDanmakuRows(filePath: string | null | undefined): Promise<boolean> {
    if (!filePath) return false;
    const { stat } = await import("node:fs/promises");
    const store = await DanmakuStore.openExisting(filePath);
    const info = store ? await stat(store.filePath).catch(() => null) : null;
    return Boolean(info && info.size > 0);
  }

  app.get("/api/v1/recordings", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Number(q.page ?? "1");
    const pageSize = Number(q.pageSize ?? "20");
    if (
      !Number.isFinite(page) ||
      page < 1 ||
      !Number.isFinite(pageSize) ||
      pageSize < 1
    ) {
      return reply.status(400).send({
        error: {
          code: "CONFIG_INVALID",
          message: "分页参数非法",
          roomId: null,
          recordingId: null,
          occurredAt: services.clock.iso(),
          retryable: false,
        },
      });
    }
    if (q.state && !STATES.includes(q.state as RecordingState)) {
      return reply.status(400).send({
        error: {
          code: "CONFIG_INVALID",
          message: "state 过滤值非法",
          roomId: null,
          recordingId: null,
          occurredAt: services.clock.iso(),
          retryable: false,
        },
      });
    }
    for (const [k, v] of [
      ["dateFrom", q.dateFrom],
      ["dateTo", q.dateTo],
    ] as const) {
      if (v !== undefined && Number.isNaN(Date.parse(v))) {
        return reply.status(422).send({
          error: {
            code: "CONFIG_INVALID",
            message: `${k} 必须为合法日期格式`,
            roomId: null,
            recordingId: null,
            occurredAt: services.clock.iso(),
            retryable: false,
          },
        });
      }
    }
    const rawResult = services.recordings.list({
      title: q.title,
      page,
      pageSize,
      roomId: q.roomId,
      state: q.state as RecordingState | undefined,
      sessionId: q.sessionId,
      groupBy: q.groupBy === "session" ? "session" : undefined,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
    });
    const gapSummaries = services.recordings.gapSummaries(rawResult.items.map(item => item.id));
    const result = {
      ...rawResult,
      items: await Promise.all(rawResult.items.map(async (item) => ({
        ...item,
        // 弹幕记账：sidecar 存在且非空=该录像有弹幕（列表入口灰/亮的依据）。
        hasDanmaku: await hasDanmakuRows(item.filePath),
        // 中断记账：次数与累计缺失分开出（历史列「N 次中断·共 X 秒」直接渲染）。
        gapSummary: (() => {
          const detail = gapSummaries.get(item.id);
          return {
            gapCount: detail?.gapCount ?? item.gapCount ?? 0,
            totalMissingMs: Math.max(item.missingMs ?? 0, detail?.totalMissingMs ?? 0),
            estimated: item.missingMs == null,
          };
        })(),
        verifyQueuePosition: services.verificationQueue.positionOf(item.id),
        progressPercent:
          item.origin === "clip" && item.state === "processing"
            ? compositeClipProgress({
                id: item.id,
                startedAt: item.startedAt,
                endedAt: item.endedAt,
                createdAt: item.createdAt,
                fileSizeBytes: item.fileSizeBytes ?? 0,
                exportPct: services.manager.clipExportProgress(item.id),
                run: services.pipeline.repo.runForRecording(item.id),
                hasPostPhase: services.pipeline.pipelineConfig().enabled,
                now: Date.now(),
              })
            : services.manager.clipExportProgress(item.id),
        // 跳播索引状态：仅录制中的 FLV 行携带（ready/building/missing）。
        ...(services.seek.seekInfo(item) ?? {}),
      }))),
    };
    return reply.send(result);
  });

  app.post("/api/v1/recordings/:id/danmaku-export", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec?.filePath || rec.state !== "completed") {
      throw new AppError("RECORDING_NOT_AVAILABLE", "请选择已完成的录像");
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { directory, durationMs, width, height, opacity, density } = body;
    if (typeof directory !== "string" || !directory.trim() ||
      typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs <= 0 ||
      typeof width !== "number" || !Number.isInteger(width) || width < 1 || width > 16384 ||
      typeof height !== "number" || !Number.isInteger(height) || height < 1 || height > 16384 ||
      typeof opacity !== "number" || !Number.isFinite(opacity) || opacity < 0.2 || opacity > 1 ||
      typeof density !== "number" || ![20, 40, 80].includes(density)) {
      throw new AppError("CONFIG_INVALID", "弹幕导出参数无效");
    }
    try {
      const result = await exportDanmakuFiles(rec.filePath, { directory, durationMs, width, height, opacity, density });
      return reply.send(result);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("RECORDING_WRITE_FAILED", "弹幕导出失败，请检查目录权限和磁盘空间");
    }
  });

  app.get("/api/v1/recordings/:id/danmaku", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec) throw new AppError("RECORDING_NOT_AVAILABLE", "录像不存在", { recordingId: id });
    const q = req.query as Record<string, string | undefined>;
    const fromMs = Number(q.fromMs ?? 0);
    const endMs = q.toMs === undefined ? Number.MAX_SAFE_INTEGER : Number(q.toMs);
    if (!Number.isFinite(fromMs) || fromMs < 0 || !Number.isFinite(endMs) || endMs < fromMs) throw new AppError("CONFIG_INVALID", "弹幕时间区间无效");
    // 缺省窗=全量（裸参不带 toMs 时按上界过滤会恒空——默认取最大值兜底）。
    const toMs = endMs;
    const limit = q.limit ? Number(q.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 20000)) throw new AppError("CONFIG_INVALID", "弹幕条数必须为 1-20000");
    if (q.cursor !== undefined && (!/^\d+$/.test(q.cursor) || !Number.isSafeInteger(Number(q.cursor)))) throw new AppError("CONFIG_INVALID", "弹幕游标无效");
    const includeUnmappable = q.includeUnmappable === "1";
    const result = await services.danmaku.readRange(
      id,
      rec.filePath ?? "",
      fromMs,
      toMs,
      { ...(limit ? { limit } : {}), ...(q.cursor !== undefined ? { cursor: q.cursor } : {}), includeUnmappable },
    );
    return reply.send(result);
  });

  function estimatePositionMs(
    rec: { startedAt: string } | null | undefined,
    gapStartedAt: string,
    previousMissingMs: number,
  ): number {
    if (!rec?.startedAt) return 0;
    const pos = Date.parse(gapStartedAt) - Date.parse(rec.startedAt) - previousMissingMs;
    return Math.max(0, pos);
  }

  app.get("/api/v1/recordings/quality", async (_req, reply) => {
    return reply.send({ health: services.quality.snapshotAll() });
  });

  app.get("/api/v1/recordings/:id/quality", async (req, reply) => {
    const { id } = req.params as { id: string };
    return reply.send(services.quality.snapshot(id));
  });

  app.get("/api/v1/recordings/:id/gaps", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec)
      throw new AppError("RECORDING_NOT_AVAILABLE", "录制不存在", {
        details: { recordingId: id },
      });
    const rawGaps = services.recordings.listGaps(id);
    let previousMissingMs = 0;
    const gaps = rawGaps.map((g) => {
      let mediaPositionMs: number | null = null;
      try {
        mediaPositionMs = g.evidence
          ? ((JSON.parse(g.evidence) as { mediaPositionMs?: number }).mediaPositionMs ?? null)
          : null;
      } catch {
        mediaPositionMs = null;
      }
      if (mediaPositionMs !== null && (!Number.isFinite(mediaPositionMs) || mediaPositionMs < 0)) mediaPositionMs = null;
      const positionMs = mediaPositionMs ?? estimatePositionMs(rec, g.startedAt, previousMissingMs);
      previousMissingMs += Math.max(0, g.missingMs);
      return {
        evidence: g.evidence,
        id: g.id,
        startedAt: g.startedAt,
        endedAt: g.endedAt,
        missingMs: g.missingMs,
        kind: g.kind,
        // 位置=证据里的媒体锚点；旧记录无锚=墙钟估算位（FE 悬停带「约」）。
        positionMs,
        estimated: mediaPositionMs === null,
      };
    });
    const detailSum = gaps.reduce((acc, g) => acc + g.missingMs, 0);
    const totalMissingMs = Math.max(rec?.missingMs ?? 0, detailSum);
    // 两账分立：文件状态只判文件面（可播/损坏），缺失一律走 gapSummary——不再混判打脸。
    const fileStatus =
      rec?.integrity === "verified" ? "playable" : rec?.integrity === "failed" ? "corrupt" : "unknown";
    return reply.send({
      gaps,
      summary: {
        gapCount: gaps.length,
        totalMissingMs,
        unlocatedMissingMs: Math.max(0, totalMissingMs - detailSum),
        fileStatus,
        integrity: rec?.integrity ?? "unknown",
      },
    });
  });

  // 跳播起流：从索引命中关键帧字节偏移直通 FLV 字节流（FLV 头+序列头+标签到已写尾部即止）。
  app.get("/api/v1/recordings/:id/seek-stream", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { second?: string; snapshot?: string };
    const second = Number(q.second);
    if (!Number.isInteger(second) || second < 0) {
      throw new AppError("CONFIG_INVALID", "second 必须为非负整数秒");
    }
    const rec = services.recordings.get(id);
    if (!rec) {
      throw new AppError("RESOURCE_NOT_FOUND", "录制记录不存在", {
        recordingId: id,
        details: { resource: "recording" },
      });
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!reply.raw.writableFinished) abort(); cleanup(); };
    const cleanup = () => {
      req.raw.off("aborted", abort);
      reply.raw.off("close", close);
      reply.raw.off("finish", cleanup);
    };
    req.raw.once("aborted", abort);
    reply.raw.once("close", close);
    reply.raw.once("finish", cleanup);
    try {
      const result = await services.seek.openStream(rec, second, {
        signal: controller.signal,
        ...(q.snapshot ? { streamToken: q.snapshot } : {}),
        ...(req.headers.range !== undefined ? { range: req.headers.range } : {}),
      });
      reply.header("Content-Type", "video/x-flv");
      reply.header("Cache-Control", "no-store");
      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Length", String(result.to - result.from));
      reply.header("X-Seek-Start-Second", String(result.startSecond));
      reply.header("Access-Control-Expose-Headers", "X-Seek-Start-Second, Content-Range, Accept-Ranges");
      if (result.partial) {
        reply.code(206);
        reply.header("Content-Range", `bytes ${result.from}-${result.to - 1}/${result.total}`);
      }
      return reply.send(result.stream);
    } catch (error) {
      cleanup();
      if (error instanceof SeekRangeError) {
        return reply.code(416).header("Content-Range", `bytes */${error.total}`).send();
      }
      throw error;
    }
  });

  // 跳播预热：零进程准备（读索引+校验目标点），幂等可反复调。
  app.post("/api/v1/recordings/:id/seek-prewarm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { second?: unknown; prepareStream?: unknown };
    const second = Number(body.second);
    if (!Number.isInteger(second) || second < 0) {
      throw new AppError("CONFIG_INVALID", "second 必须为非负整数秒");
    }
    const rec = services.recordings.get(id);
    if (!rec) {
      throw new AppError("RESOURCE_NOT_FOUND", "录制记录不存在", {
        recordingId: id,
        details: { resource: "recording" },
      });
    }
    const result = await services.seek.prewarm(rec, second, body.prepareStream === true);
    return reply.status(202).send({ ok: true, ...result });
  });

  app.post("/api/v1/recordings/:id/verify", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec)
      throw new AppError("RECORDING_NOT_AVAILABLE", "录制不存在", {
        details: { recordingId: id },
      });
    if (!canVerifyRecording(rec.state)) {
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        "录制仍在写入或处理中，结束后才能校验",
        { recordingId: id, retryable: true },
      );
    }
    const accepted = services.verificationQueue.enqueue(rec);
    return reply.send({ accepted });
  });

  app.post("/api/v1/recordings/verify-batch", async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown };
    const ids = Array.isArray(body.ids)
      ? (body.ids as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    let accepted = 0;
    let skippedActive = 0;
    for (const id of ids) {
      const rec = services.recordings.get(id);
      if (!rec) continue;
      if (!canVerifyRecording(rec.state)) {
        skippedActive += 1;
        continue;
      }
      if (services.verificationQueue.enqueue(rec)) accepted += 1;
    }
    return reply.send({ accepted, requested: ids.length, skippedActive });
  });

  const openRecordingTarget = async (id: string, target: "file" | "directory"): Promise<void> => {
    const rec = services.recordings.get(id);
    if (!rec || !rec.filePath) {
      throw new AppError("RESOURCE_NOT_FOUND", "录制记录不存在或文件缺失", {
        recordingId: id,
        details: { resource: "recording" },
      });
    }
    if (target === "file" && rec.state !== "completed") {
      throw new AppError("RECORDING_NOT_AVAILABLE", "录像尚未完成，暂时无法播放", { recordingId: id });
    }
    const targetPath = target === "file" ? rec.filePath : dirname(rec.filePath);
    if (target === "file") {
      const info = await stat(targetPath).catch(() => null);
      if (!info?.isFile()) {
        throw new AppError("RESOURCE_NOT_FOUND", "录像文件已删除或不可访问", { recordingId: id });
      }
    }
    if (process.env.VITEST !== "true") {
      await openSystemPath(targetPath).catch(() => {
        throw new AppError("SERVICE_UNAVAILABLE", "无法打开系统默认应用，请检查文件关联", { recordingId: id });
      });
    }
  };

  app.post("/api/v1/recordings/:id/open", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { target = "directory" } = (req.body ?? {}) as { target?: "file" | "directory" };
    if (target !== "file" && target !== "directory") {
      throw new AppError("CONFIG_INVALID", "打开目标无效", { recordingId: id });
    }
    await openRecordingTarget(id, target);
    return reply.send({ ok: true });
  });

  // 播放使用独立语义，旧后端不支持时明确报错，不能悄悄降级为打开目录。
  app.post("/api/v1/recordings/:id/play", async (req, reply) => {
    const { id } = req.params as { id: string };
    await openRecordingTarget(id, "file");
    return reply.send({ ok: true });
  });

  // 管线产物仅允许按 recording + artifact id 打开，避免接口接受任意本地路径。
  app.post(
    "/api/v1/recordings/:id/pipeline/artifacts/:artifactId/open",
    async (req, reply) => {
      const { id, artifactId } = req.params as {
        id: string;
        artifactId: string;
      };
      const { target } = (req.body ?? {}) as { target?: "file" | "directory" };
      const run = services.pipeline.repo.runForRecording(id);
      const artifact = run?.artifacts.find((item) => item.id === artifactId);
      if (!artifact?.path) {
        throw new AppError(
          "RESOURCE_NOT_FOUND",
          "管线产物不存在或文件路径不可用",
          {
            recordingId: id,
          },
        );
      }
      if (target !== "file" && target !== "directory") {
        throw new AppError("CONFIG_INVALID", "打开目标无效", {
          recordingId: id,
        });
      }
      const targetPath =
        target === "directory" ? dirname(artifact.path) : artifact.path;
      await stat(targetPath).catch(() => {
        throw new AppError("RESOURCE_NOT_FOUND", "目标文件或目录不存在", {
          recordingId: id,
        });
      });
      if (process.env.VITEST !== "true") {
        await openSystemPath(targetPath).catch(() => {
          throw new AppError("SERVICE_UNAVAILABLE", "无法打开系统默认应用，请检查文件关联", { recordingId: id });
        });
      }
      return reply.send({ ok: true });
    },
  );

  // 历史页回放：仅 completed 且文件存在的录制可读取，按 FLV 内容输出（.flv/.mkv 均实为 FLV 字节）。
  app.get("/api/v1/recordings/:id/file", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec || !rec.filePath || rec.state !== "completed") {
      throw new AppError("RESOURCE_NOT_FOUND", "录制记录不存在或文件缺失", {
        recordingId: id,
        details: { resource: "recording" },
      });
    }
    let size: number;
    try {
      size = (await stat(rec.filePath)).size;
    } catch {
      throw new AppError("RESOURCE_NOT_FOUND", "录制文件缺失", {
        recordingId: id,
        details: { resource: "recording" },
      });
    }
    if (size <= 0) {
      throw new AppError("RECORDING_FILE_CORRUPTED", "录制文件为空或不可读", {
        recordingId: id,
        retryable: false,
      });
    }
    const range = parseSingleRange(req.headers.range, size);
    if (range === "invalid") {
      reply.header("Content-Range", `bytes */${size}`);
      return reply.status(416).send();
    }
    reply.header("Content-Type", await mediaType(rec.filePath));
    reply.header("Accept-Ranges", "bytes");
    if (range) {
      const length = range.end - range.start + 1;
      reply.header("Content-Length", String(length));
      reply.header(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${size}`,
      );
      return reply.status(206).send(createReadStream(rec.filePath, range));
    }
    reply.header("Content-Length", String(size));
    return reply.send(createReadStream(rec.filePath));
  });

  app.patch("/api/v1/recordings/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { streamTitle?: string };
    const rec = services.recordings.get(id);
    if (!rec) {
      throw new AppError("RESOURCE_NOT_FOUND", "录制记录不存在", {
        recordingId: id,
        details: { resource: "recording" },
      });
    }
    if (
      typeof body.streamTitle !== "string" ||
      body.streamTitle.trim().length === 0
    ) {
      throw new AppError("CONFIG_INVALID", "streamTitle 必须为非空字符串", {
        recordingId: id,
      });
    }
    const title = body.streamTitle.trim();
    // 重命名同步改名落盘文件（保留目录与扩展名），文件缺失时仅改记录并容错。
    if (rec.filePath) {
      const dir = dirname(rec.filePath);
      const ext = extnameOf(rec.filePath);
      const nextName = sanitizeFileBase(title) + ext;
      const nextPath = join(dir, nextName);
      try {
        await renameRecordingWithBuffer(services.recordingBufferDirectory, rec.filePath, nextPath);
        await services.danmaku.moveSidecar(id, rec.filePath, nextPath);
        await moveMarkerSidecar(rec.filePath, nextPath);
        await moveSeekIndexSidecar(rec.filePath, nextPath);
        services.recordings.update(id, {
          streamTitle: title,
          filePath: nextPath,
        });
      } catch {
        // 文件缺失/重命名失败：仅更新记录标题，不阻断。
        services.recordings.update(id, { streamTitle: title });
      }
    } else {
      services.recordings.update(id, { streamTitle: title });
    }
    const updated = services.recordings.get(id)!;
    services.events.emit({ type: "recording:updated", data: updated });
    return reply.send({ recording: updated });
  });

  app.delete("/api/v1/recordings/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec) {
      throw new AppError("RESOURCE_NOT_FOUND", "录制记录不存在", {
        recordingId: id,
        details: { resource: "recording" },
      });
    }
    if (rec.state === "recording" || rec.state === "reconnecting") {
      throw new AppError(
        "RECORDING_NOT_AVAILABLE",
        "录制进行中，请先停止录制再删除",
        {
          recordingId: id,
        },
      );
    }
    await services.manager.cancelHighlightExport(id);
    await services.manager.stopActiveSessionForDeletion(id);
    await services.danmaku.stopForRecording(id);
    await services.danmaku.removeSidecar(rec.filePath);
    services.pipeline.cancel(id, "录制已删除");
    services.manager.cancelClipExport(id);
    // 连带删除文件；文件缺失容错（记录仍删除）。
    if (rec.filePath) {
      await unlink(rec.filePath).catch(() => undefined);
      await removeMarkerSidecar(rec.filePath);
      await removeSeekIndexSidecar(rec.filePath);
      await removeRecordingBuffer(services.recordingBufferDirectory, rec.filePath);
    }
    services.recordingMarkers.removeForRecording(id);
    services.recordings.remove(id);
    services.events.emit({ type: "recording:deleted", data: { id } });
    return reply.status(204).send();
  });

  // #220 录制完成「询问是否保留」：保留决策——恢复管线+上传（等价原分段级收尾）。
  app.post("/api/v1/recordings/:id/keep", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec) {
      throw new AppError("RESOURCE_NOT_FOUND", "录制记录不存在", {
        recordingId: id,
        details: { resource: "recording" },
      });
    }
    if (rec.state !== "awaiting_confirmation") {
      throw new AppError("CONFIG_INVALID", "仅待确认保留的录制可执行保留", {
        recordingId: id,
      });
    }
    if (services.manager.deferHighlightConfirmation(id, true)) {
      return reply.send({ recording: services.recordings.get(id)! });
    }
    services.manager.resumeAfterConfirmation(id);
    return reply.send({ recording: services.recordings.get(id)! });
  });

  // #220 录制完成「询问是否保留」：不保留决策——删除文件 + 删除录制记录。
  app.post("/api/v1/recordings/:id/discard", async (req, reply) => {
    const { id } = req.params as { id: string };
    const rec = services.recordings.get(id);
    if (!rec) {
      throw new AppError("RESOURCE_NOT_FOUND", "录制记录不存在", {
        recordingId: id,
        details: { resource: "recording" },
      });
    }
    if (rec.state !== "awaiting_confirmation") {
      throw new AppError("CONFIG_INVALID", "仅待确认保留的录制可执行不保留", {
        recordingId: id,
      });
    }
    if (services.manager.deferHighlightConfirmation(id, false)) {
      return reply.status(204).send();
    }
    services.manager.discardAfterConfirmation(id);
    return reply.status(204).send();
  });

  // #220 统一决策接口（FE 契约）：keep=true 保留（恢复管线+上传）；keep=false 不保留（删文件+删记录）。
  app.post("/api/v1/recordings/:id/confirm", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { keep?: unknown; fileName?: unknown };
    if (typeof body.keep !== "boolean") {
      throw new AppError("CONFIG_INVALID", "keep 必须为布尔值", {
        recordingId: id,
      });
    }
    const rec = services.recordings.get(id);
    if (!rec) {
      throw new AppError("RESOURCE_NOT_FOUND", "录制记录不存在", {
        recordingId: id,
        details: { resource: "recording" },
      });
    }
    if (rec.state !== "awaiting_confirmation") {
      throw new AppError("CONFIG_INVALID", "仅待确认保留的录制可执行决策", {
        recordingId: id,
      });
    }
    const fileName = body.fileName;
    if (body.keep && fileName !== undefined) {
      if (typeof fileName !== "string" || fileName.trim().length === 0) {
        throw new AppError("CONFIG_INVALID", "fileName 必须为非空字符串", {
          recordingId: id,
        });
      }
    }
    // 精彩时刻的缓存快照可能还在复制到目标文件。此时先接受决定，导出完成
    // 后再执行改名、保留或删除，避免确认框被磁盘 I/O 延迟。
    if (
      services.manager.deferHighlightConfirmation(
        id,
        body.keep,
        typeof fileName === "string" ? fileName : undefined,
      )
    ) {
      return body.keep
        ? reply.send({ recording: services.recordings.get(id)! })
        : reply.status(204).send();
    }
    if (body.keep && typeof fileName === "string") {
      await renameRecordingFile(services, rec, fileName);
    }
    if (body.keep) {
      services.manager.resumeAfterConfirmation(id);
      return reply.send({ recording: services.recordings.get(id)! });
    }
    services.manager.discardAfterConfirmation(id);
    return reply.status(204).send();
  });

  // 批量删除录制（#67）：部分成功语义——每项独立删除（连带删文件、缺失容错），返回 deleted/failed。
  app.post("/api/v1/recordings/batch-delete", async (req, reply) => {
    const body = (req.body ?? {}) as { ids?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      throw new AppError("CONFIG_INVALID", "ids 必须为非空数组");
    }
    if (body.ids.length > 100) {
      throw new AppError("CONFIG_INVALID", "单次批量删除最多 100 条");
    }
    const deleted: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const raw of body.ids) {
      const id = typeof raw === "string" ? raw : String(raw);
      const rec = services.recordings.get(id);
      if (!rec) {
        failed.push({ id, reason: "记录不存在" });
        continue;
      }
      if (rec.state === "recording" || rec.state === "reconnecting") {
        throw new AppError(
          "RECORDING_NOT_AVAILABLE",
          "录制进行中，请先停止录制再删除",
          {
            recordingId: id,
          },
        );
      }
      await services.manager.cancelHighlightExport(id);
      await services.manager.stopActiveSessionForDeletion(id);
      await services.danmaku.stopForRecording(id);
      await services.danmaku.removeSidecar(rec.filePath);
      services.pipeline.cancel(id, "录制已删除");
      services.manager.cancelClipExport(id);
      if (rec.filePath) {
        await unlink(rec.filePath).catch(() => undefined);
      }
      services.recordings.remove(id);
      services.events.emit({ type: "recording:deleted", data: { id } });
      deleted.push(id);
    }
    return reply.send({ deleted, failed });
  });

  // CSV 导出（#69）：按现筛选条件导出清单+时长统计，UTF-8 BOM。
  app.get("/api/v1/recordings/export", async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    for (const [k, v] of [
      ["dateFrom", q.dateFrom],
      ["dateTo", q.dateTo],
    ] as const) {
      if (v !== undefined && Number.isNaN(Date.parse(v))) {
        return reply.status(422).send({
          error: {
            code: "CONFIG_INVALID",
            message: `${k} 必须为合法日期格式`,
            roomId: null,
            recordingId: null,
            occurredAt: services.clock.iso(),
            retryable: false,
          },
        });
      }
    }
    if (q.state && !STATES.includes(q.state as RecordingState)) {
      throw new AppError("CONFIG_INVALID", "state 过滤值非法");
    }
    const filters = {
      roomId: q.roomId,
      state: q.state as RecordingState | undefined,
      sessionId: q.sessionId,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
    };
    let lease: import("../csv-export-worker-pool.js").CsvExportLease | null =
      null;
    if (csvWorkers) {
      try {
        lease = await csvWorkers.acquire(filters);
      } catch (error) {
        if ((error as Error).message === "CSV_QUEUE_FULL") {
          throw new AppError(
            "SERVICE_UNAVAILABLE",
            "CSV 导出队列繁忙，请稍后重试",
            { retryable: true },
          );
        }
        throw new AppError(
          "SERVICE_UNAVAILABLE",
          "CSV 导出工作线程不可用，请稍后重试",
          { retryable: true },
        );
      }
      // 租约到手立即挂释放：close 监听必须先于 start 与一切后续失败点，
      // 否则 start 失败时 active 永不归还，连续两次后 CSV 导出永久报队列繁忙（只能重启恢复）。
      // release 幂等：正常完成/中途断开/异常路径由它统一收口（原监听点在下方，重复挂不生效重复释放）。
      reply.raw.once("close", () => {
        void lease?.release();
      });
      try {
        await lease.start();
      } catch (error) {
        await lease.release();
        throw new AppError(
          "SERVICE_UNAVAILABLE",
          "CSV 导出工作线程启动失败，请稍后重试",
          { retryable: true },
        );
      }
    }
    const header = [
      "id",
      "roomId",
      "platform",
      "streamTitle",
      "state",
      "startedAt",
      "endedAt",
      "durationSec",
      "fileSizeBytes",
      "quality",
      "integrity",
    ];
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header(
      "Content-Disposition",
      'attachment; filename="recordings.csv"',
    );
    // （释放监听已在租约到手时提前挂载，见上方 close 监听——先于 start 与一切失败点。）
    async function* rows(): AsyncGenerator<string> {
      let cursor:
        | import("../../db/repositories/recording.repo.js").RecordingExportCursor
        | undefined;
      let count = 0;
      let totalSeconds = 0;
      try {
        yield `\uFEFF${header.join(",")}\r\n`;
        for (;;) {
          const page = lease
            ? await lease.next(cursor).then((items) =>
                items.map((r) => ({
                  id: r.id,
                  roomId: r.room_id,
                  platform: r.platform,
                  streamTitle: r.stream_title,
                  state: r.state,
                  startedAt: r.started_at,
                  endedAt: r.ended_at,
                  fileSizeBytes: r.file_size_bytes ?? 0,
                  quality: r.quality ?? undefined,
                  integrity: r.integrity ?? undefined,
                })),
              )
            : services.recordings.listExportPage(filters, cursor, 500);
          if (page.length === 0) break;
          for (const r of page) {
            const durationSec =
              r.startedAt && r.endedAt
                ? Math.max(
                    0,
                    Math.round(
                      (new Date(r.endedAt).getTime() -
                        new Date(r.startedAt).getTime()) /
                        1000,
                    ),
                  )
                : 0;
            totalSeconds += durationSec;
            count += 1;
            yield [
              r.id,
              r.roomId,
              r.platform,
              r.streamTitle,
              r.state,
              r.startedAt,
              r.endedAt ?? "",
              String(durationSec),
              String(r.fileSizeBytes),
              r.quality ?? "",
              r.integrity ?? "",
            ]
              .map(csvCell)
              .join(",") + "\r\n";
          }
          const last = page.at(-1)!;
          cursor = { startedAt: last.startedAt, id: last.id };
        }
        yield `totalRecordings,${count}\r\ntotalDurationSec,${Math.round(totalSeconds)}\r\n`;
      } finally {
        await lease?.release();
      }
    }
    return reply.send(Readable.from(rows()));
  });
}

/** 确认保留时改名：用户只控制文件基名，扩展名沿用当前录制格式。 */
async function renameRecordingFile(
  services: Services,
  rec: import("../../types/index.js").Recording,
  requestedName: string,
): Promise<void> {
  if (!rec.filePath) return;
  const ext = extnameOf(rec.filePath);
  const requested = basename(requestedName.trim());
  // 兼容旧客户端可能传入扩展名；最终扩展名仍由录制格式决定（mp4_after 会在后处理时转成 .mp4）。
  const base = requested.replace(/\.(?:flv|mp4|mkv|ts|webm)$/i, "");
  const nextPath = join(
    dirname(rec.filePath),
    `${sanitizeFileBase(base)}${ext}`,
  );
  try {
    await renameRecordingWithBuffer(services.recordingBufferDirectory, rec.filePath, nextPath);
    services.recordings.update(rec.id, {
      streamTitle: base.trim(),
      filePath: nextPath,
    });
  } catch {
    // 文件缺失/改名失败时不阻断保留流程，仍使用原文件继续处理。
    services.recordings.update(rec.id, { streamTitle: base.trim() });
  }
}

function csvCell(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function extnameOf(p: string): string {
  const base = basename(p);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i) : "";
}

function sanitizeFileBase(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "recording";
}
