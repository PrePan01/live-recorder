import { describe, expect, it, vi } from "vitest";
import { FlvMediaOriginReader, readLiveMediaSecond, readPreviewElapsed, resetPreviewMediaClock, setLiveMediaOrigin } from "./previewMediaClock";

function tag(type: number, timestamp: number, payload: number[]) {
  const bytes = new Uint8Array(11 + payload.length + 4);
  bytes[0] = type;
  bytes[3] = payload.length;
  bytes[4] = timestamp >>> 16;
  bytes[5] = timestamp >>> 8;
  bytes[6] = timestamp;
  bytes[7] = timestamp >>> 24;
  bytes.set(payload, 11);
  new DataView(bytes.buffer).setUint32(bytes.length - 4, 11 + payload.length);
  return bytes;
}
function stream(...tags: Uint8Array[]) {
  const parts = [new Uint8Array([70, 76, 86, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]), ...tags];
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
describe("preview media clock", () => {
  it.each([1, 7, 13, 128])("captures late-join DTS across %i-byte chunks, excluding codec headers", size => {
    const report = vi.fn();
    const reader = new FlvMediaOriginReader(report);
    const bytes = stream(tag(18, 0, []), tag(9, 0, [0x17, 0]), tag(8, 0, [0xaf, 0]),
      tag(9, 45000, [0x17, 1, 0, 0, 0]), tag(8, 44980, [0xaf, 1]), tag(9, 48000, [0x27, 1]));
    for (let i = 0; i < bytes.length; i += size) reader.push(bytes.slice(i, i + size).buffer);
    expect(report).toHaveBeenLastCalledWith(44980);
    expect(report).toHaveBeenCalledTimes(2);
  });
  it("uses the presented frame rather than the buffered tail and clears old origins on reconnect", () => {
    const video = { currentTime: 10, buffered: { length: 1, end: () => 12 } } as unknown as HTMLVideoElement;
    setLiveMediaOrigin(video, 45000);
    expect(readLiveMediaSecond(video)).toBe(55);
    video.currentTime = 10.25;
    expect(readLiveMediaSecond(video)).toBe(55.25);
    resetPreviewMediaClock(video);
    expect(readLiveMediaSecond(video)).toBeUndefined();
    setLiveMediaOrigin(video, 100000);
    expect(readLiveMediaSecond(video)).toBe(110.25);
  });
  it("keeps a seek source origin when cleanup advances buffered.start", () => {
    let start = 0.08;
    const video = { currentTime: 10.08, readyState: 2, buffered: { length: 1, start: () => start } } as unknown as HTMLVideoElement;
    expect(readPreviewElapsed(video)).toBeCloseTo(10);
    start = 8;
    video.currentTime = 12.08;
    expect(readPreviewElapsed(video)).toBeCloseTo(12);
    resetPreviewMediaClock(video);
    video.currentTime = 8.5;
    expect(readPreviewElapsed(video)).toBeCloseTo(0.5);
  });
});
