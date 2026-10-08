import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { platformFetch } from './transport.js';
import { parseFetchResponse } from './douyin-protocol.js';
import type { DanmakuAdapter, DanmakuMessage } from '../types.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const FETCH_URL = 'https://live.douyin.com/webcast/im/fetch/';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function responseBytes(response: Response): Promise<Buffer> {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`抖音弹幕接口 HTTP ${response.status}`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('抖音弹幕接口返回空内容');
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(parts, total);
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error('抖音弹幕响应过大');
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
async function resolveRoom(roomUrl: string, cookie: string | null, signal: AbortSignal) {
  const webRid = new URL(roomUrl).pathname.split('/').filter(Boolean).at(-1) ?? '';
  const headers: Record<string, string> = { referer: roomUrl, 'user-agent': UA, ...(cookie ? { cookie } : {}) };
  if (!/(?:^|;)\s*ttwid=/.test(cookie ?? '')) {
    const home = await platformFetch('https://live.douyin.com/', { headers }, signal);
    const ttwid = home.headers.getSetCookie().map(value => /^ttwid=([^;]+)/.exec(value)?.[1]).find(Boolean);
    await home.body?.cancel();
    if (ttwid) headers.cookie = [cookie, `ttwid=${ttwid}`].filter(Boolean).join('; ');
  }
  const params = new URLSearchParams({ aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web', enter_from: 'web_live', web_rid: webRid, enter_from_merge: 'web_live', is_need_double_stream: 'false' });
  const response = await platformFetch(`https://live.douyin.com/webcast/room/web/enter/?${params}`, { headers }, signal);
  const json = JSON.parse((await responseBytes(response)).toString()) as {
    status_code?: number; data?: { data?: { id_str?: string; id?: string; room_id?: string; status?: number }[] };
  };
  if (json.status_code !== 0) throw new Error(json.status_code === 8 ? '抖音授权失效，请重新授权' : '抖音直播间信息暂不可用');
  const entry = json.data?.data?.[0], roomId = entry?.id_str ?? entry?.id ?? entry?.room_id;
  // Never round a 64-bit room ID through a JavaScript number.
  if (typeof roomId !== 'string' || !/^\d+$/.test(roomId)) throw new Error('抖音直播间缺少有效房间 ID');
  if (entry?.status !== undefined && entry.status !== 2) throw new Error('抖音直播间已下播');
  return { roomId, headers };
}

/** Server-supported incremental pull; a shared adapter owns one loop per room. */
export const douyinDanmakuAdapter: DanmakuAdapter = {
  platform: 'douyin',
  async *collect(roomUrl, cookie, signal, onConnected): AsyncIterable<DanmakuMessage> {
    const { roomId, headers } = await resolveRoom(roomUrl, cookie, signal);
    const userUniqueId = String(7300000000000000000n + randomBytes(8).readBigUInt64BE() % 700000000000000000n);
    const params = new URLSearchParams({ aid: '6383', app_name: 'douyin_web', live_id: '1', device_platform: 'web', room_id: roomId, resp_content_type: 'protobuf', version_code: '180800', webcast_sdk_version: '1.0.14-beta.0', update_version_code: '1.0.14-beta.0', identity: 'audience', user_unique_id: userUniqueId, did_rule: '3', endpoint: 'live_pc', support_wrds: '1' });
    const seen = new Set<string>();
    let connected = false;
    while (!signal.aborted) {
      const startedAt = Date.now();
      const response = await platformFetch(`${FETCH_URL}?${params}`, { headers }, signal);
      const page = parseFetchResponse(await responseBytes(response));
      signal.throwIfAborted();
      params.set('cursor', page.cursor);
      params.set('internal_ext', page.internalExt);
      if (!connected) { connected = true; onConnected?.(); }
      const wallMs = Date.now();
      for (const message of page.messages) {
        signal.throwIfAborted();
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        if (seen.size > 2048) seen.delete(seen.values().next().value!);
        yield { id: `douyin:${roomId}:${message.id}`, tMs: null, wallMs, text: message.text };
      }
      // Sequential, cancellable polling with platform pacing; no overlap or orphan timers.
      await delay(Math.max(0, page.intervalMs - (Date.now() - startedAt)), undefined, { signal, ref: false });
    }
  },
};
