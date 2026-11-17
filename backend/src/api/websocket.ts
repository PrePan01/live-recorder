import { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocketServer as WSS } from 'ws';
import { URL } from 'node:url';
import type { Services } from '../core/services.js';
import type { PreviewEndReason } from '../core/recorder/types.js';
import type { MonitorState } from '../types/index.js';
import { isFlvSequenceHeader, isFlvVideoKeyframe } from '../recorder/flv-tags.js';

export const WS_CLOSE = {
  NORMAL: 1000,
  NOT_RECORDING: 4002,
  LIMIT: 4003,
  STREAM_LOST: 4004,
  INTERNAL: 1011,
} as const;

const RECORDING_STATES: MonitorState[] = ['recording', 'reconnecting'];

function closePreviewSocket(ws: WebSocket, code: number, reason?: PreviewEndReason): void {
  try {
    if (reason) ws.send(JSON.stringify({ type: 'stream_end', reason }));
    ws.close(code);
  } catch { /* Socket already disconnected. */ }
}

interface PreviewRoom {
  sockets: Map<WebSocket, 'waiting' | 'streaming' | 'switching'>;
  /** FLV 初始化段（头 + onMetaData + AVC/AAC sequence headers），供中途加入客户端初始化解复用器。 */
  header: Buffer | null;
  extractor: FlvInitExtractor;
  /** 初始化段之后的近期媒体帧（完整 FLV 标签，滚动窗口，接近直播实时位置），与实时帧时间戳连续。 */
  tail: Buffer[];
  tailBytes: number;
  tailHasAudio: boolean;
  pendingTags: Buffer;
  progressStage?: string;
}

const PREVIEW_PROGRESS_STAGES = new Set([
  'requested', 'platform_cookie_ready', 'stream_url_ready', 'source_ready',
  'reused_native_source', 'reused_preview_stream', 'youtube_manifests_ready',
  'youtube_source_process_started', 'youtube_initial_segments_ready',
  'youtube_native_stream_ready', 'preview_encoder_started', 'preview_media_ready',
]);

/** 初始化段安全上限：正常 FLV init（头+metadata+编码器配置）通常 <10KB，64KB 足兜底异常流。 */
const PREVIEW_HEADER_MAX = 64 * 1024;

/** 近期尾部滚动缓冲上限：接近实时位置的最近媒体（含近期关键帧），让重开预览可从实时附近起播且时间戳连续。 */
// 1 MB 连常见高清直播的一个 GOP 都放不下，晚加入会反复等下一个关键帧。
export const PREVIEW_TAIL_MAX = 16 * 1024 * 1024;
const PREVIEW_SOCKET_MAX_PENDING_BYTES = PREVIEW_TAIL_MAX + 4 * 1024 * 1024;
const PREVIEW_REPLACEMENT_READY = JSON.stringify({ type: 'preview_replacement_ready' });
/**
 * 关闭/重开弹窗、播放器自愈重连时，旧 WebSocket 会短暂先于新连接关闭。
 * 保留上游流一小段时间，避免“停止旧流”和“启动新流”交错后新客户端无帧可收。
 */
export const PREVIEW_IDLE_GRACE_MS = 2_000;

/** 是否为视频关键帧 FLV 标签：type=9（视频）且 data[0] 高 4 位 FrameType==1。 */
const isKeyframeTag = isFlvVideoKeyframe;

/** 比较编码器配置时忽略标签时间戳；重复序列头不应导致播放器重连。 */
function isSequenceTag(tag: Buffer): boolean {
  // Enhanced FLV audio stores SequenceStart and a FourCC in the audio payload.
  return isFlvSequenceHeader(tag) ||
    (tag[0] === 8 && tag.length > 20 && tag[11] === 0x90);
}

/**
 * FLV 初始化段提取器：只缓存流头 + onMetaData + AVC/AAC sequence headers，
 * 不缓存媒体帧——避免中途加入重放带时间戳的旧媒体导致 MSE 时间断点卡播。
 */
