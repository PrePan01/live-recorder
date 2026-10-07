import { gunzipSync } from "node:zlib";
import WebSocket from "ws";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
import type { DanmakuAdapter, DanmakuMessage } from "../types.js";

/** 只读 protobuf 走线器：不引 schema，把长度分隔字段里的文本扫出来（协议常变，取文本为启发式）。 */
function walkStrings(buf: Buffer, out: string[], depth = 0): void {
  if (depth > 6) return;
  let i = 0;
  while (i < buf.length) {
    const keyByte = buf[i];
    if (keyByte === undefined) return;
    i += 1;
    let key = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i]!;
      i += 1;
      key |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    const field = key >> 3;
    const wire = key & 0x7;
    if (field === 0) return;
    if (wire === 0) {
      while (i < buf.length && (buf[i]! & 0x80) !== 0) i += 1;
      i += 1;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 2) {
      let len = 0;
      let shift2 = 0;
      while (i < buf.length) {
        const b = buf[i]!;
        i += 1;
        len |= (b & 0x7f) << shift2;
        shift2 += 7;
        if ((b & 0x80) === 0) break;
      }
      const chunk = buf.subarray(i, i + len);
      i += len;
      const text = chunk.toString("utf8");
      if (len > 0 && len < 2000 && /^[\p{L}\p{N}\p{P}\p{Zs}]+$/u.test(text)) {
        out.push(text);
      } else {
        walkStrings(chunk, out, depth + 1);
      }
    } else if (wire === 5) {
      i += 4;
    } else {
      return;
    }
  }
}

function parsePushFrame(buf: Buffer): string[] {
  const texts: string[] = [];
  try {
    const frame = buf;
    // PushFrame.payload=字段 5（gzip 压缩的 Response）
    let i = 0;
    while (i < frame.length) {
      const keyByte = frame[i]!;
      i += 1;
      let key = 0;
      let shift = 0;
      while (i < frame.length) {
        const b = frame[i]!;
        i += 1;
        key |= (b & 0x7f) << shift;
        shift += 7;
        if ((b & 0x80) === 0) break;
      }
      const wire = key & 0x7;
      if (wire === 2) {
        let len = 0;
        let shift2 = 0;
        while (i < frame.length) {
          const b = frame[i]!;
          i += 1;
          len |= (b & 0x7f) << shift2;
          shift2 += 7;
          if ((b & 0x80) === 0) break;
        }
        const chunk = frame.subarray(i, i + len);
        i += len;
        try {
          const inner = gunzipSync(chunk);
          const found: string[] = [];
          walkStrings(inner, found);
          if (found.length >= 2) {
            // ChatMessage 的文本=整体最长串；昵称=剩余里的合理短串（启发式，不猜不造）。
            const content = found.reduce((a, b) => (b.length > a.length ? b : a), "");
            if (content) texts.push(content);
          }
        } catch {
          /* 非 gzip 段跳过 */
        }
      } else if (wire === 0) {
        while (i < frame.length && (frame[i]! & 0x80) !== 0) i += 1;
        i += 1;
      } else if (wire === 1) {
        i += 8;
      } else if (wire === 5) {
        i += 4;
      } else {
        break;
      }
    }
  } catch {
    /* 整帧解析失败忽略 */
  }
  return texts;
}

function randomHex(len: number): string {
  let out = "";
  for (let i = 0; i < len; i += 1) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/** 风控参数补齐：enter/im-info 对缺 webid/msToken/ttwid 的请求不下发配置（第二刀）。 */
async function enrichAuth(
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  const out = { ...headers };
  const cookieParts = (out.cookie ?? "").split(";").filter(Boolean);
  if (!cookieParts.some((c) => c.trim().startsWith("ttwid="))) {
    const ttwid = await fetch("https://ttwid.bytedance.com/ttid/register/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region: "cn", aid: 1128, need_qrcode: false }),
    })
      .then((r) => /ttwid=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? "")
      .catch(() => "");
    if (ttwid) cookieParts.push(`ttwid=${ttwid}`);
  }
  out.cookie = cookieParts.join("; ");
  const webid = await fetch(
    "https://live.douyin.com/webcast/room/webid/info/?live_id=1&device_platform=web&app_id=6383",
    { headers: out },
  )
    .then((r) => r.json())
    .then((j) => (j as { data?: { webid?: string } })?.data?.webid ?? "")
    .catch(() => "");
  out["x-ms-token"] = randomHex(128);
  if (webid) out["x-web-id"] = webid;
  return out;
}

