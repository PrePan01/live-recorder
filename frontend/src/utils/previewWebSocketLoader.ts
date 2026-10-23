import { FlvMediaOriginReader } from "./previewMediaClock";
import { isServerPreviewProgressStage } from './previewLoadProgress';
import type mpegts from "mpegts.js";

/** WebSocket callbacks must stop before the player releases its IO controller. */
export class PreviewWebSocketLoader implements mpegts.BaseLoader {
  readonly type = "preview-websocket-loader";
  _status = 0;
  _needStash = true;
  onContentLengthKnown: mpegts.BaseLoader["onContentLengthKnown"] = () => {};
  onURLRedirect: mpegts.BaseLoader["onURLRedirect"] = () => {};
  onDataArrival: mpegts.BaseLoader["onDataArrival"] = () => {};
  onError: mpegts.BaseLoader["onError"] = () => {};
  onComplete: mpegts.BaseLoader["onComplete"] = () => {};
  private socket: WebSocket | null = null;
  private receivedLength = 0;
  private originReader?: FlvMediaOriginReader;
  private onOrigin?: (milliseconds: number) => void;
  private onProgress?: (stage: string) => void;
  constructor(_seekHandler?: unknown, _config?: unknown, onOrigin?: (milliseconds: number) => void, onProgress?: (stage: string) => void) {
    this.onOrigin = onOrigin;
    this.onProgress = onProgress;
  }
  get status() {
    return this._status;
  }
  get needStashBuffer() {
    return this._needStash;
  }
  isWorking() {
    return this._status === 1 || this._status === 2;
  }

  open(dataSource: mpegts.MediaSegment) {
    this.abort();
    this.receivedLength = 0;
    this.originReader = this.onOrigin ? new FlvMediaOriginReader(this.onOrigin) : undefined;
    this._status = 1;
    try {
      const url = new URL(dataSource.url);
      if (this.onProgress) url.searchParams.set('progress', '1');
      const socket = new WebSocket(url.href);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      const active = () => this.socket === socket;
      socket.onopen = () => {
        if (active()) {
          this._status = 2;
          this.onProgress?.('connected');
        }
      };
      socket.onmessage = (event) => {
        if (!active()) return;
        if (event.data instanceof ArrayBuffer) {
          this.deliver(event.data);
        } else if (event.data instanceof Blob) {
          void event.data
            .arrayBuffer()
            .then((buffer) => {
              if (active()) this.deliver(buffer);
            })
            .catch((error: unknown) => {
              if (active())
                this.fail(
                  error instanceof Error ? error.message : "读取预览数据失败",
                );
            });
        } else if (typeof event.data === 'string') {
          try {
            if (event.data.length > 4096) throw new Error('oversized control frame');
            const message = JSON.parse(event.data);
            if (message?.type === 'preview_progress' && isServerPreviewProgressStage(message.stage)) this.onProgress?.(message.stage);
            // Control frames never belong to the media byte stream. stream_end
            // is followed by the server close; retain the existing EOF handling.
          } catch { this.fail('预览连接收到无效的控制消息'); }
        } else {
          this.fail("预览连接收到不支持的数据格式");
        }
      };
      socket.onerror = () => {
        if (active()) this.fail("预览连接发生网络错误");
      };
      socket.onclose = () => {
        if (!active()) return;
        this._status = 4;
        this.onComplete(0, this.receivedLength - 1);
      };
    } catch (error) {
      this.fail(error instanceof Error ? error.message : "无法建立预览连接");
    }
  }

  abort() {
    const socket = this.socket;
    this.socket = null;
    this._status = 4;
    if (!socket) return;
    // Closing a CONNECTING socket can dispatch error after destroy().
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    if (socket.readyState === 0 || socket.readyState === 1) socket.close();
  }

  destroy() {
    this.abort();
    this._status = 0;
    this.onContentLengthKnown = () => {};
    this.onURLRedirect = () => {};
    this.onDataArrival = () => {};
    this.onError = () => {};
    this.onComplete = () => {};
  }

  private deliver(buffer: ArrayBuffer) {
    const start = this.receivedLength;
    if (!start && buffer.byteLength) this.onProgress?.('receiving_media');
    this.receivedLength += buffer.byteLength;
    this.originReader?.push(buffer);
    this.onDataArrival(buffer, start, this.receivedLength);
  }

  private fail(message: string) {
    this._status = 3;
    // mpegts declares LoaderErrors as the constants object but passes its values at runtime.
    this.onError("Exception" as unknown as mpegts.LoaderErrors, {
      code: -1,
      msg: message,
    });
  }
}