class FlvInitExtractor {
  private pending: Buffer = Buffer.alloc(0);
  private captured: Buffer = Buffer.alloc(0);
  private done = false;
  hasVideoConfig = false;
  hasAudioConfig = false;
  isFlv: boolean | undefined;
  rawStart: Buffer | null = null;
  private initialMedia = Buffer.alloc(0);

  /** 初始化尚未判定完成时，供晚加入客户端取得目前已收到的连续 FLV 前缀。 */
  snapshot(): Buffer | null {
    const value = this.pending.length === 0
      ? this.captured
      : this.captured.length === 0
        ? this.pending
        : Buffer.concat([this.captured, this.pending]);
    return value.length > 0 ? value.subarray(0, PREVIEW_HEADER_MAX) : null;
  }

  /** 初始化捕获完成时被分离出的首批媒体帧（从关键帧缓存逻辑继续处理）。 */
  takeInitialMedia(): Buffer {
    const media = this.initialMedia;
    this.initialMedia = Buffer.alloc(0);
    return media;
  }

  /** 喂入流块；初始化段捕获完成时返回该段（非空），否则返回 null。 */
  push(chunk: Buffer): Buffer | null {
    if (this.done) return null;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    let cursor = 0;
    let firstMediaSeen = false;
    if (this.captured.length === 0) {
      if (this.isFlv === undefined) {
        const signature = this.pending.toString('latin1', 0, 3);
        if (!'FLV'.startsWith(signature)) {
          this.isFlv = false;
          this.rawStart = this.pending;
          this.pending = Buffer.alloc(0);
          this.done = true;
          return null;
        }
        if (signature.length < 3) return null;
        this.isFlv = true;
      }
      if (this.pending.length < 13) return null;
      this.captured = Buffer.from(this.pending.subarray(0, 13));
      cursor = 13;
    }
    while (this.pending.length - cursor >= 15) {
      const dataSize = this.pending.readUIntBE(cursor + 1, 3);
      const tagTotal = dataSize + 15;
      if (this.pending.length - cursor < tagTotal) break;
      const tag = this.pending.subarray(cursor, cursor + tagTotal);
      const type = tag[0];
      const sequence = isSequenceTag(tag);
      const mediaTag = (type === 8 || type === 9) && !sequence;
      if (sequence && type === 9) this.hasVideoConfig = true;
      if (sequence && type === 8) this.hasAudioConfig = true;
      if (mediaTag && this.hasVideoConfig) {
        firstMediaSeen = true;
        break;
      }
      // 某些上游先发音频媒体再发视频配置；init 只包含元数据和配置，
      // 否则晚加入会重放旧音频并同步生成整段录制长度的静音补帧。
      if (!mediaTag) this.captured = Buffer.concat([this.captured, tag]);
      cursor += tagTotal;
      if (this.hasVideoConfig && this.hasAudioConfig) break;
    }
    this.pending = this.pending.subarray(cursor);
    if (this.hasVideoConfig && (this.hasAudioConfig || firstMediaSeen)) {
      this.done = true;
      this.initialMedia = Buffer.from(this.pending);
      this.pending = Buffer.alloc(0);
      return this.captured;
    }
    if (this.captured.length + this.pending.length > PREVIEW_HEADER_MAX) {
      this.done = true;
      this.captured = Buffer.concat([this.captured, this.pending]).subarray(0, PREVIEW_HEADER_MAX);
      this.pending = Buffer.alloc(0);
      return this.captured;
    }
    return null;
  }
}

/** 预览会话上限：最多 4 个活跃预览会话（按房间计数）。 */
export const PREVIEW_MAX_SESSIONS = 4;