async function resolveRoomId(
  roomUrl: string,
  cookie: string | null,
): Promise<{ roomId: string; wsUrl: string }> {
  const webRid = /(\d+)/.exec(roomUrl)?.[1] ?? roomUrl.split("/").pop() ?? "";
  const headers: Record<string, string> = {
    referer: "https://live.douyin.com/",
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  };
  if (cookie) headers.cookie = cookie;
  const authHeaders = await enrichAuth(headers);
  const res = await fetch(
    `https://live.douyin.com/webcast/room/web/enter/?web_rid=${webRid}&aid=6383&app_name=douyin_web&live_id=1&device_platform=web&language=zh-CN&web_id=${encodeURIComponent(authHeaders["x-web-id"] ?? "")}&msToken=${encodeURIComponent(authHeaders["x-ms-token"] ?? "")}`,
    { headers: authHeaders },
  );
  const json = (await res.json()) as {
    data?: { data?: { room_id?: string | number; id_str?: string }[] };
  };
  const entry = json.data?.data?.[0];
  const roomId = entry?.room_id ?? entry?.id_str;
  console.log(
    `[danmaku ${new Date().toISOString()}] douyin-enter status=${res.status} hasData=${Boolean(json.data?.data?.length)} hasRoomId=${Boolean(roomId)}`,
  );
  if (!roomId) throw new Error("room id unavailable");
  // WSS 服务器=平台下发（优先从 enter 响应内扫 wss 地址，配置同源；独立 im/info 端点常 404 不可靠）。
  const enterWss = (JSON.stringify(json).match(/wss?:\\?\/\\?\/[^"\\\s]+/g) ?? []).map((u) =>
    u.replace(/\\\//g, "/"),
  );
  let wsUrl = enterWss[0] ?? "";
  console.log(
    `[danmaku ${new Date().toISOString()}] douyin-wss-scan enterCandidates=${enterWss.length} first=${wsUrl || "-"}`,
  );
  if (!wsUrl) {
    // 备选：im/info——端点 host 历来在 API 域（live.douyin.com 是页面 host，GET/POST 全 404），
    // 逐 host 逐方法试到底，全程带诊断行。
    const hosts = [
      "https://webcast.amemv.com",
      "https://api.douyin.com",
      "https://live.douyin.com",
    ];
    const tries: { base: string; method: "GET" | "POST" }[] = [];
    for (const base of hosts) for (const method of ["GET", "POST"] as const) tries.push({ base, method });
    for (const { base, method } of tries) {
      const infoRes = await fetch(
        `${base}/webcast/im/info/?room_id=${roomId}&app_id=1128&version_code=1.0.0&web_id=${encodeURIComponent(authHeaders["x-web-id"] ?? "")}&msToken=${encodeURIComponent(authHeaders["x-ms-token"] ?? "")}`,
        { headers: authHeaders, method },
      ).catch(() => null);
      if (!infoRes) continue;
      const rawText = await infoRes.text();
      console.log(
        `[danmaku ${new Date().toISOString()}] douyin-im-info method=${method} status=${infoRes.status} head=${rawText.slice(0, 60).replace(/\s+/g, " ")}`,
      );
      const body = rawText.slice(rawText.indexOf("{"));
      try {
        const infoJson = JSON.parse(body) as {
          data?: { ws_url_list?: string[]; wss_url_list?: string[]; data?: { ws_url_list?: string[] }[] };
        };
        wsUrl =
          infoJson.data?.ws_url_list?.[0] ??
          infoJson.data?.wss_url_list?.[0] ??
          infoJson.data?.data?.[0]?.ws_url_list?.[0] ??
          "";
      } catch {
        /* 该方法响应不可解析，试下一个 */
      }
      if (wsUrl) break;
    }
  }
  if (!wsUrl) throw new Error("wss endpoint unavailable");
  return { roomId: String(roomId), wsUrl: wsUrl.startsWith("wss://") || wsUrl.startsWith("ws://") ? wsUrl : `wss://${wsUrl}` };
}

export const douyinDanmakuAdapter: DanmakuAdapter = {
  platform: "douyin",
  async *collect(roomUrl, cookie, signal): AsyncIterable<DanmakuMessage> {
    const { roomId, wsUrl } = await resolveRoomId(roomUrl, cookie);
    const queue: DanmakuMessage[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let seq = 0;
    const notify = () => {
      const fn = wake;
      wake = null;
      fn?.();
    };
    const headers: Record<string, string> = {
      referer: "https://live.douyin.com/",
      origin: "https://live.douyin.com",
      "user-agent": UA,
    };
    if (cookie) headers.cookie = cookie;
    const url = `${wsUrl}${wsUrl.includes("?") ? "&" : "?"}room_id=${roomId}&compress=gzip`;
    // 握手需携 UA/cookie/referer，global WebSocket 不能携头——用 ws 包开连接。
    const ws = new WebSocket(url, { headers });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws open timeout")), 10_000);
      timer.unref?.();
      ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.on("error", (error: Error) => {
        clearTimeout(timer);
        reject(new Error(`ws error: ${error?.message ?? error}`));
      });
      signal.addEventListener("abort", () => {
        try {
          ws.close();
        } catch {
          /* 由 abort 收束 */
        }
      });
    });
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        for (const text of parsePushFrame(raw)) {
          seq += 1;
          queue.push({ id: `dy-${Date.now()}-${seq}`, tMs: null, wallMs: Date.now(), text });
        }
        notify();
      } catch {
        /* 单帧失败不影响后续 */
      }
    });
    const pump = new Promise<void>((resolve) => {
      ws.on("close", (code: number, reason: Buffer) => {
        console.log(`[danmaku ${new Date().toISOString()}] douyin-ws-close code=${code} reason=${reason?.toString() || "-"}`);
        resolve();
      });
      ws.on("error", (error: Error) => {
        console.log(`[danmaku ${new Date().toISOString()}] douyin-ws-error err=${error?.message ?? error}`);
        resolve();
      });
      signal.addEventListener("abort", () => resolve());
    }).finally(() => {
      finished = true;
      notify();
    });
    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      yield queue.shift()!;
    }
    await pump;
  },
};
