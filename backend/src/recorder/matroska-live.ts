/** Minimal bounded EBML framing, used to start a decoder at a complete Cluster.
 * Payload bytes are never searched for magic values (encoded frames may contain them).
 */
function vint(
  data: Buffer,
  offset: number,
  id = false,
): { value: number; bytes: number; unknown: boolean } | null {
  const first = data[offset];
  if (first === undefined) return null;
  let bytes = 1,
    mask = 0x80;
  while (bytes <= 8 && !(first & mask)) {
    bytes++;
    mask >>= 1;
  }
  if (bytes > (id ? 4 : 8)) throw new Error("Invalid EBML header");
  if (offset + bytes > data.length) return null;
  let value = id ? first : first & (mask - 1);
  let unknown = !id && value === mask - 1;
  for (let i = 1; i < bytes; i++) {
    value = value * 256 + data[offset + i]!;
    unknown &&= data[offset + i] === 255;
  }
  return { value, bytes, unknown };
}

export class MatroskaLiveParser {
  private storage = Buffer.allocUnsafe(64 * 1024);
  private pending = this.storage.subarray(0, 0);
  private prefix: Buffer[] = [];
  private segment = false;
  private started = false;
  private scale = 1;
  header: Buffer | null = null;
  lastCluster: Buffer | null = null;
  timestampMs = 0;
  clusterStartMs = 0;
  videoCodec = "";
  audioCodec = "";
  width = 0;
  height = 0;
  private videoTrack = 0;
  private recordingClusters: Buffer[] = [];
  private recordingBytes = 0;
  recordingStartMs = 0;
  constructor(private readonly retainRecordingBootstrap = false) {}
  recordingBootstrap(): Buffer | null {
    return this.header && this.recordingClusters.length
      ? Buffer.concat([this.header, ...this.recordingClusters]) : null;
  }
  /** Change only the container clock; encoded audio/video packet bytes stay intact. */
  rebaseCluster(cluster: Buffer, originMs: number): Buffer {
    const id = vint(cluster, 0, true), size = id && vint(cluster, id.bytes);
    if (!id || id.value !== 0x1f43b675 || !size) throw new Error('Invalid Matroska cluster');
    const result = Buffer.from(cluster);
    for (let pos = id.bytes + size.bytes; pos < result.length;) {
      const child = vint(result, pos, true), length = child && vint(result, pos + child.bytes);
      if (!child || !length || length.unknown) break;
      const at = pos + child.bytes + length.bytes;
      if (at + length.value > result.length) break;
      if (child.value === 0xe7 && length.value > 0 && length.value <= 6) {
        const time = result.readUIntBE(at, length.value) - Math.round(originMs / this.scale);
        if (time < 0) throw new Error('Matroska cluster precedes recording origin');
        result.writeUIntBE(time, at, length.value);
        return result;
      }
      pos = at + length.value;
    }
    throw new Error('Matroska cluster clock missing');
  }
  get canCopyToFlv(): boolean {
    return (
      this.videoCodec === "V_MPEG4/ISO/AVC" &&
      (!this.audioCodec || this.audioCodec === "A_AAC") &&
      this.width > 0 &&
      this.width <= 1920 &&
      this.height <= 1080
    );
  }

  private readTracks(data: Buffer): void {
    for (let pos = 0; pos < data.length;) {
      const id = vint(data, pos, true);
      if (!id) break;
      const size = vint(data, pos + id.bytes);
      if (!size || size.unknown) break;
      const at = pos + id.bytes + size.bytes;
      if (at + size.value > data.length) break;
      const value = data.subarray(at, at + size.value);
      if (id.value === 0xae) {
        let number = 0, type = 0;
        for (let i = 0; i < value.length;) {
          const field = vint(value, i, true); if (!field) break;
          const length = vint(value, i + field.bytes); if (!length || length.unknown) break;
          const start = i + field.bytes + length.bytes;
          if (start + length.value > value.length) break;
          if (length.value > 0 && length.value <= 4) {
            if (field.value === 0xd7) number = value.readUIntBE(start, length.value);
            if (field.value === 0x83) type = value.readUIntBE(start, length.value);
          }
          i = start + length.value;
        }
        if (type === 1) this.videoTrack = number;
        this.readTracks(value);
      }
      if (id.value === 0xe0) this.readTracks(value);
      if (id.value === 0x86) {
        const codec = value.toString();
        if (codec.startsWith("V_")) this.videoCodec = codec;
        if (codec.startsWith("A_")) this.audioCodec = codec;
      }
      if (id.value === 0xb0 && value.length > 0 && value.length <= 4)
        this.width = value.readUIntBE(0, value.length);
      if (id.value === 0xba && value.length > 0 && value.length <= 4)
        this.height = value.readUIntBE(0, value.length);
      pos = at + size.value;
    }
  }

