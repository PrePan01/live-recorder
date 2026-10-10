import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { PreviewManager, PREVIEW_TAIL_MAX } from '../../src/api/websocket.js';
import type { Services } from '../../src/core/services.js';

const header = Buffer.from([70, 76, 86, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);
function tag(type: number, payload: Buffer, ts = 0): Buffer {
  const head = Buffer.alloc(11);
  head[0] = type;
  head.writeUIntBE(payload.length, 1, 3);
  head.writeUIntBE(ts & 0xffffff, 4, 3);
  head[7] = ts >>> 24;
  const prev = Buffer.alloc(4);
  prev.writeUInt32BE(11 + payload.length);
  return Buffer.concat([head, payload, prev]);
}
const videoConfig = (level: number, ts = 0) => tag(9, Buffer.from([0x17, 0, 0, 0, 0, 1, 100, 0, level]), ts);
const audioConfig = (value = 1) => tag(8, Buffer.from([0xaf, 0, value, 0]));
function frame(key = true, size = 64): Buffer {
  const payload = Buffer.alloc(size);
  payload[0] = key ? 0x17 : 0x27;
  payload[1] = 1;
  return tag(9, payload);
}
const init = () => Buffer.concat([header, tag(18, Buffer.alloc(4)), videoConfig(42), audioConfig()]);
function socket() {
  const sent: Buffer[] = [];
  const closes: number[] = [];
  const ws = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    bufferedAmount: 0,
    send(value: Buffer) { sent.push(Buffer.from(value)); },
    close(code: number) { closes.push(code); ws.readyState = WebSocket.CLOSING; },
  });
  return { ws: ws as unknown as WebSocket, sent, closes };
}
function manager(max = 4) { return new PreviewManager({} as Services, max); }

