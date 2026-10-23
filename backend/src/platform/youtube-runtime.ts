import { fileURLToPath } from "node:url";
import { youtubeProxy } from "./youtube-network.js";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { trackFfmpeg } from "../recorder/ffmpeg-registry.js";
import { AppError } from "../types/error.js";

export function youtubeBinary(): string {
  const name = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const bundled = path.join(path.dirname(process.execPath), name);
  const development = fileURLToPath(
    new URL(`../../../frontend/src-tauri/.bundle/${name}`, import.meta.url),
  );
  const bundledDirectory = path.join(path.dirname(process.execPath), 'youtube-runtime', 'yt-dlp_macos');
  const developmentDirectory = fileURLToPath(new URL('../../../frontend/src-tauri/.bundle/youtube-runtime/yt-dlp_macos', import.meta.url));
  return (
    process.env.LR_YTDLP_PATH ||
    (process.platform === 'darwin' && existsSync(bundledDirectory) ? bundledDirectory : undefined) ||
    (process.platform === 'darwin' && existsSync(developmentDirectory) ? developmentDirectory : undefined) ||
    (existsSync(bundled)
      ? bundled
      : existsSync(development)
        ? development
        : name)
  );
}

export function normalizeYoutubeCookies(raw: string): string {
  if (Buffer.byteLength(raw) > 256 * 1024)
    throw new AppError("CONFIG_INVALID", "YouTube 登录凭据过大，请重新授权");
  const lines = raw.replace(/\r\n/g, "\n").trim().split("\n");
  if (!lines[0]?.match(/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)/))
    throw new AppError(
      "CONFIG_INVALID",
      "YouTube 登录凭据格式无效，请重新授权",
    );
  const kept = lines.filter((line) => {
    if (
      !line.trim() ||
      (line.startsWith("#") && !line.startsWith("#HttpOnly_"))
    )
      return true;
    const fields = line.replace(/^#HttpOnly_/, "").split("\t");
    if (fields.length !== 7 || fields.some((value) => value.includes("\0")))
      throw new AppError("CONFIG_INVALID", "YouTube 登录凭据格式无效，请重新授权");
    const domain = fields[0]!.replace(/^\./, "").toLowerCase();
    return (
      domain === "youtube.com" ||
      domain.endsWith(".youtube.com") ||
      domain === "google.com" ||
      domain.endsWith(".google.com")
    );
  });
  if (
    !kept.some(
      (line) =>
        line.trim() && (!line.startsWith("#") || line.startsWith("#HttpOnly_")),
    )
  )
    throw new AppError("CONFIG_INVALID", "未获取到 YouTube 登录凭据，请重新授权");
  return kept.join("\n") + "\n";
}

