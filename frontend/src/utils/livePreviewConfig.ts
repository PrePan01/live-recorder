import type mpegts from 'mpegts.js';

/** 平滑观看优先：保留网络抖动余量，通过轻微加速追赶，不反复 seek 到缓冲尾部。 */
export function livePreviewConfig(thumbnail: boolean): mpegts.Config {
  return {
    enableStashBuffer: true,
    stashInitialSize: 128 * 1024,
    liveBufferLatencyChasing: false,
    liveSync: true,
    liveSyncMaxLatency: 4,
    liveSyncTargetLatency: 2,
    liveSyncPlaybackRate: 1.05,
    enableWorker: !thumbnail,
    fixAudioTimestampGap: false,
    autoCleanupSourceBuffer: true,
    autoCleanupMaxBackwardDuration: thumbnail ? 10 : 30,
    autoCleanupMinBackwardDuration: thumbnail ? 5 : 15,
  };
}
