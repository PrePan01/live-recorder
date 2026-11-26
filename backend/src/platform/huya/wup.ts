import { randomInt } from 'node:crypto';
import { protocolChanged, responseBytes, sameSiteHeaders, webRequest } from '../chinese-live/adapter.js';
import { type TarsValue, readTars, tarsBytes, tarsInt, tarsMap, tarsString, tarsStruct } from './tars.js';

export async function fetchHuyaCdnToken(
  fetcher: typeof fetch, room: string, baseUrl: string, streamName: string, uid: string, cookie?: string,
): Promise<string> {
  const identity = tarsStruct(3, tarsInt(0, BigInt(uid)), tarsString(3, 'webh5&0.1.0&websocket'), tarsString(4, cookie ?? ''));
  const request = tarsStruct(0, tarsString(0, baseUrl), tarsString(1, streamName), tarsInt(2, 0), identity, tarsInt(4, 66));
  const attributes = tarsMap(0, [[tarsString(0, 'tReq'), tarsBytes(1, request)]]);
  const payload = Buffer.concat([
    tarsInt(1, 3), tarsInt(2, 0), tarsInt(3, 0), tarsInt(4, randomInt(1, 1_000_000)),
    tarsString(5, 'liveui'), tarsString(6, 'getCdnTokenInfoEx'), tarsBytes(7, attributes),
    tarsInt(8, 5000), tarsMap(9, []), tarsMap(10, []),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length + 4);
  const response = await webRequest(fetcher, '虎牙播放令牌', 'https://wup.huya.com/', {
    method: 'POST',
    headers: { ...sameSiteHeaders('huya', room, cookie), 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(Buffer.concat([length, payload])),
  });
  const packet = await responseBytes(response, '虎牙播放令牌', 128 * 1024);
  try {
    if (packet.readUInt32BE() !== packet.length) throw new Error('长度不符');
    const attributeBytes = readTars(packet.subarray(4)).get(7);
    if (!Buffer.isBuffer(attributeBytes)) throw new Error('缺少属性');
    const entries = readTars(attributeBytes).get(0);
    const attributesMap: Map<TarsValue, TarsValue> | undefined = entries instanceof Map ? entries : undefined;
    const tokenBytes = attributesMap?.get('tRsp') ?? attributesMap?.get('');
    if (!Buffer.isBuffer(tokenBytes)) throw new Error('缺少令牌');
    const decoded = readTars(tokenBytes);
    const root = decoded.get(0);
    const token = root instanceof Map ? root.get(0) : root;
    if (typeof token === 'string' && token.length) return token;
  } catch { /* Invalid upstream packet. */ }
  throw protocolChanged('虎牙播放令牌');
}
