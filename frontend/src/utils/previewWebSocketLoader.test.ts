import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewWebSocketLoader } from "./previewWebSocketLoader";
import { livePreviewConfig } from "./livePreviewConfig";

class Socket {
  static latest: Socket;
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  url: string;
  constructor(url: string) {
    this.url = url;
    Socket.latest = this;
  }
}
function open() {
  const loader = new PreviewWebSocketLoader();
  loader.open({ url: "ws://localhost/preview", duration: 0 });
  return { loader, socket: Socket.latest };
}
beforeEach(() => vi.stubGlobal("WebSocket", Socket));
afterEach(() => vi.unstubAllGlobals());

describe("preview WebSocket lifecycle", () => {
  it('opts into progress and keeps control messages out of the binary media stream', () => {
    const progress = vi.fn();
    const loader = new PreviewWebSocketLoader(undefined, undefined, undefined, progress);
    loader.open({ url: 'ws://localhost/preview?existing=1', duration: 0 });
    const socket = Socket.latest;
    expect(new URL(socket.url).searchParams.get('progress')).toBe('1');
    expect(new URL(socket.url).searchParams.get('existing')).toBe('1');
    loader.onDataArrival = vi.fn(); loader.onError = vi.fn();
    socket.onopen!();
    socket.onmessage!({ data: JSON.stringify({ type: 'preview_progress', stage: 'stream_url_ready' }) });
    expect(progress).toHaveBeenCalledWith('connected');
    expect(progress).toHaveBeenCalledWith('stream_url_ready');
    socket.onmessage!({ data: JSON.stringify({ type: 'preview_progress', stage: 'presented' }) });
    expect(progress).not.toHaveBeenCalledWith('presented');
    expect(loader.onDataArrival).not.toHaveBeenCalled();
    socket.onmessage!({ data: new ArrayBuffer(4) });
    expect(progress).toHaveBeenCalledWith('receiving_media');
    expect(loader.onDataArrival).toHaveBeenCalledWith(expect.any(ArrayBuffer), 0, 4);
    socket.onmessage!({ data: JSON.stringify({ type: 'stream_end', reason: 'ended' }) });
    expect(loader.onError).not.toHaveBeenCalled();
    const late = socket.onmessage!;
    progress.mockClear(); loader.destroy();
    late({ data: JSON.stringify({ type: 'preview_progress', stage: 'preview_media_ready' }) });
    expect(progress).not.toHaveBeenCalled();
  });
  it('keeps binary-only consumers on the existing protocol', () => {
    const { loader, socket } = open();
    expect(new URL(socket.url).searchParams.has('progress')).toBe(false);
    loader.destroy();
  });
  it("clears handlers before closing a connecting socket and ignores queued callbacks", () => {
    const { loader, socket } = open();
    const error = socket.onerror!;
    const message = socket.onmessage!;
    const close = socket.onclose!;
    const onError = (loader.onError = vi.fn());
    const onData = (loader.onDataArrival = vi.fn());
    const onComplete = (loader.onComplete = vi.fn());
    socket.close.mockImplementation(() => {
      expect(socket.onerror).toBeNull();
      expect(socket.onmessage).toBeNull();
    });
    loader.destroy();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(() => error()).not.toThrow();
    message({ data: new ArrayBuffer(4) });
    close();
    expect(onError).not.toHaveBeenCalled();
    expect(onData).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(loader.status).toBe(0);
  });

  it("does not let an old connection affect a reopened loader", () => {
    const { loader, socket } = open();
    const error = socket.onerror!;
    const message = socket.onmessage!;
    loader.open({ url: "ws://localhost/next", duration: 0 });
    const next = Socket.latest;
    loader.onError = vi.fn();
    loader.onDataArrival = vi.fn();
    error();
    message({ data: new ArrayBuffer(8) });
    expect(loader.onError).not.toHaveBeenCalled();
    expect(loader.onDataArrival).not.toHaveBeenCalled();
    expect(loader.status).toBe(1);
    next.onopen!();
    next.onmessage!({ data: new ArrayBuffer(3) });
    expect(loader.onDataArrival).toHaveBeenCalledWith(
      expect.any(ArrayBuffer),
      0,
      3,
    );
  });

  it("reports active network errors and clean EOF to the player", () => {
    const { loader, socket } = open();
    loader.onError = vi.fn();
    loader.onComplete = vi.fn();
    socket.onerror!();
    expect(loader.onError).toHaveBeenCalledWith("Exception", {
      code: -1,
      msg: "预览连接发生网络错误",
    });
    socket.onclose!();
    expect(loader.onComplete).toHaveBeenCalledWith(0, -1);
  });

  it("ignores asynchronous Blob delivery after destroy", async () => {
    const { loader, socket } = open();
    const onData = (loader.onDataArrival = vi.fn());
    socket.onmessage!({ data: new Blob(["late"]) });
    loader.destroy();
    await Promise.resolve();
    expect(onData).not.toHaveBeenCalled();
  });

  it("uses the lifecycle-safe loader without sending functions to a worker", () => {
    expect(livePreviewConfig(false)).toMatchObject({
      customLoader: PreviewWebSocketLoader,
      enableWorker: false,
    });
    expect(livePreviewConfig(true)).toMatchObject({
      customLoader: PreviewWebSocketLoader,
      enableWorker: false,
    });
  });
});
