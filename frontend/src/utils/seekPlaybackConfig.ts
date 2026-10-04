/** 回看使用 Worker 解封装；限制前后缓冲，避免为媒体时间戳缺口生成无界静音帧。 */
export const seekPlaybackConfig = {
  enableStashBuffer: false,
  accurateSeek: true,
  enableWorker: true,
  fixAudioTimestampGap: false,
  autoCleanupSourceBuffer: true,
  autoCleanupMaxBackwardDuration: 60,
  autoCleanupMinBackwardDuration: 30,
  lazyLoadMaxDuration: 180,
};