export async function youtubeArguments(
  cookie?: string,
  snapshot?: { json: string; expiresAt: number },
): Promise<{ args: string[]; dispose: () => Promise<void> }> {
  const proxy = await youtubeProxy();
  const args = [
    "--ignore-config",
    "--no-warnings",
    "--no-progress",
    "--no-cache-dir",
    "--js-runtimes",
    `node:${process.execPath}`,
  ];
  if (proxy) args.push("--proxy", proxy);
  const reusable = snapshot && snapshot.expiresAt > Date.now() &&
    Buffer.byteLength(snapshot.json) <= 8 * 1024 * 1024;
  if (!cookie && !reusable) return { args, dispose: async () => {} };
  const directory = await mkdtemp(path.join(tmpdir(), "lr-youtube-"));
  try {
    if (cookie) {
      const file = path.join(directory, "cookies.txt");
      await writeFile(file, normalizeYoutubeCookies(cookie), { mode: 0o600 });
      args.push("--cookies", file);
    }
    if (reusable) {
      const file = path.join(directory, "source.info.json");
      await writeFile(file, snapshot.json, { mode: 0o600 });
      args.push("--load-info-json", file);
    }
    return {
      args,
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Register the extractor as well as its FFmpeg descendants for shutdown. */
const closedYoutubeChildren = new WeakSet<ChildProcess>();
export function spawnYoutube(args: string[], binary = youtubeBinary()) {
  const child = spawn(binary, args, {
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    // 错误词面必须全球一致：gettext 跟随系统语言会把分类用的英文消息翻成中文，
    // 强制英文后错误归桶不再受运行环境摆布（真实 Cookie 场景曾因此漏桶）。
    env: {
      ...process.env,
      LANGUAGE: "en",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
    },
  });
  const untrack = trackFfmpeg(child, true);
  child.once("close", () => {
    closedYoutubeChildren.add(child);
    untrack();
  });
  child.once("error", untrack);
  return child;
}

export function terminateYoutube(child: ChildProcess, force = false): void {
  // The extractor may exit before descendants close their inherited pipes.
  // Keep its process group cancellable until `close`, without signalling a
  // potentially reused process ID after all owned handles have closed.
  if (!child.pid || closedYoutubeChildren.has(child)) return;
  if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) return;
  if (process.platform === "win32" && child.pid) {
    const killer = spawn(
      "taskkill",
      ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
      { windowsHide: true, stdio: "ignore" },
    );
    killer.on("error", () => child.kill(force ? "SIGKILL" : "SIGTERM"));
  } else {
    try {
      process.kill(-child.pid!, force ? "SIGKILL" : "SIGTERM");
    } catch {
      child.kill(force ? "SIGKILL" : "SIGTERM");
    }
  }
}

export function youtubeError(stderr: string, missing = false): AppError {
  // 失败分类诊断只留词面尾部，不碰凭证值；桶名随报文一起定位归因。
  if (stderr && stderr !== "timeout" && stderr !== "invalid json")
    console.log(`[youtube] error-classify stderr=${stderr.slice(-300)}`);
  if (missing)
    return new AppError(
      "CONFIG_INVALID",
      "缺少 YouTube 解析器，请重新安装完整客户端或设置 LR_YTDLP_PATH",
      { retryable: false },
    );
  if (
    /not currently live|not live|live event will begin|premieres in/i.test(
      stderr,
    )
  )
    return new AppError(
      "ROOM_CONTENT_UNAVAILABLE",
      "YouTube 直播尚未开始或已经结束",
      { retryable: false },
    );
  if (
    /sign in|private video|this video is private|this channel is private|members.only|age.restricted|confirm.*bot|PO Token|not available in your country|may not extract correctly without a successful webpage download/i.test(
      stderr,
    )
  )
    return new AppError(
      "PLATFORM_ACCESS_RESTRICTED",
      "YouTube 访问受限，请检查登录凭据、地区权限或平台验证要求",
      { retryable: false },
    );
  // 频道存在但没有直播入口=永久内容事实：与「未找到」区分开给更准的指引，
  // 同走链接码让检测/接口层的永久失败浮出机制生效（不被状态检测吸收为 offline）。
  if (
    /does not have a streams tab|此频道没有直播|没有直播标签/i.test(stderr)
  )
    return new AppError(
      "ROOM_LINK_INVALID",
      "该频道没有直播内容，无法作为直播间添加（重试不会恢复）",
      { retryable: false },
    );
  // 解析失败≠网络失败：链接不存在/内容不可用重试不会恢复，必须给独立文案并置不可重试，
  // 否则用户会对着错误链接反复重试。判定词面刻意不收裸 “not found”（Host not found 属 DNS 网络类）；
  // HTTP 404 与 “YouTube said: ERROR” 是平台给出的「确无此内容/内容级错误」结构信号，
  // 兑住词面枚举永远滞后的变体（not-live/受限两桶在前优先命中各自签名）。
  // 代码归 ROOM_LINK_INVALID 而非 ROOM_CONTENT_UNAVAILABLE：后者承载「未开播/已结束」且被
  // 状态检测吸收为 offline，永久性链接失败必须走错误通道浮出。
  if (
    /does not exist|(?:channel|user|account|video|playlist) (?:was )?not found|this channel is unavailable|account.*terminated|no videos found|incomplete youtube id|unsupported url|video (?:is )?unavailable|requested entity was not found|http error 404|http\/1\.[01] 404|http 错误 404|404[：:]\s*未找到|youtube said:\s*error|此视频不能观看|视频不可用|此视频无法观看|此频道不存在|请求的实体未找到/i.test(
      stderr,
    )
  )
    return new AppError(
      "ROOM_LINK_INVALID",
      "未找到该频道或直播，请检查链接是否正确（重试不会恢复）",
      { retryable: false },
    );
  return new AppError(
    "NETWORK_UNAVAILABLE",
    "YouTube 解析或拉流失败，请检查系统网络后重试",
    { retryable: true },
  );
}

export interface YoutubeInfo {
  id: string;
  epoch?: number;
  channel_id?: string;
  channel?: string;
  uploader?: string;
  title?: string;
  live_status?: string;
  is_live?: boolean;
  release_timestamp?: number;
  timestamp?: number;
  thumbnail?: string;
  acodec?: string;
  requested_formats?: Array<{ acodec?: string; vcodec?: string }>;
  thumbnails?: Array<{ url: string }>;
  formats?: Array<{
    url?: string;
    format_id?: string;
    height?: number;
    fps?: number;
    vcodec?: string;
    acodec?: string;
  }>;
  entries?: YoutubeInfo[];
}

// Bound subprocess concurrency, queue length, JSON size and cache cardinality.
// 状态检测要立刻跟上开播/下播，缓存只做瞬时去抖；单场会话的媒体信息在几分钟内稳定，
// 放宽复用窗口让用户短时间内重开预览、预览转录制不再重复解析。
const STATUS_CACHE_MS = 15_000;
const INFO_CACHE_MS = 60_000;
/** 快照（--load-info-json / HLS 复用）窗口与会话信息缓存保持一致，过期重新解析。 */
export const YOUTUBE_SNAPSHOT_TTL_MS = INFO_CACHE_MS;
let active = 0;
const waiting: Array<() => void> = [];
const cache = new Map<string, { until: number; value: Promise<YoutubeInfo> }>();
export async function extractYoutube(
  url: string,
  cookie?: string,
  flat = false,
): Promise<YoutubeInfo> {
  const key = `${flat}:${url}:${createHash("sha256")
    .update(cookie ?? "")
    .digest("hex")}`;
  const startedMs = Date.now();
  const mode = flat ? "flat" : "full";
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) {
    // inflight=同参调用在飞（去重），hit=已解析结果复用。
    console.log(`[youtube] extract mode=${mode} cache=${hit.until === Infinity ? "inflight" : "hit"} ms=${Date.now() - startedMs}`);
    return hit.value;
  }
  if (waiting.length >= 16)
    throw new AppError("NETWORK_UNAVAILABLE", "YouTube 检测繁忙，请稍后重试", {
      retryable: true,
    });
  const value = (async () => {
    if (active >= 2)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    let auth: Awaited<ReturnType<typeof youtubeArguments>> | undefined;
    try {
      auth = await youtubeArguments(cookie);
      return await new Promise<YoutubeInfo>((resolve, reject) => {
        const child = spawnYoutube([
          ...auth!.args,
          "--dump-single-json",
          "--skip-download",
          // 真实 Cookie 场景 yt-dlp 会先跑 youtubetab 的 authcheck 自检，失败时把真 404 拦在前面，
          // 只留一段提示性 stderr（连修法都写在提示里）。我们只取公开内容，跳过该自检让真错误露出。
          "--extractor-args",
          "youtubetab:skip=authcheck",
          ...(flat
            ? ["--flat-playlist", "--playlist-end", "20"]
            : ["--no-playlist"]),
          "--",
          url,
        ]);
        let output = "",
          stderr = "",
          settled = false;
        const finish = (error?: Error, info?: YoutubeInfo) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            terminateYoutube(child, true);
            reject(error);
          } else resolve(info!);
        };
        const timer = setTimeout(() => finish(youtubeError("timeout")), 30_000);
        child.stdout.on("data", (data: Buffer) => {
          output += data.toString();
          if (output.length > 8 * 1024 * 1024)
            finish(new AppError("CONFIG_INVALID", "YouTube 返回数据超过上限"));
        });
        child.stderr.on("data", (data: Buffer) => {
          stderr = (stderr + data.toString()).slice(-8192);
        });
        child.on("error", (error: NodeJS.ErrnoException) =>
          finish(youtubeError("", error.code === "ENOENT")),
        );
        child.on("close", (code) => {
          if (code !== 0) return finish(youtubeError(stderr));
          try {
            finish(undefined, JSON.parse(output) as YoutubeInfo);
          } catch {
            finish(youtubeError("invalid json"));
          }
        });
      });
    } finally {
      await auth?.dispose();
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  })();
  cache.set(key, { until: Infinity, value });
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
  void value.then(
    () => {
      const entry = cache.get(key);
      const ttl = flat ? STATUS_CACHE_MS : INFO_CACHE_MS;
      if (entry?.value === value) entry.until = Date.now() + ttl;
      console.log(`[youtube] extract mode=${mode} cache=miss ms=${Date.now() - startedMs} ttl=${ttl}`);
    },
    () => {
      console.log(`[youtube] extract mode=${mode} cache=miss failed ms=${Date.now() - startedMs}`);
    },
  );
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}
