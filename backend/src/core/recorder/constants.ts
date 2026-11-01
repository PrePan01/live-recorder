// 集中保存录制、重连、预览和导出使用的时限与并发上限。
/** 录制完成询问是否保留待确认超时。 */
export const KEEP_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

/** 精彩时刻导出持续有 I/O 进度就允许继续；仅持续无进度才判定卡死。 */
export const HIGHLIGHT_EXPORT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

export const HIGHLIGHT_EXPORT_WATCHDOG_REFRESH_MS = 1_000;

/**
 * 失败自动恢复录制尝试次数
 */
export const WRITE_RESTART_ATTEMPTS = 3;

/** 开录后多久还没写出文件即视为拿不到数据 */
export const START_TIMEOUT_MS = 30_000;

/** 复用前体检阈值：预览上游静默超过此时长即判陈旧、拆旧回退现解析。 */
export const PREVIEW_FRESHNESS_MS = 30_000;

/** 所有真实缺口均保存证据，不再隐藏不足 30 秒的中断。 */
export const GAP_ROW_MIN_MS = 0;

/** 取流失败持续告警阈值：超过此时长仍重连中即发人话告警（持续重试不停录）。 */
export const RECONNECT_ALERT_AFTER_MS = 5 * 60_000;

/** 断流重连快速退避链（秒）：判定即首试零等待，其后 1-2-5-10-30 封顶——宁可误判几次也不干等丢内容。 */
export const RECONNECT_CHAIN_SEC = [0, 1, 2, 5, 10, 30];

/** Preview has no recording-level start watchdog; recycle a source that never yields its first byte. */
export const PREVIEW_START_TIMEOUT_MS = 10_000;

/** 恢复后稳定录满这么久，就归还重连额度——几小时前的旧故障不该拖累现在这一次抖动。 */
export const STABLE_RESET_MS = 60_000;

/** 退出前等写流落盘的上限 */
export const SHUTDOWN_GRACE_MS = 3_000;

/** 收尾时最后一份数据到现在超时时长 */
export const TAIL_SILENCE_MIN_MS = 5_000;

/** 同时进行的片段导出全局上限：防用户连点造成同文件多路读/CPU 风暴（正常并行不受影响）。 */
export const MAX_PARALLEL_CLIP_EXPORTS = 6;
