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
}

/** 初始化段安全上限：正常 FLV init（头+metadata+编码器配置）通常 <10KB，64KB 足兜底异常流。 */
const PREVIEW_HEADER_MAX = 64 * 1024;

/** 近期尾部滚动缓冲上限：接近实时位置的最近媒体（含近期关键帧），让重开预览可从实时附近起播且时间戳连续。 */
const PREVIEW_TAIL_MAX = 1024 * 1024;

/** 是否为视频关键帧 FLV 标签：type=9（视频）且 data[0] 高 4 位 FrameType==1。 */
function isKeyframeTag(tag: Buffer): boolean {
  return tag.length >= 12 && tag[0] === 9 && (tag[11]! & 0xf0) === 0x10;
}

/**
 * FLV 初始化段提取器：只缓存流头 + onMetaData + AVC/AAC sequence headers，
 * 不缓存媒体帧——避免中途加入重放带时间戳的旧媒体导致 MSE 时间断点卡播（#193「卡在第一秒」）。
 */
class FlvInitExtractor {
  private pending: Buffer = Buffer.alloc(0);
  private captured: Buffer = Buffer.alloc(0);
  private done = false;
  private seenMeta = false;
  private seenVideoSeq = false;
  private seenAudioSeq = false;
  private firstMediaSeen = false;

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

  /** 喂入流块；初始化段捕获完成时返回该段（非空），否则返回 null。 */
  push(chunk: Buffer): Buffer | null {
    if (this.done) return null;
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);

    let cursor = 0;
    if (this.captured.length === 0) {
      if (this.pending.length < 13) {
        if (this.pending.length > PREVIEW_HEADER_MAX) {
          this.done = true;
          this.captured = this.pending.subarray(0, PREVIEW_HEADER_MAX);
          this.pending = Buffer.alloc(0);
          return this.captured;
        }
        return null;
      }
      if ((this.pending.readUInt32BE(0) >>> 8) !== 0x464c56) {
        // 非 FLV 开头（异常流）：整段按上限兜底缓存，保留旧行为可初始化。
        this.done = true;
        this.captured = this.pending.subarray(0, Math.min(this.pending.length, PREVIEW_HEADER_MAX));
        this.pending = Buffer.alloc(0);
        return this.captured;
      }
      cursor = 13;
    }

    while (this.pending.length - cursor >= 15) {
      const type = this.pending[cursor];
      const dataSize = (this.pending[cursor + 1]! << 16) | (this.pending[cursor + 2]! << 8) | this.pending[cursor + 3]!;
      const tagTotal = 11 + dataSize + 4;
      if (this.pending.length - cursor < tagTotal) break;
      const videoSeq = type === 9 && dataSize >= 2 && (this.pending[cursor + 11]! & 0x0f) === 7 && this.pending[cursor + 12] === 0;
      const audioSeq = type === 8 && dataSize >= 2 && (this.pending[cursor + 11]! >> 4) === 10 && this.pending[cursor + 12] === 0;
      const mediaTag = (type === 8 || type === 9) && !videoSeq && !audioSeq;
      if (type === 18) this.seenMeta = true;
      if (videoSeq) this.seenVideoSeq = true;
      if (audioSeq) this.seenAudioSeq = true;
      // 完成条件：已见视频编码器序列头，且（音频序列头已见 或 即将进入首个媒体帧）。
      // 不强制依赖 AAC audioSeq（部分流段音频码率/码型不同，缺失时首媒体帧即终止，init 不含媒体帧）。
      const complete = this.seenVideoSeq && (this.seenAudioSeq || mediaTag);
      if (complete) {
        // 首个媒体帧不计入 init（避免 init 含旧时间戳媒体）；audioSeq 计入。
        if (mediaTag) this.firstMediaSeen = true;
        if (!mediaTag) cursor += tagTotal;
        break;
      }
      cursor += tagTotal;
    }

    if (cursor > 0) {
      this.captured = this.captured.length === 0 ? this.pending.subarray(0, cursor) : Buffer.concat([this.captured, this.pending.subarray(0, cursor)]);
      this.pending = this.pending.subarray(cursor);
    }
    if (this.seenVideoSeq && (this.seenAudioSeq || this.firstMediaSeen)) {
      this.done = true;
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
  }
}

/** 预览会话上限（V5 直播墙 #124）：最多 4 个活跃预览会话（按房间计数）。 */
export const PREVIEW_MAX_SESSIONS = 4;

