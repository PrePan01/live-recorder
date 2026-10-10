import { WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocketServer as WSS } from 'ws';
import { URL } from 'node:url';
import type { Services } from '../core/services.js';
import type { MonitorState } from '../types/index.js';

export const WS_CLOSE = {
  NORMAL: 1000,
  NOT_RECORDING: 4002,
  LIMIT: 4003,
  STREAM_LOST: 4004,
  INTERNAL: 1011,
} as const;

const RECORDING_STATES: MonitorState[] = ['recording', 'reconnecting'];

interface PreviewRoom {
  dir: string;
  sockets: Set<WebSocket>;
  /** FLV 初始化段（头 + onMetaData + AVC/AAC sequence headers），供中途加入客户端初始化解复用器。 */
  header: Buffer | null;
  extractor: FlvInitExtractor;
  /** 初始化段之后的近期媒体帧（完整 FLV 标签，滚动窗口，接近直播实时位置），与实时帧时间戳连续。 */
  tail: Buffer[];
  tailBytes: number;
  pendingTags: Buffer;
}

/** 初始化段安全上限：正常 FLV init（头+metadata+编码器配置）通常 <10KB，64KB 足兜底异常流。 */
const PREVIEW_HEADER_MAX = 64 * 1024;

/** 近期尾部滚动缓冲上限：接近实时位置的最近媒体（含近期关键帧），让重开预览可从实时附近起播且时间戳连续。 */
// 1 MB 连常见高清直播的一个 GOP 都放不下，晚加入会反复等下一个关键帧。
export const PREVIEW_TAIL_MAX = 16 * 1024 * 1024;
const PREVIEW_SOCKET_MAX_PENDING_BYTES = PREVIEW_TAIL_MAX + 4 * 1024 * 1024;
/**
 * 关闭/重开弹窗、播放器自愈重连时，旧 WebSocket 会短暂先于新连接关闭。
 * 保留上游流一小段时间，避免“停止旧流”和“启动新流”交错后新客户端无帧可收。
 */
export const PREVIEW_IDLE_GRACE_MS = 2_000;

/** 是否为视频关键帧 FLV 标签：type=9（视频）且 data[0] 高 4 位 FrameType==1。 */
function isKeyframeTag(tag: Buffer): boolean {
  return tag.length >= 13 && tag[0] === 9 && (tag[11]! & 0xf0) === 0x10 && !isSequenceTag(tag);
}

/** 比较编码器配置时忽略标签时间戳；重复序列头不应导致播放器重连。 */
function isSequenceTag(tag: Buffer): boolean {
  if (tag.length < 17 || tag[12] !== 0) return false;
  if (tag[0] === 8) return (tag[11]! >> 4) === 10;
  const codec = tag[11]! & 0x0f;
  return tag[0] === 9 && (codec === 7 || codec === 12);
}

/**
 * FLV 初始化段提取器：只缓存流头 + onMetaData + AVC/AAC sequence headers，
 * 不缓存媒体帧——避免中途加入重放带时间戳的旧媒体导致 MSE 时间断点卡播。
 */
class FlvInitExtractor {
  private pending: Buffer = Buffer.alloc(0);
  private captured: Buffer = Buffer.alloc(0);
  private done = false;
  private seenMeta = false;
  private seenVideoSeq = false;
  private seenAudioSeq = false;
  private firstMediaSeen = false;
  private initialMedia = Buffer.alloc(0);

  get complete(): boolean {
    return this.done;
  }

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
    if (this.captured.length === 0) {
      if (this.pending.length < 13) return null;
      if (this.pending.subarray(0, 3).toString() !== 'FLV') {
        // 不把无文件头的续录标签伪装成有效初始化段。
        this.pending = Buffer.alloc(0);
        return null;
      }
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
      if (type === 18) this.seenMeta = true;
      if (sequence && type === 9) this.seenVideoSeq = true;
      if (sequence && type === 8) this.seenAudioSeq = true;
      if (mediaTag && this.seenVideoSeq) {
        this.firstMediaSeen = true;
        break;
      }
      // 某些上游先发音频媒体再发视频配置；init 只包含元数据和配置，
      // 否则晚加入会重放旧音频并同步生成整段录制长度的静音补帧。
      if (!mediaTag) this.captured = Buffer.concat([this.captured, tag]);
      cursor += tagTotal;
      if (this.seenVideoSeq && this.seenAudioSeq) break;
    }
    this.pending = this.pending.subarray(cursor);
    if (this.seenVideoSeq && (this.seenAudioSeq || this.firstMediaSeen)) {
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

  reset(): void {
    this.pending = Buffer.alloc(0);
    this.captured = Buffer.alloc(0);
    this.done = false;
    this.seenMeta = false;
    this.seenVideoSeq = false;
    this.seenAudioSeq = false;
    this.firstMediaSeen = false;
    this.initialMedia = Buffer.alloc(0);
  }
}

/** 预览会话上限：最多 4 个活跃预览会话（按房间计数）。 */
export const PREVIEW_MAX_SESSIONS = 4;

export class PreviewManager {
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

