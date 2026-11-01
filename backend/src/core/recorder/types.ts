// 定义录制会话、预览会话及共享写入器的数据结构，供各录制模块使用。
import type { WriteStream } from "node:fs";
import type { BufferedRecordingWriter } from "../../recorder/buffered-writer.js";
import type {
  FlvTagInfo,
  FlvTimestampNormalizer,
} from "../../recorder/stream-recorder.js";
import type { SeekIndexWriter } from "../../storage/seek-index.js";
import type { ErrorObject, RecordingEndReason } from "../../types/index.js";
import type { DownloadSpeed } from "../download-speed.js";
import type { PerformanceTrace } from "../performance-diagnostics.js";
export interface PreviewSink {
  canAccept(): boolean;
  /** 是否仍有客户端观看；共享录制结束后据此决定是否保留预览拉流。 */
  hasClients(roomId: string): boolean;
  broadcastFrame(roomId: string, chunk: Buffer): void;
  reportProgress?(roomId: string, stage: string): void;
  closeRoom(
    roomId: string,
    code: number,
    reason?: "ended" | "stream_lost",
  ): void;
  /** 新录制/新分段开始时清空该房间预览头缓冲，确保下一段流的 FLV 头被重新捕获。 */
  resetRoom(roomId: string): void;
  /** 获取可从关键帧开始写入录制文件的预览数据，不中断已连接的预览客户端。 */
  recordingBootstrap?(roomId: string): Buffer | null;
}

export interface ActiveSession {
  expectedQuality: import("../../types/index.js").Quality;
  downloadSpeed: DownloadSpeed;
  recordingId: string;
  roomId: string;
  streamSessionId: string | null;
  stopRequested: boolean;
  wakeReconnect?: () => void;
  reconnectSince?: number;
  recoveringAlerted?: boolean;
  /** 同一次连续中断内，每种原因只提示一次；取到地址不算恢复。 */
  reconnectAlertCodes?: Set<ErrorObject["code"]>;
  requestedEndReason?: RecordingEndReason;
  size: number;
  startedAt: string;
  /** 当前分段实际使用的引擎；停止时必须作用于这个实例。 */
  engine: import("../../recorder/engine.js").RecordingEngine | null;
  /** 本次录制的文件：中断恢复后接着写它，不再新开文件。 */
  filePath: string | null;
  /** 已写出的分段数；>0 表示本次拉流要追加写入而不是新建。 */
  segments: number;
  /** 续录时间偏移：本段媒体时间戳接在上一段结尾之后，保证拼接处播放连续。 */
  timestampOffsetMs: number;
  /** 已写入录像的媒体位置，用于历史页标注中断发生在录像何处。 */
  mediaPositionMs?: number;
  previewOffsetMs?: number | null;
  hlsCursor?: import("../../recorder/engine.js").HlsCursor;
  /** 最后一次收到数据的时刻；中断造成的缺失时长从它算起。 */
  lastDataAt: number;
  /** 中断开始时刻；恢复拿到第一份数据时据此累计缺失时长，非中断期间为 null。 */
  gapStartAt: number | null;
  gapCause?: ErrorObject;
  /** 累计缺失时长（毫秒）。 */
  missingMs: number;
  /** 写盘失败自动恢复已用次数（PrePan 钦定共 3 次；稳定录满 STABLE_RESET_MS 归还）。 */
  writeRestartCount: number;
  /** 写盘自动恢复尝试进行中：手动开录（产品边界）据此让位。 */
  writeRestartPending: boolean;
  /** 用户手动介入后置位：恢复循环逐次检查，立即停止自动重启。 */
  writeRestartCancelled: boolean;
  /** 自动恢复流程收口信号：手动开录等它结束再接管，避免两路抢同一房间。 */
  writeRestartDone?: Promise<void> | undefined;
  /** 最近一次恢复录制的时刻；用于重连额度按轮重置。 */
  lastRecoveryAt: number;
  /** 拉流会话代次：被取代的旧会话据此停止处理事件，避免两路拉流同时写同一个文件。 */
  generation: number;
  /** 当前这一路拉流的完成信号（含关闭写流）；续录前必须等它，否则新旧两个写流会同时写同一个文件。 */
  pullDone: Promise<void> | null;
  /** 接力互斥：超时/断流/自然结束可能同时触发，只允许一次接力在途。 */
  handingOff: boolean;
  /** 手动停止接口等待录制记录和房间状态真正收口，避免响应先于异步生成器退出。 */
  done?: Promise<void>;
  resolveDone?: () => void;
  startupTrace?: PerformanceTrace;
}

export interface PreviewSession {
  streamSessionId?: string;
  engine: import("../../recorder/engine.js").RecordingEngine;
  /** The actual quality of this already-open upstream stream. */
  actualQuality: string;
  input?: import("../../platform/adapter.js").StreamUrlResult;
  /** First upstream data arrived; a socket alone is not enough to trust a preview as live. */
  hasReceivedData: boolean;
  /** 最近一次上游数据时刻：复用体检与停流判据的事实源（缺此字段=只认首包、不认新鲜度）。 */
  lastDataAt: number;
  done: Promise<void>;
  recording: SharedPreviewRecording | null;
  /** 仅供没有可复用 bootstrap 时走旧交接路径。 */
  transitioningToRecording: boolean;
  startupTrace?: PerformanceTrace;
}

export interface SharedPreviewRecording {
  session: ActiveSession;
  writer: WriteStream;
  normalizer: FlvTimestampNormalizer;
  /** 跳播定位索引写入器：共享预览支路与 runHttp 同样顺手记（否则预览转录制无索引）。 */
  seekWriter: SeekIndexWriter | null;
  bufferedWriter: BufferedRecordingWriter;
  pendingTags: FlvTagInfo[];
  writeError: Error | null;
}
