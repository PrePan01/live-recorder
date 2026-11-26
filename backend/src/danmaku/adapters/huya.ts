import { sameSiteHeaders } from '../../platform/chinese-live/adapter.js';
import { readTars, tarsBytes, tarsInt, tarsList, tarsString } from '../../platform/huya/tars.js';
import type { DanmakuAdapter } from '../types.js';
import { socketTextStream } from './transport.js';

function command(id: number, data = Buffer.alloc(0)): Buffer {
  return Buffer.concat([tarsInt(0, id), tarsBytes(1, data)]);
}

function textMessage(uri: unknown, data: unknown): string[] {
  if (uri !== 1400 || !Buffer.isBuffer(data)) return [];
  const text = readTars(data).get(3);
  return typeof text === 'string' && text.trim() ? [text] : [];
}

export function decodeHuyaDanmaku(data: Buffer, ready: () => void): string[] {
  const fields = readTars(data);
  const id = fields.get(0);
  const payload = fields.get(1);
  if (id === 17 || id === 7 || id === 22) ready();
  if (!Buffer.isBuffer(payload) || (id !== 7 && id !== 22)) return [];
  const push = readTars(payload);
  if (id === 7) return textMessage(push.get(1), push.get(2));
  const entries = push.get(1);
  return Array.isArray(entries) ? entries.flatMap(entry =>
    entry instanceof Map ? textMessage(entry.get(0), entry.get(1)) : []) : [];
}

export function createHuyaDanmakuAdapter(getUid: (url: string, cookie?: string) => Promise<string>): DanmakuAdapter {
  return {
    platform: 'huya',
    async *collect(roomUrl, cookie, signal, onConnected) {
      signal.throwIfAborted();
      const uid = await getUid(roomUrl, cookie ?? undefined);
      const groups = tarsList(0, [tarsString(0, `live:${uid}`), tarsString(0, `chat:${uid}`)]);
      const join = command(16, Buffer.concat([groups, tarsString(1, '')]));
      const heartbeat = command(20);
      yield* socketTextStream('wss://wsapi.huya.com/', sameSiteHeaders('huya', ''), signal, {
        open(ws) { ws.send(join); ws.send(heartbeat); },
        frame(data, _ws, ready) { return decodeHuyaDanmaku(data, ready); },
        heartbeat(ws) { ws.send(heartbeat); },
      }, onConnected);
    },
  };
}
