// 合并抖音接口的重复警告日志
export const DOUYIN_ENTER_LOG_INTERVAL_MS = 10 * 60_000;
export const DOUYIN_ENTER_LOG_MAX_ROOMS = 512;

interface LoggedState {
  shape: string;
  loggedAt: number;
  suppressed: number;
}

export class DouyinEnterLog {
  private readonly rooms = new Map<string, LoggedState>();

  warn(roomId: string, shape: string): void {
    const now = Date.now();
    const previous = this.rooms.get(roomId);
    if (
      previous?.shape === shape &&
      now >= previous.loggedAt &&
      now - previous.loggedAt < DOUYIN_ENTER_LOG_INTERVAL_MS
    ) {
      previous.suppressed += 1;
      return;
    }
    const repeated = previous?.suppressed
      ? ` ${previous.shape === shape ? "suppressed" : "previousSuppressed"}=${previous.suppressed}`
      : "";
    console.warn(shape + repeated);
    if (!previous && this.rooms.size >= DOUYIN_ENTER_LOG_MAX_ROOMS) {
      this.rooms.delete(this.rooms.keys().next().value!);
    }
    this.rooms.set(roomId, { shape, loggedAt: now, suppressed: 0 });
  }

  recovered(roomId: string): void {
    const previous = this.rooms.get(roomId);
    if (!previous) return;
    console.log(
      `[douyin-enter] room=${roomId} recovered suppressed=${previous.suppressed}`,
    );
    this.rooms.delete(roomId);
  }
}
