import type { DanmakuMessage } from '../types/danmaku';
/** Match the server's bounded live history; a paused player must not accumulate forever. */
export function mergeLiveDanmakuWindow(previous: DanmakuMessage[], incoming: DanmakuMessage[], mediaNowMs: number): DanmakuMessage[] {
  const oldest = mediaNowMs - 30000;
  const ids = new Set<string>();
  const result: DanmakuMessage[] = [];
  for (const message of [...previous, ...incoming]) {
    if (message.tMs == null || message.unmappable || message.tMs < oldest || ids.has(message.id)) continue;
    ids.add(message.id); result.push(message);
  }
  const bounded = result.slice(-2000);
  return bounded.length === previous.length && bounded.every((message, i) => message === previous[i]) ? previous : bounded;
}
