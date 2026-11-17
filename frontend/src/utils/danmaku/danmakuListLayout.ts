export const DANMAKU_LIST_MIN_WIDTH = 125;
export const DANMAKU_LIST_MAX_WIDTH = 320;
export const LIVE_DANMAKU_LIST_GAP = 6;
export const REPLAY_DANMAKU_LIST_GAP = 12;
export const DANMAKU_LIST_WINDOW_GUTTER = 16;

export function danmakuListReservedWidth(centerPlayer: boolean, gap: number): number {
  const panelSpace = DANMAKU_LIST_MIN_WIDTH + gap;
  return (centerPlayer ? 2 * panelSpace : panelSpace) + 2 * DANMAKU_LIST_WINDOW_GUTTER;
}