export class PreviewManager {
  private progressClients = new WeakSet<WebSocket>();
  private replacementClients = new WeakSet<WebSocket>();
  private rooms = new Map<string, PreviewRoom>();
  private emptyRoomTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 某房间最后一个预览客户端断开时回调（用于停止 preview-only 拉流）。 */
  onRoomEmpty: ((roomId: string) => void) | null = null;

  constructor(private services: Services, private maxSessions = PREVIEW_MAX_SESSIONS) {}

  /** 会话=房间：每个被预览的房间算一个会话（同一房间多个 socket 共享一个会话）。 */
  canAccept(roomId?: string): boolean {
    // 同一房间重连不新增会话，即使已达总上限也必须允许，否则重开预览会永久收到 4003。
    return (roomId !== undefined && this.hasClients(roomId)) || this.activeCount < this.maxSessions;
  }

  hasClients(roomId: string): boolean {
    return (this.rooms.get(roomId)?.sockets.size ?? 0) > 0;
  }

  private roomFor(roomId: string): PreviewRoom {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = {
        sockets: new Map(), header: null, extractor: new FlvInitExtractor(),
        tail: [], tailBytes: 0, tailHasAudio: false, pendingTags: Buffer.alloc(0),
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  addClient(roomId: string, ws: WebSocket, progress = false, replacement = false): void {
    this.clearEmptyRoomTimer(roomId);
    const room = this.roomFor(roomId);
    room.sockets.set(ws, 'waiting');
    ws.on('close', () => {
      room.sockets.delete(ws);
      if (this.rooms.get(roomId) === room && room.sockets.size === 0) this.deferRoomEmpty(roomId);
    });
    if (progress) {
      this.progressClients.add(ws);
      room.progressStage ??= 'requested';
      this.sendProgress(ws, room.progressStage);
    }
    if (replacement) this.replacementClients.add(ws);
    if (ws.readyState === WebSocket.OPEN && this.hasPlayableStart(room))
      this.startClient(room, ws, () => Buffer.concat(room.tail, room.tailBytes));
  }

  private sendProgress(ws: WebSocket, stage: string): void {
    if (!this.progressClients.has(ws) || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ type: 'preview_progress', stage })); } catch { /* disconnect */ }
  }

  reportProgress(roomId: string, stage: string): void {
    if (!PREVIEW_PROGRESS_STAGES.has(stage)) return;
    const room = this.rooms.get(roomId);
    if (!room || room.progressStage === stage) return;
    room.progressStage = stage;
    for (const ws of room.sockets.keys()) this.sendProgress(ws, stage);
  }

  private clearEmptyRoomTimer(roomId: string): void {
    const timer = this.emptyRoomTimers.get(roomId);
    if (!timer) return;
    clearTimeout(timer);
    this.emptyRoomTimers.delete(roomId);
  }

  private deferRoomEmpty(roomId: string): void {
    this.clearEmptyRoomTimer(roomId);
    const timer = setTimeout(() => {
      this.emptyRoomTimers.delete(roomId);
      // 新客户端可能在旧 socket close 后立即连入；只有宽限期结束时仍无人观看
      // 才停止 preview-only 上游流。
      if ((this.rooms.get(roomId)?.sockets.size ?? 0) === 0)
        this.onRoomEmpty?.(roomId);
    }, PREVIEW_IDLE_GRACE_MS);
    this.emptyRoomTimers.set(roomId, timer);
  }

  broadcastFrame(roomId: string, chunk: Buffer): void {
    // 无论是否有预览客户端，都先记录 FLV 初始化段与近期尾部，保证中途加入的客户端能初始化 FLV 并从实时附近起播。
    const room = this.roomFor(roomId);
    if (room.header === null) {
      const header = room.extractor.push(chunk);
      if (header) {
        room.header = header;
        const initialMedia = room.extractor.takeInitialMedia();
        if (initialMedia.length > 0) {
          this.cacheTags(roomId, room, initialMedia);
        }
      }
    } else {
      this.cacheTags(roomId, room, chunk);
    }
    const raw = room.extractor.isFlv === false;
    const liveChunk = room.extractor.rawStart ?? chunk;
    room.extractor.rawStart = null;
    const ready = this.hasPlayableStart(room);
    let tail: Buffer | undefined;
    for (const [ws, state] of room.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (state === 'switching') {
        if (ready) this.closeForReplacement(ws);
        else if (raw) ws.close(1012, 'preview source changed');
      } else if (state === 'streaming') {
        this.sendMedia(ws, liveChunk);
      } else if (raw) {
        if (this.sendMedia(ws, liveChunk)) room.sockets.set(ws, 'streaming');
      } else if (ready) {
        // This batch is already represented by the bootstrap and partial tag.
        this.startClient(room, ws, () => tail ??= Buffer.concat(room.tail, room.tailBytes));
      }
    }
  }

  private closeForReplacement(ws: WebSocket): void {
    // Some WebViews omit the close code and reason. Opted-in clients receive
    // the notice before closing, while binary-only clients receive just EOF.
    if (this.replacementClients.has(ws)) {
      try { ws.send(PREVIEW_REPLACEMENT_READY); } catch { /* disconnect */ }
    }
    ws.close(1012, 'preview replacement ready');
  }

  private hasPlayableStart(room: PreviewRoom): boolean {
    if (!room.header || !room.extractor.hasVideoConfig || room.tail.length === 0) return false;
    if (room.header.length + room.tailBytes + room.pendingTags.length > PREVIEW_SOCKET_MAX_PENDING_BYTES) return false;
    const expectsAudio = Boolean(room.header[4]! & 4);
    return !expectsAudio || room.extractor.hasAudioConfig || room.tailHasAudio;
  }

  private startClient(room: PreviewRoom, ws: WebSocket, tail: () => Buffer): void {
    // The partial tag is the prefix of the next raw broadcast, not part of the GOP.
    if (this.sendMedia(ws, room.header!, tail(), room.pendingTags))
      room.sockets.set(ws, 'streaming');
  }

  private sendMedia(ws: WebSocket, bytes: Buffer, tail?: Buffer, pending?: Buffer): boolean {
    try {
      const size = bytes.length + (tail?.length ?? 0) + (pending?.length ?? 0);
      if (ws.bufferedAmount + size > PREVIEW_SOCKET_MAX_PENDING_BYTES) {
        ws.close(WS_CLOSE.INTERNAL, 'preview backlog exceeded');
        return false;
      }
      ws.send(bytes);
      if (tail?.length) ws.send(tail);
      if (pending?.length) ws.send(pending);
      return true;
    } catch {
      // The socket's close event handles cleanup.
      return false;
    }
  }

  private clearTail(room: PreviewRoom): void {
    room.tail = [];
    room.tailBytes = 0;
    room.tailHasAudio = false;
  }

  private switchStreamingClients(room: PreviewRoom): void {
    for (const [ws, state] of room.sockets) {
      if (state === 'streaming') room.sockets.set(ws, 'switching');
    }
  }

  /** 缓存完整标签，更新当前编码配置，并只保留可独立解码的近期 GOP。 */
  private cacheTags(roomId: string, room: PreviewRoom, chunk: Buffer): void {
    room.pendingTags = room.pendingTags.length > 0
      ? Buffer.concat([room.pendingTags, chunk]) : chunk;
    let offset = 0;
    while (offset + 15 <= room.pendingTags.length) {
      const size = room.pendingTags.readUIntBE(offset + 1, 3);
      const length = size + 15;
      // 异常/过大标签不应让每次广播重复拼接、无限保留网络数据。
      if (![8, 9, 18].includes(room.pendingTags[offset]!) || length > PREVIEW_SOCKET_MAX_PENDING_BYTES) {
        room.pendingTags = Buffer.alloc(0);
        this.clearTail(room);
        return;
      }
      if (offset + length > room.pendingTags.length) break;
      const tag = room.pendingTags.subarray(offset, offset + length);
      offset += length;
      if (isSequenceTag(tag) || tag[0] === 18) {
        this.refreshHeader(roomId, room, tag);
        continue;
      }
      const keyframe = isKeyframeTag(tag);
      if (keyframe) this.clearTail(room);
      // 无关键帧时等待下一个 GOP，不能把 P 帧当作晚加入的解码起点。
      if (room.tail.length === 0 && !keyframe) continue;
      if (tag[0] === 8 && !room.extractor.hasAudioConfig) {
        const codec = tag[11]! >> 4;
        // MP3 and PCM have no sequence header. Never replay AAC/extended audio
        // received before its configuration as part of a viewer bootstrap.
        if (length <= 16 || (codec !== 2 && codec !== 3)) continue;
        room.tailHasAudio = true;
      }
      if (room.tailBytes + length > PREVIEW_TAIL_MAX) {
        this.clearTail(room);
        continue;
      }
      // 独立副本避免一个很小的标签长期引用整块网络缓冲。
      room.tail.push(Buffer.from(tag));
      room.tailBytes += length;
    }
    room.pendingTags = Buffer.from(room.pendingTags.subarray(offset));
  }

  private refreshHeader(roomId: string, room: PreviewRoom, tag: Buffer): void {
    const header = room.header;
    if (!header || header.subarray(0, 3).toString() !== 'FLV') return;
    const parts = [header.subarray(0, 13)];
    let previous: Buffer | null = null;
    for (let offset = 13; offset + 15 <= header.length;) {
      const length = header.readUIntBE(offset + 1, 3) + 15;
      if (offset + length > header.length) break;
      const part = header.subarray(offset, offset + length);
      if (part[0] === tag[0] && (tag[0] === 18 || isSequenceTag(part))) previous = part;
      else parts.push(part);
      offset += length;
    }
    if (previous?.subarray(11).equals(tag.subarray(11))) return;
    if (parts.reduce((n, part) => n + part.length, tag.length) > PREVIEW_HEADER_MAX) return;
    parts.push(Buffer.from(tag));
    room.header = Buffer.concat(parts);
    if (isSequenceTag(tag)) {
      if (tag[0] === 8) room.extractor.hasAudioConfig = true;
      else room.extractor.hasVideoConfig = true;
      // A late first AAC header completes the original video GOP. Only an
      // actual replacement requires new random-access media and a decoder reset.
      if (previous) {
        this.clearTail(room);
        this.switchStreamingClients(room);
        console.log(`[preview] configuration-changed room=…${roomId.slice(-6)} type=${tag[0]}`);
      }
    }
  }

  /** 录制正常结束或断流：先下发 stream_end，再按对应关闭码收口。 */
  closeRoom(roomId: string, code: number, reason?: PreviewEndReason): void {
    this.clearEmptyRoomTimer(roomId);
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const ws of room.sockets.keys()) closePreviewSocket(ws, code, reason);
    this.rooms.delete(roomId);
  }

  /** 新录制/新分段开始：清空该房间流头初始化段与近期尾部，确保下一段流的 FLV init 被重新捕获（跨录制不残留旧头）。 */
  resetRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.switchStreamingClients(room);
    room.header = null;
    room.extractor = new FlvInitExtractor();
    this.clearTail(room);
    room.pendingTags = Buffer.alloc(0);
    room.progressStage = 'requested';
    console.log(`[preview] source-reset room=…${roomId.slice(-6)}`);
  }

  /**
   * 返回 FLV 初始化段和最近一个关键帧起的尾部数据，供同一上游流的录制写入器接管。
   * 不触碰 socket 或缓存，因此观看中的客户端不会中断。
   */
  recordingBootstrap(roomId: string): Buffer | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (room.header && room.tail.length > 0 && isKeyframeTag(room.tail[0]!)) {
      return Buffer.concat([room.header, ...room.tail]);
    }
    // 初始化尚未完成时仍可交给写入器：它会保留当前连续 FLV 前缀并继续接收后续帧。
    // 这覆盖刚打开观看就点击录制的场景，避免为了等待关键帧而回退到断开重连。
    return room.header ?? room.extractor.snapshot();
  }

  /**
   * 退出/重启收束：关闭所有预览房间并销毁底层连接。
   * 升级后的 socket 不在 HTTP 服务器的连接跟踪里，`server.close()` 会一直等它们直到进程被强杀，
   * 而 forceCloseConnections 只销毁普通连接；只发关闭帧不足以让 server.close() 返回，
   * 必须主动 terminate（直播墙开着预览退出/重启卡住的根因）。
   */
  closeAll(code: number): void {
    for (const roomId of [...this.rooms.keys()]) {
      this.clearEmptyRoomTimer(roomId);
      const room = this.rooms.get(roomId);
      if (!room) continue;
      for (const ws of room.sockets.keys()) {
        try {
          ws.close(code);
          ws.terminate();
        } catch {
          // 忽略已断开的连接
        }
      }
      this.rooms.delete(roomId);
    }
  }

  /** 当前活跃预览会话数（按房间）。 */
  get activeCount(): number {
    return [...this.rooms.values()].filter((room) => room.sockets.size > 0).length;
  }
}

