import { fetchDanmaku } from './danmaku';

/** Short playback windows paginate by file offset, including messages sharing a timestamp. */
export async function fetchDanmakuWindow(recordingId: string, fromMs: number, toMs: number, signal: AbortSignal) {
  let cursor: string | undefined;
  let messages: Awaited<ReturnType<typeof fetchDanmaku>>['messages'] = [];
  let latest: Awaited<ReturnType<typeof fetchDanmaku>>;
  const seen = new Set<string>();
  let count = 0;
  do {
    signal.throwIfAborted();
    latest = await fetchDanmaku(recordingId, { fromMs, toMs, limit: 2000, cursor, signal });
    // Sample across the entire window above the rendering budget, rather than discarding
    // an entire early/late part of the timeline. Storage and API still preserve every row.
    for (const message of latest.messages) {
      count++;
      if (messages.length < 20_000) { messages.push(message); continue; }
      let hash = 2166136261;
      for (let i = 0; i < message.id.length; i++) hash = Math.imul(hash ^ message.id.charCodeAt(i), 16777619);
      const slot = (hash >>> 0) % count;
      if (slot < messages.length) messages[slot] = message;
    }
    const next = latest.next ?? undefined;
    if (next && (next === cursor || seen.has(next))) throw new Error('Invalid danmaku cursor');
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
  messages.sort((a, b) => (a.tMs ?? Infinity) - (b.tMs ?? Infinity) || a.id.localeCompare(b.id));
  return { ...latest, messages };
}
