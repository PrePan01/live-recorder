/** 弹幕数据契约（与后端 GET /api/v1/recordings/:id/danmaku 对齐）。 */
export interface DanmakuMessage {
  id: string;
  /** 媒体时间（毫秒），与播放时间轴同源。 */
  tMs: number;
  text: string;
  /** 显示属性预留（颜色/字号等），首版可为空对象。 */
  attrs?: Record<string, unknown>;
  /** 无法可靠映射到媒体时间的消息：照存进列表，不参与飘屏叠加。 */
  unmappable?: boolean;
}

export interface DanmakuGap {
  fromMs: number;
  toMs: number;
  reason?: string;
}

export type DanmakuState =
  | 'connecting'
  | 'collecting'
  | 'reconnecting'
  | 'unavailable';

export interface DanmakuStatus {
  recordingId: string;
  state: DanmakuState;
  since: string;
}
