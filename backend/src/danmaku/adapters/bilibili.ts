import { inflateSync, brotliDecompressSync } from "node:zlib";
import WebSocket from "ws";
import { createHash } from "node:crypto";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
import type { DanmakuAdapter, DanmakuMessage } from "../types.js";

const WS_ORIGIN = "https://live.bilibili.com";

const WBI_MIXIN_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

function mixinKey(raw: string): string {
  return WBI_MIXIN_TABLE.map((i) => raw[i] ?? "").join("").slice(0, 32);
}

function md5(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

/** WBI 签名：bili 风控（-352）要求请求带 w_rid/wts（标准做法）；顺带取登录 uid。 */
async function wbiSign(
  params: Record<string, string>,
  headers: Record<string, string>,
): Promise<{ query: string; uid: number }> {
  const navRes = await fetch("https://api.bilibili.com/x/web-interface/nav", { headers });
  const navJson = (await navRes.json()) as {
    data?: { wbi_img?: { img_url?: string; sub_url?: string }; mid?: number };
  };
  const imgKey = (navJson.data?.wbi_img?.img_url ?? "").split("/").pop()?.split(".")[0] ?? "";
  const subKey = (navJson.data?.wbi_img?.sub_url ?? "").split("/").pop()?.split(".")[0] ?? "";
  const key = mixinKey(imgKey + subKey);
  const wts = Math.floor(Date.now() / 1000);
  const signed: Record<string, string> = { ...params, wts: String(wts) };
  const query = Object.keys(signed)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(signed[k]!)}`)
    .join("&");
  const wRid = md5(query + key);
  return { query: `${query}&w_rid=${wRid}`, uid: navJson.data?.mid ?? 0 };
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

/** B 站弹幕包：16 字节头（长度/头长/版本/操作码/序列）+ 体。 */
function packet(op: number, body: Buffer): Buffer {
  return Buffer.concat([u32(16 + body.length), u16(16), u16(1), u32(op), u32(1), body]);
}

function* packets(buf: Buffer): Generator<{ op: number; body: Buffer }> {
  let offset = 0;
  while (offset + 16 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const headerLen = buf.readUInt16BE(offset + 4);
    const ver = buf.readUInt16BE(offset + 6);
    const op = buf.readUInt32BE(offset + 8);
    if (len < headerLen || offset + len > buf.length) return;
    let body = buf.subarray(offset + headerLen, offset + len);
    offset += len;
    if (ver === 2) {
      try {
        body = inflateSync(body);
      } catch {
        continue;
      }
    } else if (ver === 3) {
      try {
        body = brotliDecompressSync(body);
      } catch {
        continue;
      }
    }
    if (ver === 2 || ver === 3) {
      yield* packets(body);
    } else {
      yield { op, body };
    }
  }
}

async function openDanmakuWs(
  roomUrl: string,
  cookie: string | null,
  onMessage: (text: string) => void,
  onOpen: () => void,
  signal: AbortSignal,
): Promise<void> {
  const roomId = /(\d+)/.exec(roomUrl)?.[1];
  if (!roomId) throw new Error("room id missing");
  const headers: Record<string, string> = {
    referer: WS_ORIGIN,
    origin: WS_ORIGIN,
    "user-agent": UA,
  };
  if (cookie) headers.cookie = cookie;

  const signed = await wbiSign(
    { id: roomId, type: "0", web_location: "444.8" },
    headers,
  ).catch(() => ({ query: `id=${roomId}`, uid: 0 }));
  const uid = signed.uid;
  const infoRes = await fetch(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${signed.query}`,
    { headers },
  );
  const infoJson = (await infoRes.json()) as {
    code?: number;
    message?: string;
    data?: { token?: string; host_list?: { host: string; wss_port: number }[] };
  };
  const token = infoJson.data?.token;
  const host = infoJson.data?.host_list?.[0];
  console.log(
    `[danmaku ${new Date().toISOString()}] bili-danmuinfo status=${infoRes.status} code=${infoJson.code ?? "-"} hasToken=${Boolean(token)} hasHost=${Boolean(host)} msg=${infoJson.message ?? "-"}`,
  );
  if (!token || !host) throw new Error("danmu info unavailable");

  const url = `wss://${host.host}:${host.wss_port}/sub`;
  const ws = new WebSocket(url, { headers });
  // global WebSocket 不能携自定义头；鉴权走 fetch 阶段（token/room_id），连接本身无需 cookie。

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

  const buvid = /buvid3=([^;]+)/.exec(cookie ?? "")?.[1] ?? "";
  const join = JSON.stringify({
    uid,
    roomid: Number(roomId),
    protover: 3,
    platform: "web",
    type: 2,
    key: token,
    ...(buvid ? { buvid } : {}),
  });
  ws.send(packet(7, Buffer.from(join)));
  onOpen();
  const heartbeat = setInterval(() => {
    try {
      ws.send(packet(2, Buffer.alloc(0)));
    } catch {
      /* 心跳失败由断连收束 */
    }
  }, 30_000);
  heartbeat.unref?.();

  await new Promise<void>((resolve) => {
    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        for (const pkt of packets(buf)) {
          if (pkt.op !== 5) continue;
          const json = JSON.parse(pkt.body.toString("utf8")) as {
            cmd?: string;
            info?: unknown[];
          };
          if (!json.cmd?.startsWith("DANMU_MSG")) continue;
          const info = json.info;
          const text = Array.isArray(info) ? String((info[1] as string) ?? "") : "";
          if (text) onMessage(text);
        }
      } catch {
        /* 单包解析失败不影响后续 */
      }
    });
    ws.on("close", (code: number, reason: Buffer) => {
      console.log(`[danmaku ${new Date().toISOString()}] bili-ws-close code=${code} reason=${reason?.toString() || "-"}`);
      resolve();
    });
    ws.on("error", (error: Error) => {
      console.log(`[danmaku ${new Date().toISOString()}] bili-ws-error err=${error?.message ?? error}`);
      resolve();
    });
    signal.addEventListener("abort", () => resolve());
  });
  clearInterval(heartbeat);
}

export const bilibiliDanmakuAdapter: DanmakuAdapter = {
  platform: "bilibili",
  async *collect(roomUrl, cookie, signal): AsyncIterable<DanmakuMessage> {
    const queue: DanmakuMessage[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let seq = 0;
    const notify = () => {
      const fn = wake;
      wake = null;
      fn?.();
    };
    const push = (text: string) => {
      seq += 1;
      queue.push({
        id: `bb-${Date.now()}-${seq}`,
        tMs: null,
        wallMs: Date.now(),
        text,
      });
      notify();
    };
    let adapterError: Error | null = null;
    const pump = openDanmakuWs(roomUrl, cookie, push, () => undefined, signal)
      .catch((error: Error) => {
        adapterError = error;
        console.log(`[danmaku ${new Date().toISOString()}] adapter-error platform=bilibili err=${error?.message ?? error}`);
      })
      .finally(() => {
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
    if (adapterError) throw adapterError;
  },
};
