import { readLiveDanmaku, subscribeLiveDanmaku, unsubscribeLiveDanmaku, type LiveDanmakuSnapshot } from './danmaku';
import { ApiError } from '../types/error';

/** Own the lease, sequential incremental requests, recovery and cancellation in one place. */
export function createLiveDanmakuSession(
  roomId: string,
  onSnapshot: (snapshot: LiveDanmakuSnapshot) => void,
  onFailure: () => void,
  includeMessages: () => boolean = () => true,
  onLease?: (token: string, generation: string) => void,
): () => void {
  const token = crypto.randomUUID();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let subscribed = false, cursor = 0, failures = 0;
  const poll = async () => {
    try {
      const data = subscribed
        ? await readLiveDanmaku(roomId, token, cursor, controller.signal, includeMessages())
        : await subscribeLiveDanmaku(roomId, token, controller.signal, includeMessages());
      if (controller.signal.aborted) return;
      subscribed = true; failures = 0; cursor = data.cursor;
      onLease?.(token, data.generation);
      onSnapshot(data);
    } catch (error) {
      if (controller.signal.aborted) return;
      failures++;
      if (error instanceof ApiError && error.code === 'RESOURCE_NOT_FOUND') subscribed = false;
      onFailure();
    }
    if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, Math.min(5000, 1000 * Math.max(1, failures)));
  };
  void poll();
  return () => {
    if (controller.signal.aborted) return;
    controller.abort(); clearTimeout(timer);
    void unsubscribeLiveDanmaku(roomId, token).catch(() => undefined);
  };
}
