import { parseChineseRoomLink, numericRoomId } from '../../platform/chinese-live/url.js';
import { sameSiteHeaders } from '../../platform/chinese-live/adapter.js';
import type { DanmakuAdapter } from '../types.js';
import { socketTextStream } from './transport.js';

function packet(text: string): Buffer {
  const payload = Buffer.from(`${text}\0`);
  const frame = Buffer.alloc(12 + payload.length);
  frame.writeUInt32LE(payload.length + 8, 0);
  frame.writeUInt32LE(payload.length + 8, 4);
  frame.writeUInt16LE(689, 8);
  payload.copy(frame, 12);
  return frame;
}

export function createDouyuDanmakuDecoder() {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return (data: Buffer, ready: () => void): string[] => {
    if (pending.length + data.length > 1024 * 1024) throw new Error('斗鱼弹幕消息过大');
    pending = pending.length ? Buffer.concat([pending, data]) : data;
    const messages: string[] = [];
    let cursor = 0;
    while (pending.length - cursor >= 12) {
      const size = pending.readUInt32LE(cursor);
      if (size < 9 || size > 1024 * 1024 - 4 || size !== pending.readUInt32LE(cursor + 4)) throw new Error('斗鱼弹幕帧格式无效');
      const end = cursor + size + 4;
      if (end > pending.length) break;
      if (pending[end - 1] !== 0) throw new Error('斗鱼弹幕帧缺少结束符');
      const body = pending.toString('utf8', cursor + 12, end - 1);
      if (body.startsWith('type@=loginres/') || body.startsWith('type@=chatmsg/')) ready();
      if (body.startsWith('type@=chatmsg/')) {
        const text = /(?:^|\/)txt@=([^/]*)/.exec(body)?.[1];
        if (text) messages.push(text.replace(/@[AS]/g, escape => escape === '@A' ? '@' : '/'));
      }
      cursor = end;
    }
    pending = cursor === pending.length ? Buffer.alloc(0) : pending.subarray(cursor);
    return messages;
  };
}

export const douyuDanmakuAdapter: DanmakuAdapter = {
  platform: 'douyu',
  async *collect(roomUrl, _cookie, signal, onConnected) {
    const id = numericRoomId(parseChineseRoomLink('douyu', roomUrl));
    if (!id) throw new Error('斗鱼弹幕房间号无效');
    const decode = createDouyuDanmakuDecoder();
    yield* socketTextStream('wss://danmuproxy.douyu.com:8501/', sameSiteHeaders('douyu', id), signal, {
      open(ws) {
        ws.send(packet(`type@=loginreq/roomid@=${id}/`));
        ws.send(packet(`type@=joingroup/rid@=${id}/gid@=-9999/`));
      },
      frame(data, _ws, ready) { return decode(data, ready); },
      heartbeat(ws) { ws.send(packet('type@=mrkl/')); },
    }, onConnected);
  },
};
