import type mpegts from "mpegts.js";
import { PreviewWebSocketLoader } from "./previewWebSocketLoader";
import type { Platform } from "../../types/room";

/** 平滑观看优先：保留网络抖动余量，通过轻微加速追赶，不反复 seek 到缓冲尾部。 */
export function livePreviewConfig(thumbnail: boolean, onOrigin?: (milliseconds: number) => void, platform?: Platform, onProgress?: (stage: string) => void): mpegts.Config {
  return {
    customLoader: onOrigin || onProgress
      ? class extends PreviewWebSocketLoader { constructor() { super(undefined, undefined, onOrigin, onProgress); } }
      : PreviewWebSocketLoader,
    // The YouTube server already sends a complete bootstrap/GOP. A byte-count
    // stash here can hold its first decodable frame until the next HLS burst.
    // MSE retains the playback jitter buffer and the parser keeps partial tags.
    enableStashBuffer: platform !== "youtube",
    stashInitialSize: 128 * 1024,
    liveBufferLatencyChasing: false,
    liveSync: true,
    liveSyncMaxLatency: 4,
    liveSyncTargetLatency: 2,
    liveSyncPlaybackRate: 1.05,
    // Custom loaders contain functions and cannot be cloned into mpegts' worker.
    enableWorker: false,
    fixAudioTimestampGap: false,
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: thumbnail ? 10 : 30,
    autoCleanupMinBackwardDuration: thumbnail ? 5 : 15,
  };
}
