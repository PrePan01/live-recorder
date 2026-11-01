import { expect, it } from 'vitest';
import { isFlvSequenceHeader, isFlvVideoKeyframe } from '../../src/recorder/flv-tags.js';
import { FlvTimestampNormalizer, type FlvTagInfo } from '../../src/recorder/stream-recorder.js';

const header = Buffer.from([70, 76, 86, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);
function tag(payload: Buffer, timestamp = 0, type = 9) {
  const value = Buffer.alloc(payload.length + 15);
  value[0] = type;
  value.writeUIntBE(payload.length, 1, 3);
  value.writeUIntBE(timestamp, 4, 3);
  payload.copy(value, 11);
  value.writeUInt32BE(payload.length + 11, payload.length + 11);
  return value;
}

it.each([7, 12])('legacy codec %s distinguishes configuration, media and sequence end', codec => {
  expect(isFlvSequenceHeader(tag(Buffer.from([0x10 | codec, 0])))).toBe(true);
  expect(isFlvVideoKeyframe(tag(Buffer.from([0x10 | codec, 0])))).toBe(false);
  expect(isFlvVideoKeyframe(tag(Buffer.from([0x10 | codec, 1])))).toBe(true);
  expect(isFlvVideoKeyframe(tag(Buffer.from([0x10 | codec, 2])))).toBe(false);
  expect(isFlvVideoKeyframe(tag(Buffer.from([0x20 | codec, 1])))).toBe(false);
});

it('does not read an empty tag payload from PreviousTagSize or the next tag', () => {
  expect(isFlvVideoKeyframe(tag(Buffer.alloc(0)))).toBe(false);
  expect(isFlvSequenceHeader(tag(Buffer.from([0xaf]), 0, 8))).toBe(false);
  expect(isFlvSequenceHeader(tag(Buffer.from([0x90])))).toBe(false);
});

it.each(['hvc1', 'av01', 'vp09'])('indexes enhanced %s configuration and keyframes without treating sequence end as media', codec => {
  const payload = (first: number) => Buffer.concat([Buffer.from([first]), Buffer.from(codec), Buffer.alloc(4)]);
  const seq = tag(payload(0x90));
  const end = tag(payload(0x92), 100000);
  const delta = tag(payload(0xa1), 100020);
  const key = tag(payload(0x93), 100040);
  const next = tag(payload(0xa1), 100080);
  const noted: FlvTagInfo[] = [];
  const normalizer = new FlvTimestampNormalizer({ rebaseFromFirstMedia: true, requireKeyframe: true, onTag: info => noted.push(info) });
  const input = Buffer.concat([header, seq, end, delta, key, next]);
  const parts: Buffer[] = [];
  for (let i = 0; i < input.length; i += 3) parts.push(...normalizer.push(input.subarray(i, i + 3)));
  expect(noted.map(info => [info.seqHeader, info.keyframe, info.ts])).toEqual([[true, false, 0], [false, true, 0]]);
  expect(noted.map(info => info.fileOffset)).toEqual([header.length, header.length + seq.length]);
  expect(Buffer.concat(parts).length).toBe(header.length + seq.length + key.length + next.length);
  expect(normalizer.lastTimestampMs).toBe(40);
});