  addClient(roomId: string, ws: WebSocket): void {
    this.clearEmptyRoomTimer(roomId);
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { dir: roomId, sockets: new Set(), header: null, extractor: new FlvInitExtractor(), tail: [], tailBytes: 0, pendingTags: Buffer.alloc(0) };
      this.rooms.set(roomId, room);
    }
    room.sockets.add(ws);
    // 中途加入：先补发 FLV 初始化段 + 近期尾部（接近实时位置），mpegts.js 才能初始化并从实时附近起播。
    const bootstrap = room.header ?? room.extractor.snapshot();
    if (bootstrap && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(bootstrap);
        if (room.header && room.tail.length > 0) ws.send(Buffer.concat(room.tail));
        // 后续网络块可能从标签中间开始；补齐已收到的前缀，保持 FLV 字节连续。
        if (room.header && room.pendingTags.length > 0) ws.send(room.pendingTags);
      } catch {
        // 写失败由 close 事件回收
      }
    }
    ws.on('close', () => {
      room!.sockets.delete(ws);
      // 保留房间与流头缓冲：录制/预览流活动期间客户端重开仍能初始化（#193 重开预览卡连接视频流）。
      // 房间的移除由流生命周期负责：closeRoom（流结束）/resetRoom（新段）清理。
      if (this.rooms.get(roomId) === room && room!.sockets.size === 0) this.deferRoomEmpty(roomId);
    });
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
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { dir: roomId, sockets: new Set(), header: null, extractor: new FlvInitExtractor(), tail: [], tailBytes: 0, pendingTags: Buffer.alloc(0) };
      this.rooms.set(roomId, room);
    }
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
    for (const ws of room.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          // ws buffers writes in user memory. Close slow clients so they can
          // reconnect from init + keyframe instead of growing without bound.
          if (ws.bufferedAmount + chunk.length > PREVIEW_SOCKET_MAX_PENDING_BYTES) {
            ws.close(WS_CLOSE.INTERNAL, 'preview backlog exceeded');
            continue;
          }
          ws.send(chunk);
        } catch {
          // 写失败由 close 事件回收
        }
      }
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
        return;
      }
      if (offset + length > room.pendingTags.length) break;
      const tag = room.pendingTags.subarray(offset, offset + length);
      offset += length;
      if (isSequenceTag(tag) || tag[0] === 18) {
        this.refreshHeader(roomId, room, tag);
        continue;
      }
      if (isKeyframeTag(tag)) {
        room.tail = [];
        room.tailBytes = 0;
      }
      // 无关键帧时等待下一个 GOP，不能把 P 帧当作晚加入的解码起点。
      if (room.tail.length === 0 && !isKeyframeTag(tag)) continue;
      if (room.tailBytes + length > PREVIEW_TAIL_MAX) {
        room.tail = [];
        room.tailBytes = 0;
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
      room.tail = [];
      room.tailBytes = 0;
      // WebKit 的 MSE 解码器不能继续用旧 SPS/AAC 配置处理新帧。
      // 保留房间和新配置，让当前观看端重连后从新关键帧开始。
      for (const ws of room.sockets) ws.close(1012, 'preview configuration changed');
      console.log(`[preview] configuration-changed room=…${roomId.slice(-6)} type=${tag[0]}`);
    }
  }

  /** 录制正常结束或断流：先下发 stream_end，再按对应关闭码收口。 */
  closeRoom(roomId: string, code: number, reason?: 'ended' | 'stream_lost'): void {
    this.clearEmptyRoomTimer(roomId);
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const ws of room.sockets) {
      try {
        if (reason) {
          ws.send(JSON.stringify({ type: 'stream_end', reason }));
        }
        ws.close(code);
      } catch {
        // 忽略已断开连接
      }
    }
    this.rooms.delete(roomId);
  }

  /** 新录制/新分段开始：清空该房间流头初始化段与近期尾部，确保下一段流的 FLV init 被重新捕获（跨录制不残留旧头）。 */
  resetRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const ws of room.sockets) ws.close(1012, 'preview source changed');
    room.header = null;
    room.extractor = new FlvInitExtractor();
    room.tail = [];
    room.tailBytes = 0;
    room.pendingTags = Buffer.alloc(0);
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
      for (const ws of room.sockets) {
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
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(WS_CLOSE.NOT_RECORDING));
      return;
    }
    if (!preview.canAccept(roomId)) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(WS_CLOSE.LIMIT));
      return;
    }
    // 开播但未录制（如 autoRecord=false 的房间点「观看」/直播墙）：启动 preview-only 拉流
    // （#163：预览=纯观看，不触发录制、不生成录制文件），让预览有数据流。异步执行不阻塞 upgrade。
    if (!isRecording && isLive) {
      void services.manager.ensurePreviewStream(room.id).then(() => {
        // Hover previews can leave while platform URL resolution is still pending.
        // The earlier empty-room callback cannot stop a stream that did not exist yet.
        if (!preview.hasClients(room.id))
          return services.manager.stopPreviewStream(room.id);
      }).catch(() => undefined);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      preview.addClient(roomId, ws);
    });
  };

  server.on('upgrade', onUpgrade);
  return { wss, dispose: () => server.off('upgrade', onUpgrade) };
}
