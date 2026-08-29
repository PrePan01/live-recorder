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
  /** 流开头缓冲（含 FLV header/metadata），供中途加入的客户端初始化 mpegts。 */
  headerBuffer: Buffer[];
  headerBytes: number;
}

/** 预览头缓冲上限：足够覆盖 FLV 头 + onMetaData + 若干初始帧。 */
const PREVIEW_HEADER_MAX = 512 * 1024;

/** 预览会话上限（V5 直播墙 #124）：最多 4 个活跃预览会话（按房间计数）。 */
export const PREVIEW_MAX_SESSIONS = 4;

export class PreviewManager {
  private rooms = new Map<string, PreviewRoom>();

  constructor(private services: Services, private maxSessions = PREVIEW_MAX_SESSIONS) {}

  /** 会话=房间：每个被预览的房间算一个会话（同一房间多个 socket 共享一个会话）。 */
  canAccept(): boolean {
    return this.rooms.size < this.maxSessions;
  }

  addClient(roomId: string, ws: WebSocket): void {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { dir: roomId, sockets: new Set(), headerBuffer: [], headerBytes: 0 };
      this.rooms.set(roomId, room);
    }
    room.sockets.add(ws);
    // 中途加入：先补发流头缓冲，mpegts.js 才能识别 FLV 并初始化解复用器。
    for (const chunk of room.headerBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(chunk);
        } catch {
          // 写失败由 close 事件回收
        }
      }
    }
    ws.on('close', () => {
      room!.sockets.delete(ws);
      // 仅当房间无 socket 时移除（会话结束），录制中保留流头缓冲供后续加入。
      if (room!.sockets.size === 0) {
        this.rooms.delete(roomId);
      }
    });
  }

  broadcastFrame(roomId: string, chunk: Buffer): void {
    // 无论是否有预览客户端，都先记录流头缓冲，保证中途加入的客户端能初始化 FLV。
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { dir: roomId, sockets: new Set(), headerBuffer: [], headerBytes: 0 };
      this.rooms.set(roomId, room);
    }
    if (room.headerBytes < PREVIEW_HEADER_MAX) {
      const remaining = PREVIEW_HEADER_MAX - room.headerBytes;
      const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      room.headerBuffer.push(slice);
      room.headerBytes += slice.length;
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
    if (!room || !RECORDING_STATES.includes(room.monitorState)) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(WS_CLOSE.NOT_RECORDING));
      return;
    }
    if (!preview.canAccept()) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(WS_CLOSE.LIMIT));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      preview.addClient(roomId, ws);
    });
  };

  server.on('upgrade', onUpgrade);
  return { wss, dispose: () => server.off('upgrade', onUpgrade) };
}