describe('preview initialization across source changes', () => {
  it('uses the current AVC configuration after it rolls out of the tail', () => {
    const preview = manager();
    preview.broadcastFrame('r', init());
    const existing = socket(); preview.addClient('r', existing.ws);
    preview.broadcastFrame('r', videoConfig(50));
    for (let i = 0; i < 5; i++) preview.broadcastFrame('r', frame(true, 281_248));
    const late = socket(); preview.addClient('r', late.ws);
    expect(existing.closes).toEqual([1012]);
    expect(late.sent[0]!.includes(videoConfig(50))).toBe(true);
    expect(late.sent[0]!.includes(videoConfig(42))).toBe(false);
    expect(late.sent[1]).toEqual(frame(true, 281_248));
    expect(preview.recordingBootstrap('r')!.includes(videoConfig(50))).toBe(true);
  });

  it('does not reconnect for the same configuration with another timestamp', () => {
    const preview = manager(); preview.broadcastFrame('r', init());
    const client = socket(); preview.addClient('r', client.ws);
    preview.broadcastFrame('r', frame());
    preview.broadcastFrame('r', videoConfig(42, 5000));
    expect(client.closes).toEqual([]);
    const late = socket(); preview.addClient('r', late.ws);
    expect(late.sent[1]).toEqual(frame());
  });

  it('refreshes AAC independently and discards frames from the old configuration', () => {
    const preview = manager(); preview.broadcastFrame('r', init());
    preview.broadcastFrame('r', frame());
    const client = socket(); preview.addClient('r', client.ws);
    preview.broadcastFrame('r', audioConfig(2));
    preview.broadcastFrame('r', frame(false));
    const late = socket(); preview.addClient('r', late.ws);
    expect(client.closes).toEqual([1012]);
    expect(late.sent).toHaveLength(1);
    expect(late.sent[0]!.includes(audioConfig(2))).toBe(true);
    expect(late.sent[0]!.includes(audioConfig(1))).toBe(false);
    expect(preview.recordingBootstrap('r')!.includes(audioConfig(2))).toBe(true);
    expect(preview.recordingBootstrap('r')!.includes(audioConfig(1))).toBe(false);
    preview.broadcastFrame('r', frame());
    expect(preview.recordingBootstrap('r')!.includes(frame())).toBe(true);
  });

  it('handles fragmented and combined tags and starts replay from a keyframe', () => {
    const preview = manager(); preview.broadcastFrame('r', init());
    const combined = Buffer.concat([videoConfig(50), frame(false), frame(), frame(false)]);
    for (let i = 0; i < combined.length; i += 7) preview.broadcastFrame('r', combined.subarray(i, i + 7));
    const late = socket(); preview.addClient('r', late.ws);
    expect(late.sent[0]!.includes(videoConfig(50))).toBe(true);
    expect(late.sent[1]).toEqual(Buffer.concat([frame(), frame(false)]));
  });

  it('does not replay early audio media in the initialization segment', () => {
    const preview = manager();
    const oldAudio = tag(8, Buffer.from([0xaf, 1, 99]), 40);
    const stream = Buffer.concat([header, audioConfig(), oldAudio, videoConfig(42), frame()]);
    for (let i = 0; i < stream.length; i += 5) preview.broadcastFrame('r', stream.subarray(i, i + 5));
    const late = socket(); preview.addClient('r', late.ws);
    expect(late.sent[0]).toEqual(Buffer.concat([header, audioConfig(), videoConfig(42)]));
    expect(late.sent[0]!.includes(oldAudio)).toBe(false);
    expect(late.sent[1]).toEqual(frame());
  });

  it('replays a high bitrate GOP larger than the old 1 MB limit without waiting for another keyframe', () => {
    const preview = manager();
    const gop = Buffer.concat([frame(), frame(false, 1_100_000), frame(false, 1_100_000)]);
    preview.broadcastFrame('r', Buffer.concat([init(), gop]));
    const late = socket(); preview.addClient('r', late.ws);
    expect(late.sent).toEqual([init(), gop]);
  });

  it('replays the partial tag prefix when joining between network chunks', () => {
    const preview = manager();
    const key = frame();
    const next = frame(false);
    preview.broadcastFrame('r', Buffer.concat([init(), key, next.subarray(0, 23)]));
    const late = socket(); preview.addClient('r', late.ws);
    preview.broadcastFrame('r', next.subarray(23));
    expect(Buffer.concat(late.sent)).toEqual(Buffer.concat([init(), key, next]));
  });

  it('bounds the first media batch and waits for a keyframe after GOP overflow', () => {
    const preview = manager();
    preview.broadcastFrame('r', Buffer.concat([init(), frame(), frame(false, PREVIEW_TAIL_MAX - 64)]));
    const late = socket(); preview.addClient('r', late.ws);
    expect(late.sent).toHaveLength(1);
    preview.broadcastFrame('r', frame(false));
    const later = socket(); preview.addClient('r', later.ws);
    expect(later.sent).toHaveLength(1);
    preview.broadcastFrame('r', frame());
    const ready = socket(); preview.addClient('r', ready.ws);
    expect(ready.sent[1]).toEqual(frame());
  });

  it('resets connected decoders and provides a complete fresh init after handoff', () => {
    const preview = manager(); preview.broadcastFrame('r', init());
    const existing = socket(); preview.addClient('r', existing.ws);
    preview.resetRoom('r');
    preview.broadcastFrame('r', Buffer.concat([header, videoConfig(50), audioConfig(), frame()]));
    const late = socket(); preview.addClient('r', late.ws);
    expect(existing.closes).toEqual([1012]);
    expect(late.sent[0]!.subarray(0, 3).toString()).toBe('FLV');
    expect(late.sent[0]!.includes(videoConfig(42))).toBe(false);
    expect(late.sent[0]!.includes(videoConfig(50))).toBe(true);
  });
});

describe('preview session accounting', () => {
  it('does not consume viewer slots for recordings with only a warm cache', () => {
    const preview = manager(1);
    for (const room of ['a', 'b', 'c']) preview.broadcastFrame(room, init());
    expect(preview.activeCount).toBe(0);
    expect(preview.canAccept('b')).toBe(true);
    const viewer = socket(); preview.addClient('b', viewer.ws);
    expect(preview.activeCount).toBe(1);
    expect(preview.canAccept('b')).toBe(true);
    expect(preview.canAccept('c')).toBe(false);
    viewer.ws.emit('close');
    expect(preview.canAccept('c')).toBe(true);
    preview.closeAll(1000);
  });
});