export function attachWebSocketUpgrade(services: Services, preview: PreviewManager, server: import('node:http').Server, extraOrigins: string[] = [], portOrResolver: number | (() => number) = 43120): { wss: WSS; dispose: () => void } {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head);
  };

  const handleUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (services.resetting) { socket.destroy(); return; }
    const port = typeof portOrResolver === 'function' ? portOrResolver() : portOrResolver;
    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    // 兜底：允许 Vite 代理（5173）与 Tauri WebView（tauri.localhost）转发的 Host，避免未设 changeOrigin 时被误拒。
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, '127.0.0.1:5173', 'localhost:5173', 'tauri.localhost', 'tauri://localhost']);
    const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://tauri.localhost', 'tauri://localhost', ...extraOrigins]);
    if (!allowedHosts.has(host)) {
      socket.destroy();
      return;
    }
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '', `http://127.0.0.1:${port}`);
    const match = /^\/ws\/preview\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    const roomId = decodeURIComponent(match[1]!);
    const room = services.rooms.get(roomId);
    if (!room) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(WS_CLOSE.NOT_RECORDING));
      return;
    }
    const isRecording = RECORDING_STATES.includes(room.monitorState);
    const isLive = room.lastLiveStatus === 'live';
    if (!isRecording && !isLive) {
      // 非录制也非开播（offline/restricted/idle）→ 拒绝。
      wss.handleUpgrade(req, socket, head, (ws) => closePreviewSocket(
        ws, WS_CLOSE.NOT_RECORDING, room.lastLiveStatus === 'offline' ? 'live_ended' : undefined,
      ));
      return;
    }
    if (!preview.canAccept(roomId)) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(WS_CLOSE.LIMIT));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      preview.addClient(
        roomId, ws,
        url.searchParams.get('progress') === '1',
        url.searchParams.get('replacement') === '1',
      );
      // Register the watcher first. This also reactivates an on-demand preview
      // encoder when joining an existing recording or reconnecting after handoff.
      void services.manager.ensurePreviewStream(room.id).then(() => {
        // Hover previews can leave while platform URL resolution is still pending.
        // The earlier empty-room callback cannot stop a stream that did not exist yet.
        if (!preview.hasClients(room.id))
          return services.manager.stopPreviewStream(room.id);
      }).catch(() => undefined);
    });
  };

  server.on('upgrade', onUpgrade);
  return { wss, dispose: () => server.off('upgrade', onUpgrade) };
}