export class PreviewManager {
  private rooms = new Map<string, PreviewRoom>();
  /** 某房间最后一个预览客户端断开时回调（用于停止 preview-only 拉流）。 */
  onRoomEmpty: ((roomId: string) => void) | null = null;

  constructor(private services: Services, private maxSessions = PREVIEW_MAX_SESSIONS) {}

  /** 会话=房间：每个被预览的房间算一个会话（同一房间多个 socket 共享一个会话）。 */
  canAccept(roomId?: string): boolean {
    // 同一房间重连不新增会话，即使已达总上限也必须允许，否则重开预览会永久收到 4003。
    return (roomId !== undefined && this.rooms.has(roomId)) || this.rooms.size < this.maxSessions;
  }

  addClient(roomId: string, ws: WebSocket): void {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { dir: roomId, sockets: new Set(), header: null, extractor: new FlvInitExtractor(), tail: [], tailBytes: 0 };
      this.rooms.set(roomId, room);
    }
    room.sockets.add(ws);
    // 中途加入：先补发 FLV 初始化段 + 近期尾部（接近实时位置），mpegts.js 才能初始化并从实时附近起播。
    const bootstrap = room.header ?? room.extractor.snapshot();
    if (bootstrap && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(bootstrap);
        if (room.header && room.tail.length > 0) ws.send(Buffer.concat(room.tail));
      } catch {
        // 写失败由 close 事件回收
      }
    }
    ws.on('close', () => {
      room!.sockets.delete(ws);
      // 保留房间与流头缓冲：录制/预览流活动期间客户端重开仍能初始化（#193 重开预览卡连接视频流）。
      // 房间的移除由流生命周期负责：closeRoom（流结束）/resetRoom（新段）清理。
      if (room!.sockets.size === 0) {
        this.onRoomEmpty?.(roomId);
      }
    });
  }

  broadcastFrame(roomId: string, chunk: Buffer): void {
    // 无论是否有预览客户端，都先记录 FLV 初始化段与近期尾部，保证中途加入的客户端能初始化 FLV 并从实时附近起播。
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { dir: roomId, sockets: new Set(), header: null, extractor: new FlvInitExtractor(), tail: [], tailBytes: 0 };
      this.rooms.set(roomId, room);
    }
    if (room.header === null) {
      const header = room.extractor.push(chunk);
      if (header) room.header = header;
    } else {
      // 初始化段之后：追加到近期尾部（每个 chunk 为完整 FLV 标签）。
      room.tail.push(chunk);
      room.tailBytes += chunk.length;
      // ① 按字节上限裁剪。
      while (room.tailBytes > PREVIEW_TAIL_MAX && room.tail.length > 1) {
        const dropped = room.tail.shift()!;
        room.tailBytes -= dropped.length;
      }
      // ② 保证队首为视频关键帧：裁剪/追加后队首若落在非关键帧上，继续裁掉直到关键帧（或仅剩 1 chunk）。
      // 晚加入/重开预览回放 [init]+[tail] 从关键帧起播，解码立即启动（FE 定位：P 帧开头卡第一秒）。
      while (room.tail.length > 1 && !isKeyframeTag(room.tail[0]!)) {
        const dropped = room.tail.shift()!;
        room.tailBytes -= dropped.length;
      }
    }
    for (const ws of room.sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(chunk);
        } catch {
          // 写失败由 close 事件回收
        }
      }
    }
  }

  /** 录制正常结束或断流：先下发 stream_end，再按对应关闭码收口。 */
  closeRoom(roomId: string, code: number, reason?: 'ended' | 'stream_lost'): void {
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
    room.header = null;
    room.extractor = new FlvInitExtractor();
    room.tail = [];
    room.tailBytes = 0;
  }

  closeRoomWithError(roomId: string, code: number): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const ws of room.sockets) {
      try {
        ws.close(code);
      } catch {
        // 忽略
      }
    }
    this.rooms.delete(roomId);
  }

  /** 当前活跃预览会话数（按房间）。 */
  get activeCount(): number {
    return this.rooms.size;
  }

  trackedRooms(): string[] {
    return [...this.rooms.keys()];
  }
}

export function attachWebSocketUpgrade(services: Services, preview: PreviewManager, server: import('node:http').Server, extraOrigins: string[] = [], port = 43120): { wss: WSS; dispose: () => void } {
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void handleUpgrade(req, socket, head);
  };

  const handleUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
      void services.manager.ensurePreviewStream(room.id);
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      preview.addClient(roomId, ws);
    });
  };

  server.on('upgrade', onUpgrade);
  return { wss, dispose: () => server.off('upgrade', onUpgrade) };
}

