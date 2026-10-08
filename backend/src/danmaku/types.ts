/** 弹幕消息：时间以媒体时间为准（跳播/倍速对齐用）；无法映射媒体时间的消息存墙钟并标记。 */
export interface DanmakuMessage {
  id: string;
  /** 媒体时间毫秒（与播放时间轴同源）；unmappable 时为 null。 */
  tMs: number | null;
  /** 到达时间墙钟毫秒（对账用；unmappable 消息只有此时间）。 */
  wallMs: number;
  text: string;
  /** 显示属性（颜色/字号等），首版可为空对象预留。 */
  attrs?: Record<string, string | number>;
  /** 无法可靠映射到媒体时间：照存但不进时间轴查询、不叠加到画面。 */
  unmappable?: boolean;
}

/** 弹幕缺失区间：采集自身断连时间线（与视频 gap 是两套账，独立计）。 */
export interface DanmakuGap {
  fromMs: number;
  toMs: number;
  reason: string;
}

export type DanmakuState =
  | 'connecting'
  | 'collecting'
  | 'reconnecting'
  | 'unavailable';

export interface DanmakuStatus {
  recordingId: string;
  state: DanmakuState;
  /** 本状态起始时间墙钟毫秒。 */
  since: number;
  reason?: string;
}

/** 平台弹幕采集适配器：只产出消息流，重连/存储/状态由采集管理器统一管。 */
export interface DanmakuAdapter {
  readonly platform: string;
  /** 建立连接并产出消息；连接断开/不可恢复时正常返回（由管理器决定重试）。 */
  collect(
    roomUrl: string,
    cookie: string | null,
    signal: AbortSignal,
    onConnected?: () => void,
  ): AsyncIterable<DanmakuMessage>;
}
