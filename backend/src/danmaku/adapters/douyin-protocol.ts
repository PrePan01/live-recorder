import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

// PushFrame/Response/Message/ChatMessage wire fields; unknown fields are skipped.
// Reference: https://github.com/opedium/douyin-live-proto/blob/master/docs/complete_payload_reference.md
export function fields(buffer: Buffer): Map<number, (Buffer | bigint)[]> {
  const out = new Map<number, (Buffer | bigint)[]>();
  let offset = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= buffer.length) throw new Error('Truncated protobuf varint');
      const byte = buffer[offset++]!;
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid protobuf varint');
  };
  while (offset < buffer.length) {
    const key = Number(varint()), field = Math.floor(key / 8), wire = key % 8;
    if (!Number.isSafeInteger(key) || field < 1) throw new Error('Invalid protobuf key');
    let value: Buffer | bigint | undefined;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const length = Number(varint());
      if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - offset) throw new Error('Truncated protobuf field');
      value = buffer.subarray(offset, offset + length); offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > buffer.length) throw new Error('Truncated protobuf field');
    } else throw new Error('Unsupported protobuf wire type');
    if (value !== undefined) { const values = out.get(field) ?? []; values.push(value); out.set(field, values); }
  }
  return out;
}
function bytes(map: Map<number, (Buffer | bigint)[]>, key: number): Buffer | undefined {
  const value = map.get(key)?.[0]; return Buffer.isBuffer(value) ? value : undefined;
}
function varint(value: bigint): Buffer {
  const data: number[] = [];
  do { const byte = Number(value & 127n); value >>= 7n; data.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(data);
}
function byteField(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint(BigInt(field * 8 + 2)), varint(BigInt(value.length)), value]);
}
export function heartbeatFrame(): Buffer { return byteField(7, Buffer.from('hb')); }
function chatMessages(response: Map<number, (Buffer | bigint)[]>): { id: string; text: string }[] {
  const messages: { id: string; text: string }[] = [];
  for (const raw of response.get(1) ?? []) {
    if (!Buffer.isBuffer(raw)) continue;
    const message = fields(raw);
    if (bytes(message, 1)?.toString() !== 'WebcastChatMessage') continue;
    const body = bytes(message, 2);
    if (!body) continue;
    const content = bytes(fields(body), 3)?.toString('utf8');
    if (content && Buffer.byteLength(content) <= 16000) {
      const id = message.get(3)?.[0];
      messages.push({ id: typeof id === 'bigint' && id > 0n ? String(id) : createHash('sha256').update(body).digest('hex'), text: content });
    }
  }
  return messages;
}
export function parsePushFrame(buffer: Buffer): { texts: string[]; ack: Buffer | null } {
  const frame = fields(buffer), payload = bytes(frame, 8);
  if (!payload) return { texts: [], ack: null };
  const encoding = bytes(frame, 6)?.toString();
  const compressed = encoding === 'gzip' || (payload[0] === 0x1f && payload[1] === 0x8b);
  const response = fields(compressed ? gunzipSync(payload, { maxOutputLength: 4 * 1024 * 1024 }) : payload);
  const texts = chatMessages(response).map(message => message.text);
  let ack: Buffer | null = null;
  if (response.get(9)?.[0] === 1n) {
    const logId = frame.get(2)?.[0];
    ack = Buffer.concat([
      ...(typeof logId === 'bigint' ? [Buffer.from([16]), varint(logId)] : []),
      byteField(7, Buffer.from('ack')), byteField(8, bytes(response, 5) ?? Buffer.alloc(0)),
    ]);
  }
  return { texts, ack };
}

/** HTTP fetch and websocket payloads share the same Response/ChatMessage schema. */
export function parseFetchResponse(buffer: Buffer) {
  const response = fields(buffer[0] === 0x1f && buffer[1] === 0x8b
    ? gunzipSync(buffer, { maxOutputLength: 4 * 1024 * 1024 }) : buffer);
  const cursor = bytes(response, 2)?.toString() ?? '';
  const internalExt = bytes(response, 5)?.toString() ?? '';
  if (!cursor || cursor.length > 4096 || internalExt.length > 16384) throw new Error('抖音弹幕响应缺少有效游标');
  const interval = response.get(3)?.[0];
  return {
    messages: chatMessages(response), cursor, internalExt,
    intervalMs: typeof interval === 'bigint' ? Math.max(1000, Math.min(10000, Number(interval))) : 1000,
  };
}
