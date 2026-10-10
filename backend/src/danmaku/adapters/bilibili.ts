import { inflateSync, brotliDecompressSync } from "node:zlib";
import { platformFetch, socketTextStream } from "./transport.js";
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
  signal: AbortSignal,
): Promise<{ query: string; uid: number }> {
  const navRes = await platformFetch("https://api.bilibili.com/x/web-interface/nav", { headers }, signal);
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

export function* packets(buf: Buffer, depth = 0): Generator<{ op: number; body: Buffer }> {
  if (depth > 4) throw new Error("弹幕压缩嵌套过深");
  let offset = 0;
  while (offset + 16 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const headerLen = buf.readUInt16BE(offset + 4);
    const ver = buf.readUInt16BE(offset + 6);
    const op = buf.readUInt32BE(offset + 8);
    if (headerLen < 16 || len < headerLen || offset + len > buf.length) throw new Error("弹幕包头无效");
    let body = buf.subarray(offset + headerLen, offset + len);
    offset += len;
    if (ver === 2) {
      try {
        body = inflateSync(body, { maxOutputLength: 4 * 1024 * 1024 });
      } catch {
        continue;
      }
    } else if (ver === 3) {
      try {
        body = brotliDecompressSync(body, { maxOutputLength: 4 * 1024 * 1024 });
      } catch {
        continue;
      }
    }
    if (ver === 2 || ver === 3) {
      yield* packets(body, depth + 1);
    } else {
      yield { op, body };
    }
  }
}

export const bilibiliDanmakuAdapter: DanmakuAdapter = {
  platform: "bilibili",
  async *collect(roomUrl, cookie, signal, onConnected): AsyncIterable<DanmakuMessage> {
    const requestedId = new URL(roomUrl).pathname.match(/^\/(\d+)/)?.[1];
    if (!requestedId) throw new Error("room id missing");
    const headers: Record<string, string> = { referer: WS_ORIGIN, origin: WS_ORIGIN, "user-agent": UA };
    if (cookie) headers.cookie = cookie;
    // Popular short room IDs must be resolved before websocket authentication.
    const init = await platformFetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${requestedId}`, { headers }, signal);
    const room = await init.json() as { data?: { room_id?: number } };
    const roomId = String(room.data?.room_id ?? requestedId);
    const signed = await wbiSign({ id: roomId, type: "0", web_location: "444.8" }, headers, signal);
    const infoRes = await platformFetch(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${signed.query}`, { headers }, signal);
    const info = await infoRes.json() as { code?: number; data?: { token?: string; host_list?: { host: string; wss_port: number }[] } };
    const token = info.data?.token, host = info.data?.host_list?.[0];
    if (info.code !== 0 || !token || !host) throw new Error("danmu info unavailable");
    const buvid = /buvid3=([^;]+)/.exec(cookie ?? "")?.[1] ?? "";
    yield* socketTextStream(`wss://${host.host}:${host.wss_port}/sub`, headers, signal, {
      open: ws => ws.send(packet(7, Buffer.from(JSON.stringify({ uid: signed.uid, roomid: Number(roomId), protover: 3,
        platform: "web", type: 2, key: token, ...(buvid ? { buvid } : {}) })))),
      frame: (buffer, _ws, ready) => {
        const texts: string[] = [];
        for (const pkt of packets(buffer)) {
          if (pkt.op === 8) {
            const auth = JSON.parse(pkt.body.toString("utf8")) as { code?: number };
            if (auth.code !== 0) throw new Error("弹幕鉴权失败");
            ready();
          } else if (pkt.op === 5) {
            try {
              const json = JSON.parse(pkt.body.toString("utf8")) as { cmd?: string; info?: unknown[] };
              if (json.cmd?.startsWith("DANMU_MSG") && typeof json.info?.[1] === "string") texts.push(json.info[1]);
            } catch { /* ignore one malformed business message */ }
          }
        }
        return texts;
      },
      heartbeat: ws => ws.send(packet(2, Buffer.alloc(0))),
    }, onConnected);
  },
};
