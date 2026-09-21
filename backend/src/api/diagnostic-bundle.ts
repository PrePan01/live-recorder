import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import yazl from "yazl";
import { defaultDataDir, type Services } from "../core/services.js";
import { BILIBILI_COOKIE_KEY, DOUYIN_COOKIE_KEY } from "../security/keys.js";
import { APP_VERSION, API_VERSION } from "../sidecar/types.js";
import type { PerformanceDiagnostic } from "../core/performance-diagnostics.js";

const MAX_LOG_BYTES = 1_048_576;
const MAX_FRONTEND_ITEMS = 200;

export interface FrontendDiagnosticInput {
  source?: unknown;
  message?: unknown;
  stack?: unknown;
  firstSeenAt?: unknown;
  lastSeenAt?: unknown;
  count?: unknown;
  context?:
    | { appVersion?: unknown; runtime?: unknown; recentAction?: unknown }
    | unknown;
}

export interface DiagnosticBundleOptions {
  stateDir?: string;
  frontendDiagnostics?: unknown;
  /** false 时不写入任何直播间快照；日志仍在本机按房间数据脱敏。 */
  includeRooms?: boolean;
}

/** A deliberately small, whitelist-only representation of a room for support. */
export interface RoomDiagnosticSnapshot {
  platform: string;
  publicRoomId: string | null;
  enabled: boolean;
  liveStatus: string | null;
  monitorState: string;
  lastCheckedAt: string | null;
  lastErrorCode: string | null;
}

/**
 * Remove values that must never leave the machine. This is intentionally applied
 * to every generated file, including frontend data which is not trusted to have
 * been redacted already.
 */
export function redactDiagnosticText(
  value: string,
  sensitiveValues: readonly string[] = [],
): string {
  let text = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0) text = text.split(sensitive).join("[redacted]");
  }
  return text
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, "[url-redacted]")
    .replace(
      /(["']?(?:authorization|cookie|set-cookie|password|passwd|token|access[_-]?token|secret|api[_-]?key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:bearer|basic)\s+[^\s,;}]+|[^\s,;}]+)/gi,
      "$1[redacted]",
    )
    .replace(/\b(bearer|basic)\s+[a-z0-9._~+\/=:-]+/gi, "$1 [redacted]")
    .replace(
      /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/gi,
      "[email-redacted]",
    )
    .replace(
      /(?:[A-Z]:[\\/]|\/Users\/|\/home\/|\/private\/|\/var\/|\/tmp\/)[^\s"'<>]*/g,
      "[path-redacted]",
    );
}

function publicRoomId(raw: string): string | null {
  try {
    const parts = new URL(raw).pathname.split("/").filter(Boolean);
    const candidate = parts.at(-1);
    return candidate && /^[A-Za-z0-9_-]{1,100}$/.test(candidate)
      ? candidate
      : null;
  } catch {
    return null;
  }
}

export function roomDiagnosticSnapshots(
  services: Services,
): RoomDiagnosticSnapshot[] {
  return services.rooms.list().map((room) => ({
    platform: room.platform,
    publicRoomId: publicRoomId(room.url),
    enabled: room.enabled,
    liveStatus: room.lastLiveStatus,
    monitorState: room.monitorState,
    lastCheckedAt: room.lastCheckedAt,
    lastErrorCode: room.lastError?.code ?? null,
  }));
}

function string(value: unknown, max = 4_000): string | undefined {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

export function frontendDiagnosticSummary(
  value: unknown,
  sensitiveValues: readonly string[],
): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_FRONTEND_ITEMS).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const input = item as FrontendDiagnosticInput;
    const context =
      input.context && typeof input.context === "object"
        ? (input.context as Record<string, unknown>)
        : {};
    return [
      {
        source: redactDiagnosticText(
          string(input.source, 160) ?? "unknown",
          sensitiveValues,
        ),
        message: redactDiagnosticText(
          string(input.message) ?? "",
          sensitiveValues,
        ),
        ...(string(input.stack)
          ? {
              stack: redactDiagnosticText(
                string(input.stack)!,
                sensitiveValues,
              ),
            }
          : {}),
        firstSeenAt:
          typeof input.firstSeenAt === "number" ? input.firstSeenAt : null,
        lastSeenAt:
          typeof input.lastSeenAt === "number" ? input.lastSeenAt : null,
        count: typeof input.count === "number" ? input.count : 0,
        context: {
          appVersion: redactDiagnosticText(
            string(context.appVersion, 160) ?? "",
            sensitiveValues,
          ),
          runtime: redactDiagnosticText(
            string(context.runtime, 512) ?? "",
            sensitiveValues,
          ),
          recentAction: redactDiagnosticText(
            string(context.recentAction, 160) ?? "",
            sensitiveValues,
          ),
        },
      },
    ];
  });
}