  push(chunk: Buffer): Buffer[] {
    const length = this.pending.length + chunk.length;
    if (length > 16 * 1024 * 1024)
      throw new Error("Matroska element exceeds buffer limit");
    if (length > this.storage.length) {
      const grown = Buffer.allocUnsafe(
        Math.min(16 * 1024 * 1024, Math.max(length, this.storage.length * 2)),
      );
      this.pending.copy(grown);
      this.storage = grown;
    }
    chunk.copy(this.storage, this.pending.length);
    this.pending = this.storage.subarray(0, length);
    const clusters: Buffer[] = [];
    let offset = 0;
    while (offset < this.pending.length) {
      const id = vint(this.pending, offset, true);
      if (!id) break;
      const size = vint(this.pending, offset + id.bytes);
      if (!size) break;
      const headerLength = id.bytes + size.bytes;
      if (id.value === 0x18538067 && !this.segment) {
        this.prefix.push(
          Buffer.from(this.pending.subarray(offset, offset + headerLength)),
        );
        this.segment = true;
        offset += headerLength;
        continue;
      }
      if (
        size.unknown ||
        !Number.isSafeInteger(size.value) ||
        size.value > 16 * 1024 * 1024
      )
        throw new Error("Unsupported Matroska element size");
      const end = offset + headerLength + size.value;
      if (end > this.pending.length) break;
      const element = Buffer.from(this.pending.subarray(offset, end));
      if (id.value === 0x1f43b675) {
        if (!this.header) this.header = Buffer.concat(this.prefix);
        this.started = true;
        const payload = element.subarray(headerLength);
        let clusterTime = 0;
        let firstVideoKeyframe: boolean | undefined;
        for (let pos = 0; pos < payload.length;) {
          const child = vint(payload, pos, true);
          if (!child) break;
          const len = vint(payload, pos + child.bytes);
          if (!len || len.unknown) break;
          const at = pos + child.bytes + len.bytes;
          if (at + len.value > payload.length) break;
          if (child.value === 0xe7 && len.value > 0 && len.value <= 6)
            clusterTime = payload.readUIntBE(at, len.value) * this.scale;
          if (child.value === 0xa3) {
            const track = vint(payload, at);
            if (track && track.value === this.videoTrack && len.value >= track.bytes + 3 && firstVideoKeyframe === undefined)
              firstVideoKeyframe = Boolean(payload[at + track.bytes + 2]! & 0x80);
            if (track && len.value >= track.bytes + 3)
              this.timestampMs = Math.max(
                this.timestampMs,
                clusterTime +
                  payload.readInt16BE(at + track.bytes) * this.scale,
              );
          }
          this.timestampMs = Math.max(this.timestampMs, clusterTime);
          pos = at + len.value;
        }
        this.clusterStartMs = clusterTime;
        this.lastCluster = element;
        if (this.retainRecordingBootstrap) {
          if (firstVideoKeyframe) {
            this.recordingClusters = [];
            this.recordingBytes = 0;
            this.recordingStartMs = clusterTime;
          }
          if (firstVideoKeyframe || this.recordingClusters.length) {
            this.recordingBytes += element.length;
            if (this.recordingBytes + (this.header?.length ?? 0) <= 8 * 1024 * 1024)
              this.recordingClusters.push(element);
            else { this.recordingClusters = []; this.recordingBytes = 0; }
          }
        }
        clusters.push(element);
      } else if (!this.started) {
        this.prefix.push(element);
        if (this.prefix.reduce((sum, b) => sum + b.length, 0) > 1024 * 1024)
          throw new Error("Matroska initialization exceeds buffer limit");
        if (id.value === 0x1654ae6b)
          this.readTracks(element.subarray(headerLength));
        if (id.value === 0x1549a966) {
          const payload = element.subarray(headerLength);
          for (let pos = 0; pos < payload.length;) {
            const child = vint(payload, pos, true);
            if (!child) break;
            const len = vint(payload, pos + child.bytes);
            if (!len || len.unknown) break;
            const at = pos + child.bytes + len.bytes;
            if (at + len.value > payload.length) break;
            if (child.value === 0x2ad7b1 && len.value > 0 && len.value <= 6)
              this.scale = payload.readUIntBE(at, len.value) / 1_000_000;
            pos = at + len.value;
          }
        }
      }
      offset = end;
    }
    this.pending.copy(this.storage, 0, offset);
    this.pending = this.storage.subarray(0, this.pending.length - offset);
    return clusters;
  }
}
