/** 最近一秒收到的字节数；同一毫秒的块合并，静默后速度自然归零。 */
export class DownloadSpeed {
  private samples = new Map<number, number>();

  add(bytes: number, now: number): void {
    this.prune(now);
    this.samples.set(now, (this.samples.get(now) ?? 0) + bytes);
  }

  bytesPerSecond(now: number): number {
    this.prune(now);
    let bytes = 0;
    for (const size of this.samples.values()) bytes += size;
    return bytes;
  }

  private prune(now: number): void {
    for (const time of this.samples.keys()) {
      if (now - time >= 1000 || time > now) this.samples.delete(time);
    }
  }
}