export function boundedDiagnosticLog(
  data: Buffer,
  sensitiveValues: readonly string[] = [],
): string {
  return redactDiagnosticText(
    data.subarray(Math.max(0, data.length - MAX_LOG_BYTES)).toString("utf8"),
    sensitiveValues,
  );
}

/** Export timings, but never the local room id (or any address/path). */
export function performanceDiagnosticSummary(
  entries: readonly PerformanceDiagnostic[],
): unknown[] {
  return entries.map((entry) => ({
    kind: entry.kind,
    platform: entry.platform,
    startedAt: entry.startedAt,
    elapsedMs: entry.elapsedMs,
    outcome: entry.outcome,
    errorCode: entry.errorCode,
    stages: entry.stages.map((stage) => ({
      name: stage.name,
      elapsedMs: stage.elapsedMs,
    })),
  }));
}

async function readLog(
  filePath: string,
  sensitiveValues: readonly string[],
): Promise<string> {
  try {
    const data = await readFile(filePath);
    return boundedDiagnosticLog(data, sensitiveValues);
  } catch {
    return "Log file was not available when this diagnostic package was created.\n";
  }
}

function zipBuffer(
  entries: Array<{ name: string; content: string }>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    for (const entry of entries)
      zip.addBuffer(Buffer.from(entry.content, "utf8"), entry.name);
    zip.end();
  });
}

export async function createDiagnosticBundle(
  services: Services,
  options: DiagnosticBundleOptions = {},
): Promise<Buffer> {
  const rooms = services.rooms.list();
  const includeRooms = options.includeRooms ?? true;
  const includePerformance = services.manager.performance.enabled;
  const sensitiveValues = rooms
    .flatMap((room) => [room.url, room.displayName])
    .filter((item) => item.length > 0);
  const stateDir =
    options.stateDir ??
    process.env.LIVE_RECORDER_STATE_DIR ??
    path.join(defaultDataDir(), "state");
  const [currentLog, previousLog, douyinAuthorized, bilibiliAuthorized] =
    await Promise.all([
      readLog(path.join(stateDir, "backend.log"), sensitiveValues),
      readLog(path.join(stateDir, "backend.previous.log"), sensitiveValues),
      services.secretStore.has(DOUYIN_COOKIE_KEY),
      services.secretStore.has(BILIBILI_COOKIE_KEY),
    ]);
  const exportedAt = services.clock.iso();
  const runtime = {
    exportedAt,
    appVersion: APP_VERSION,
    apiVersion: API_VERSION,
    nodeVersion: process.version,
    operatingSystem: os.platform(),
    architecture: os.arch(),
    mode: services.mode,
    serviceStartedAt: new Date(services.startedAt).toISOString(),
    uptimeSeconds: Math.max(
      0,
      Math.round((services.clock.now() - services.startedAt) / 1000),
    ),
    platformAuthorizationConfigured: {
      douyin: douyinAuthorized,
      bilibili: bilibiliAuthorized,
    },
  };
  const readme = [
    "Live Recorder 诊断日志包",
    `导出时间：${exportedAt}`,
    "",
    `本包包含：已脱敏的后端日志、前端异常摘要、运行环境信息${includePerformance ? "、最近启动性能记录" : ""}${includeRooms ? "、直播间诊断快照（平台、公开房间号及状态）" : ""}。`,
    `本包不包含：密码、Cookie、令牌、邮箱地址、原始直播间链接、自定义直播间名称、标签、设置、录像、数据库数据和本地文件路径${includeRooms ? "" : "，以及任何直播间信息"}。`,
    "诊断包仅在本机生成，不会被应用自动上传；请仅在需要协助排查问题时主动分享。",
    "",
  ].join("\n");
  const entries = [
    { name: "README.txt", content: readme },
    { name: "runtime.json", content: `${JSON.stringify(runtime, null, 2)}\n` },
    {
      name: "frontend-errors.json",
      content: `${JSON.stringify(frontendDiagnosticSummary(options.frontendDiagnostics, sensitiveValues), null, 2)}\n`,
    },
    { name: "backend.log", content: currentLog },
    { name: "backend.previous.log", content: previousLog },
  ];
  if (includePerformance) {
    entries.splice(3, 0, {
      name: "startup-performance.json",
      content: `${JSON.stringify(performanceDiagnosticSummary(services.manager.performance.recent()), null, 2)}\n`,
    });
  }
  if (includeRooms)
    entries.splice(2, 0, {
      name: "rooms.json",
      content: `${JSON.stringify(roomDiagnosticSnapshots(services), null, 2)}\n`,
    });
  return zipBuffer(entries);
}
