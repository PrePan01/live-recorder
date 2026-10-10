import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from 'node:path';
import { describe, expect, it } from "vitest";
import {
  StreamRecordingEngine,
  FlvTimestampNormalizer,
  parseM3u8,
  hlsPollIntervalMs,
} from "../../src/recorder/stream-recorder.js";
import { buildMinimalFlv } from "../../src/platform/fake-adapter.js";

function chunksBody(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function endlessBody(): ReadableStream<Uint8Array> {
  let count = 0;
  const flv = buildMinimalFlv();
  return new ReadableStream({
    pull(controller) {
      controller.enqueue(count++ === 0 ? flv : flv.subarray(13));
      if (count > 100_000) controller.close();
    },
  });
}

function mockFetch(
  status: number,
  body: () => ReadableStream<Uint8Array>,
): typeof fetch {
  return async () => new Response(body(), { status }) as unknown as Response;
}

describe("StreamRecordingEngine (HTTP)", () => {
  it("samples raw network chunks before FLV normalization, including incomplete data", async () => {
    const flv = buildMinimalFlv();
    const chunks = [flv.subarray(0, 5), flv.subarray(5), Buffer.from([9, 0, 0])];
    const engine = new StreamRecordingEngine(mockFetch(200, () => chunksBody(chunks)));
    const received: number[] = [];
    engine.setDownloadObserver(bytes => received.push(bytes));
    for await (const _event of engine.start({ url: "https://example.test/live.flv", format: "flv" }, null)) {
      // Drain the stream; sampling must include bytes that never become complete FLV tags.
    }
    expect(received).toEqual(chunks.map(chunk => chunk.length));
  });

  it("samples HLS playlist and segment downloads without recounting staged data", async () => {
    const playlist = "#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST\n";
    const segment = Buffer.alloc(188, 0x47);
    const fetcher = (async (url: string | URL | Request) => new Response(
      String(url).endsWith("segment.ts") ? segment : playlist,
    )) as typeof fetch;
    const engine = new StreamRecordingEngine(fetcher);
    let received = 0;
    engine.setDownloadObserver(bytes => { received += bytes; });
    for await (const _event of engine.start({ url: "https://example.test/live.m3u8", format: "hls" }, null)) {
      // Drain the stream through HLS staging and replay.
    }
    expect(received).toBe(Buffer.byteLength(playlist) + segment.length);
  });

  it("writes the stream to disk and yields data/completed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-engine-"));
    const out = path.join(dir, "a.flv");
    // 合法 FLV：头 + onMetaData + 一个视频 tag（#181：截断/非法尾部不再写入）。
    const header = Buffer.concat([
      Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]),
      Buffer.alloc(4),
    ]);
    const makeTag = (type: number, ts: number, data: Buffer): Buffer => {
      const head = Buffer.alloc(11);
      head[0] = type;
      head.writeUIntBE(data.length, 1, 3);
      head[4] = (ts >> 16) & 0xff;
      head[5] = (ts >> 8) & 0xff;
      head[6] = ts & 0xff;
      head[7] = (ts >> 24) & 0xff;
      return Buffer.concat([head, data]);
    };
    const prevSize = (t: Buffer): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(t.length);
      return b;
    };
    const meta = makeTag(
      0x12,
      0,
      Buffer.from([0x02, 0x00, 0x0a, ...Buffer.from("onMetaData")]),
    );
    const v1 = makeTag(
      0x09,
      40,
      Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    );
    const full = Buffer.concat([
      header,
      meta,
      prevSize(meta),
      v1,
      prevSize(v1),
    ]);
    // 拆块喂入，模拟网络分片。
    const chunks: Buffer[] = [];
    for (let i = 0; i < full.length; i += 5)
      chunks.push(full.subarray(i, i + 5));
    const engine = new StreamRecordingEngine(
      mockFetch(200, () => chunksBody(chunks)),
    );
    const events: string[] = [];
    let bytes = 0;
    let fileSize = 0;
    for await (const ev of engine.start(
      {
        url: "https://x.com/live.flv",
        format: "flv",
        headers: { Referer: "https://x.com" },
      },
      out,
    )) {
      events.push(ev.type);
      if (ev.type === "data") bytes += ev.chunk.length;
      if (ev.type === "completed") fileSize = ev.fileSize;
    }
    // 归一化按完整标签分批输出；完整 FLV 全部落盘。
    expect(events[0]).toBe("file_created");
    expect(events[events.length - 1]).toBe("completed");
    expect(events.filter((e) => e === "data").length).toBeGreaterThan(0);
    expect(bytes).toBe(full.length);
    expect(fileSize).toBe(bytes);
    const onDisk = await readFile(out);
    expect(onDisk.subarray(0, 3).toString()).toBe("FLV");
    expect(onDisk.length).toBe(bytes);
  });

  it("yields NETWORK_UNAVAILABLE for a failed fetch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-engine-"));
    const out = path.join(dir, "b.flv");
    const engine = new StreamRecordingEngine(
      mockFetch(404, () => new ReadableStream()),
    );
    const events: string[] = [];
    for await (const ev of engine.start(
      { url: "https://x.com/404.flv", format: "flv" },
      out,
    )) {
      events.push(ev.type);
      if (ev.type === "error")
        expect(ev.error.code).toBe("NETWORK_UNAVAILABLE");
    }
    expect(events).toEqual(["error"]);
  });

  it("honors stop() mid-stream and keeps the file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-engine-"));
    const out = path.join(dir, "c.flv");
    const engine = new StreamRecordingEngine(mockFetch(200, endlessBody));
    let received = 0;
    let stopRequested = false;
    const run = async () => {
      for await (const ev of engine.start(
        { url: "https://x.com/live.flv", format: "flv" },
        out,
      )) {
        if (ev.type === "data") received += 1;
        if (received === 2) {
          stopRequested = true;
          await engine.stop();
        }
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run(),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error("timeout")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await engine.stop();
    }
    expect(stopRequested).toBe(true);
    const info = await stat(out);
    expect(info.size).toBeGreaterThan(0);
  });

  it("aborts and reports a retryable interruption when the stream stalls after the first bytes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-engine-"));
    const out = path.join(dir, "stall.flv");
    const flv = buildMinimalFlv();
    // 前两次喂入数据，之后既不关闭也不吐字节：模拟 CDN 挂住连接（以前会永远卡在这里）。
    let served = 0;
    const stalling = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (served < 2)
          controller.enqueue(served++ === 0 ? flv : flv.subarray(13));
      },
    });
    const engine = new StreamRecordingEngine(
      mockFetch(200, () => stalling),
      40,
    );
    const events: string[] = [];
    let code = "";
    for await (const ev of engine.start(
      { url: "https://x.com/live.flv", format: "flv" },
      out,
    )) {
      events.push(ev.type);
      if (ev.type === "error") code = ev.error.code;
    }
    expect(events).toContain("data");
    expect(events[events.length - 1]).toBe("error");
    // 必须是可重试的网络中断，上层才会进入续录而不是判死。
    expect(code).toBe("NETWORK_UNAVAILABLE");
    expect((await stat(out)).size).toBeGreaterThan(0);
  });

  it("passes request headers through", async () => {
    let seenHeaders: Record<string, string> | undefined;
    const dir = await mkdtemp(path.join(tmpdir(), "lr-engine-"));
    const out = path.join(dir, "d.flv");
    const stub: typeof fetch = async (input, init) => {
      seenHeaders = init?.headers as Record<string, string>;
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
      }) as unknown as Response;
    };
    const engine = new StreamRecordingEngine(stub);
    for await (const ev of engine.start(
      {
        url: "https://x.com/live.flv",
        format: "flv",
        headers: { Cookie: "a=b", "User-Agent": "ua" },
      },
      out,
    )) {
      void ev;
    }
    expect(seenHeaders).toEqual({ Cookie: "a=b", "User-Agent": "ua" });
  });

  it("rewrites absolute PTS to relative so duration is correct (抖音: 序列头 ts≈0 + 媒体绝对 PTS)", async () => {
    // 抖音真实结构：AVC/AAC 序列头 ts≈0，媒体帧为绝对 PTS（2822850 起）。
    const header = Buffer.concat([
      Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]),
      Buffer.alloc(4),
    ]);
    const makeTag = (type: number, ts: number, data: Buffer): Buffer => {
      const head = Buffer.alloc(11);
      head[0] = type;
      head.writeUIntBE(data.length, 1, 3);
      head[4] = (ts >> 16) & 0xff;
      head[5] = (ts >> 8) & 0xff;
      head[6] = ts & 0xff;
      head[7] = (ts >> 24) & 0xff;
      return Buffer.concat([head, data]);
    };
    const prevSize = (t: Buffer): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(t.length);
      return b;
    };
    const meta = makeTag(
      0x12,
      0,
      Buffer.from([0x02, 0x00, 0x0a, ...Buffer.from("onMetaData")]),
    );
    const aSeq = makeTag(0x08, 0, Buffer.from([0xaf, 0x00, 0x01])); // AAC 序列头 ts=0
    const vSeq = makeTag(0x09, 0, Buffer.from([0x17, 0x00, 0x01, 0x02])); // AVC 序列头 ts=0
    const a1 = makeTag(
      0x08,
      2_822_850,
      Buffer.from([0xaf, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ); // AAC 媒体
    const v1 = makeTag(
      0x09,
      2_822_866,
      Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ); // AVC 关键帧媒体
    const v2 = makeTag(
      0x09,
      2_822_900,
      Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    ); // AVC 媒体
    const stream = Buffer.concat([
      header,
      meta,
      prevSize(meta),
      aSeq,
      prevSize(aSeq),
      vSeq,
      prevSize(vSeq),
      a1,
      prevSize(a1),
      v1,
      prevSize(v1),
      v2,
      prevSize(v2),
    ]);

    const dir = await mkdtemp(path.join(tmpdir(), "lr-engine-"));
    const out = path.join(dir, "norm.flv");
    // 逐 3 字节喂入，强制标签跨 chunk 边界，验证流式归一化稳健。
    const tiny: Uint8Array[] = [];
    for (let i = 0; i < stream.length; i += 3)
      tiny.push(stream.subarray(i, i + 3));
    const engine = new StreamRecordingEngine(
      mockFetch(200, () => chunksBody(tiny)),
    );
    for await (const ev of engine.start(
      { url: "https://x.com/live.flv", format: "flv" },
      out,
    )) {
      void ev;
    }
    const outBuf = await readFile(out);
    expect(outBuf.length).toBe(stream.length);

    // 解析输出：序列头不参与 base；音视频共用时间基准，保留视频比音频晚 16ms 的相对偏移。
    const tsByType: Record<string, number[]> = { "8": [], "9": [] };
    let off = 13;
    while (off + 11 <= outBuf.length) {
      const type = outBuf[off]!;
      const ds = outBuf.readUIntBE(off + 1, 3);
      const len = 11 + ds + 4;
      if (off + len > outBuf.length) break;
      if (type === 8 || type === 9) {
        tsByType[String(type)]!.push(
          (outBuf[off + 4]! << 16) |
            (outBuf[off + 5]! << 8) |
            outBuf[off + 6]! |
            ((outBuf[off + 7]! & 0xff) << 24),
        );
      }
      off += len;
    }
    // 音频：序列头 0（保留）+ 首个媒体归零 → [0, 0]
    expect(tsByType["8"]).toEqual([0, 0]);
    // 视频：序列头 0 + 关键帧 16 + 后续帧 50
    expect(tsByType["9"]).toEqual([0, 16, 50]);
  });

  it("starts near-zero media at zero while preserving frame spacing", async () => {
    const header = Buffer.concat([
      Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]),
      Buffer.alloc(4),
    ]);
    const makeTag = (type: number, ts: number, data: Buffer): Buffer => {
      const head = Buffer.alloc(11);
      head[0] = type;
      head.writeUIntBE(data.length, 1, 3);
      head[4] = (ts >> 16) & 0xff;
      head[5] = (ts >> 8) & 0xff;
      head[6] = ts & 0xff;
      head[7] = (ts >> 24) & 0xff;
      return Buffer.concat([head, data]);
    };
    const prevSize = (t: Buffer): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(t.length);
      return b;
    };
    const meta = makeTag(
      0x12,
      0,
      Buffer.from([0x02, 0x00, 0x0a, ...Buffer.from("onMetaData")]),
    );
    const v1 = makeTag(
      0x09,
      40,
      Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    );
    const v2 = makeTag(
      0x09,
      80,
      Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    );
    const stream = Buffer.concat([
      header,
      meta,
      prevSize(meta),
      v1,
      prevSize(v1),
      v2,
      prevSize(v2),
    ]);

    const dir = await mkdtemp(path.join(tmpdir(), "lr-engine-"));
    const out = path.join(dir, "keep.flv");
    const tiny: Uint8Array[] = [];
    for (let i = 0; i < stream.length; i += 3)
      tiny.push(stream.subarray(i, i + 3));
    const engine = new StreamRecordingEngine(
      mockFetch(200, () => chunksBody(tiny)),
    );
    for await (const ev of engine.start(
      { url: "https://x.com/live.flv", format: "flv" },
      out,
    )) {
      void ev;
    }
    const outBuf = await readFile(out);
    const vts: number[] = [];
    let off = 13;
    while (off + 11 <= outBuf.length) {
      const type = outBuf[off]!;
      const ds = outBuf.readUIntBE(off + 1, 3);
      const len = 11 + ds + 4;
      if (off + len > outBuf.length) break;
      if (type === 9)
        vts.push(
          (outBuf[off + 4]! << 16) |
            (outBuf[off + 5]! << 8) |
            outBuf[off + 6]! |
            ((outBuf[off + 7]! & 0xff) << 24),
        );
      off += len;
    }
    // 以首个媒体帧归零，保留 40ms 的真实帧间距。
    expect(vts).toEqual([0, 40]);
  });

  it("drops the truncated tail tag so the file ends cleanly (偶现损坏 #181 根因)", async () => {
    // 构造合法 FLV + 一个完整视频 tag + 一个被截断的尾部视频 tag（录制中途停止的典型形态）。
    const header = Buffer.concat([
      Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09]),
      Buffer.alloc(4),
    ]);
    const makeTag = (type: number, ts: number, data: Buffer): Buffer => {
      const head = Buffer.alloc(11);
      head[0] = type;
      head.writeUIntBE(data.length, 1, 3);
      head[4] = (ts >> 16) & 0xff;
      head[5] = (ts >> 8) & 0xff;
      head[6] = ts & 0xff;
      head[7] = (ts >> 24) & 0xff;
      return Buffer.concat([head, data]);
    };
    const prevSize = (t: Buffer): Buffer => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(t.length);
      return b;
    };
    const meta = makeTag(
      0x12,
      0,
      Buffer.from([0x02, 0x00, 0x0a, ...Buffer.from("onMetaData")]),
    );
    const v1 = makeTag(
      0x09,
      40,
      Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    );
    // 截断尾部：声明 size=100 但只给 30 字节 body（不完整）。
    const v2Head = Buffer.alloc(11);
    v2Head[0] = 0x09;
    v2Head.writeUIntBE(100, 1, 3);
    v2Head[4] = (80 >> 16) & 0xff;
    v2Head[5] = (80 >> 8) & 0xff;
    v2Head[6] = 80 & 0xff;
    const v2Partial = Buffer.concat([v2Head, Buffer.alloc(30)]);
    const stream = Buffer.concat([
      header,
      meta,
      prevSize(meta),
      v1,
      prevSize(v1),
      v2Partial,
    ]);

    const dir = await mkdtemp(path.join(tmpdir(), "lr-engine-"));
    const out = path.join(dir, "tail.flv");
    // 一次性喂入（不拆小块，让引擎在收尾时才遇到截断尾）。
    const engine = new StreamRecordingEngine(
      mockFetch(200, () => chunksBody([stream])),
    );
    for await (const ev of engine.start(
      { url: "https://x.com/live.flv", format: "flv" },
      out,
    )) {
      void ev;
    }
    const outBuf = await readFile(out);
    // 输出文件应只含完整标签：完整 video tag 结束即止，不包含截断尾。
    let off = 13;
    let tags = 0;
    while (off + 11 <= outBuf.length) {
      const ds = outBuf.readUIntBE(off + 1, 3);
      const len = 11 + ds + 4;
      if (off + len > outBuf.length) break;
      tags += 1;
      off += len;
    }
    expect(tags).toBe(2); // meta + v1（截断的 v2 被丢弃）
    expect(off).toBe(outBuf.length); // 文件在完整标签边界结束，无残余
  });

  it("EIO 兑底：写盘失败转为流程内抛错（真实原因），绝不裸抛 unhandled error 崩进程", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-engine-eio-"));
    const blocker = path.join(dir, "blocker");
    await writeFile(blocker, "x");
    const out = path.join(blocker, "a.flv"); // 父级是普通文件：打开必失败（模拟磁盘不可用/EIO）
    const flv = buildMinimalFlv();
    let count = 0;
    const slowBody = (): ReadableStream<Uint8Array> =>
      new ReadableStream({
        async pull(controller) {
          await new Promise((r) => setTimeout(r, 5));
          controller.enqueue(count++ === 0 ? flv : flv.subarray(13));
          if (count > 30) controller.close();
        },
      });
    const engine = new StreamRecordingEngine(mockFetch(200, slowBody));
    const events: Array<{
      type: string;
      error?: { code: string; message?: string; retryable?: boolean };
    }> = [];
    for await (const ev of engine.start(
      { url: "https://x.com/live.flv", format: "flv" },
      out,
    )) {
      events.push(ev);
    }
    // 修复前：写盘错误裸抛成 unhandled 'error' 事件把进程打崩（09-29 事故）。
    // 修复后：错误沿写路径抛回流程并归因成 error 事件（上层停该场、保文件、原因上屏）。
    const errEvent = events.find((e) => e.type === "error");
    expect(errEvent).toBeTruthy();
    expect(errEvent!.error!.code).toBe("RECORDING_WRITE_FAILED");
    expect(errEvent!.error!.retryable).toBe(false);
    expect(String(errEvent!.error!.message)).toMatch(
      /ENOTDIR|ENOENT|EISDIR|not a directory|no such file/i,
    );
  });
});

describe("StreamRecordingEngine (HLS)", () => {
  it("downloads playlist segments and concatenates them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-hls-"));
    const out = path.join(dir, "e.ts");
    const segs: Record<string, Uint8Array> = {
      "https://x.com/seg0.ts": new Uint8Array([0x47, 0x01, 0x02]),
      "https://x.com/seg1.ts": new Uint8Array([0x47, 0x03, 0x04]),
    };
    const stub: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("playlist")) {
        return new Response(
          "#EXTM3U\n#EXT-X-ENDLIST\n#EXTINF:4,\nhttps://x.com/seg0.ts\n#EXTINF:4,\nhttps://x.com/seg1.ts\n",
          { status: 200 },
        ) as unknown as Response;
      }
      return new Response(segs[url]!, { status: 200 }) as unknown as Response;
    };
    const engine = new StreamRecordingEngine(stub);
    let bytes = 0;
    for await (const ev of engine.start(
      { url: "https://x.com/playlist.m3u8", format: "hls" },
      out,
    )) {
      if (ev.type === "data") bytes += ev.chunk.length;
    }
    expect(bytes).toBe(6);
    const onDisk = await readFile(out);
    expect(onDisk.length).toBe(6);
    expect(onDisk.subarray(0, 1)[0]).toBe(0x47);
  });
});
describe("#226 HLS 轮询间隔自适应", () => {
  it("parseM3u8 解析目标分片时长", () => {
    const m3u =
      "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nhttps://x/seg1.ts\n#EXT-X-ENDLIST\n";
    const parsed = parseM3u8(m3u, "https://x/");
    expect(parsed.targetDuration).toBe(2);
    expect(parsed.ended).toBe(true);
    expect(parsed.segments).toEqual(["https://x/seg1.ts"]);
  });

  it("hlsPollIntervalMs 按目标时长自适应（2s→1.6s，4s→3s，未知→3s）", () => {
    expect(hlsPollIntervalMs(2)).toBe(1600);
    expect(hlsPollIntervalMs(1)).toBe(1000);
    expect(hlsPollIntervalMs(4)).toBe(3000);
    expect(hlsPollIntervalMs(null)).toBe(3000);
  });
});

describe('断流立即重试·代证用例（HLS 停流 + 涓流判据双面）', () => {
  it('③ HLS 停流看门狗：分片静默超阈 → 收束报错交上层断流重连（不再裸奔）', async () => {
    const { StreamRecordingEngine } = await import("../../src/recorder/stream-recorder.js");
    // 伪 fetcher：首个清单正常、分片请求永久挂起（模拟 CDN 挂连接不吐数据）
    const fakeFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(".m3u8")) {
        return Promise.resolve(
          new Response("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n"),
        );
      }
      // 挂起的分片请求：真实 fetch 在 abort 时会 reject——伪实现必须同样听 signal。
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;
    const engine = new StreamRecordingEngine(fakeFetch, 80); // 80ms 停流阈值（测试缩时）
    const dir = await mkdtemp(path.join(tmpdir(), "lr-hls-stall-"));
    const events: string[] = [];
    const errors: string[] = [];
    const t0 = Date.now();
    for await (const ev of engine.start(
      { url: "https://x/live.m3u8", format: "hls" },
      path.join(dir, "a.ts"),
    )) {
      events.push(ev.type);
      if (ev.type === "error") { errors.push(ev.error.code); expect(ev.error.retryable).toBe(true); }
    }
    const elapsed = Date.now() - t0;
    // 看门狗必须在阈值附近收束（远小于旧 30s 语义），且不会挂死
    expect(elapsed).toBeLessThan(3000);
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(errors).toEqual(["NETWORK_UNAVAILABLE"]);
    expect(events).not.toContain("completed");
  });
});

describe('断流立即重试·阈值与链语义钉', () => {
  it('零等待首试+退避链封顶：链首 0 秒（判定即试）、递增、30 秒封顶', async () => {
    const { RECONNECT_CHAIN_SEC, GAP_ROW_MIN_MS, RECONNECT_ALERT_AFTER_MS } =
      await import("../../src/core/recorder-manager.js");
    expect(RECONNECT_CHAIN_SEC[0]).toBe(0);            // 判定即首试零等待
    for (let i = 1; i < RECONNECT_CHAIN_SEC.length; i += 1) {
      expect(RECONNECT_CHAIN_SEC[i]!).toBeGreaterThanOrEqual(RECONNECT_CHAIN_SEC[i - 1]!);
    }
    expect(Math.max(...RECONNECT_CHAIN_SEC)).toBe(30); // 30s 封顶
    expect(GAP_ROW_MIN_MS).toBe(0);               // 缺口条目门槛=30s（时长不丢秒在累计面）
    expect(RECONNECT_ALERT_AFTER_MS).toBe(5 * 60_000); // 持续重连 5 分钟发人话告警
  });
});

describe("media progress watchdog", () => {
  function liveFetch(frozen: boolean): typeof fetch {
    return (async (_url, init) => {
      let tick = 0;
      let cancelled = false;
      let timer: ReturnType<typeof setInterval>;
      const tag = (ts: number) => {
        const b = Buffer.alloc(16);
        b[0] = 9; b.writeUIntBE(1, 1, 3); b.writeUIntBE(ts, 4, 3);
        b[11] = 0x12; b.writeUInt32BE(12, 12); return b;
      };
      return new Response(new ReadableStream({
        start(c) {
          c.enqueue(Buffer.concat([Buffer.from([70,76,86,1,1,0,0,0,9,0,0,0,0]), tag(0)]));
          timer = setInterval(() => c.enqueue(tag(frozen ? 0 : ++tick * 10)), 10);
          init?.signal?.addEventListener("abort", () => { clearInterval(timer); if (!cancelled) c.close(); }, { once: true });
        },
        cancel() { cancelled = true; clearInterval(timer); },
      }));
    }) as typeof fetch;
  }

  it("interrupts a recording whose bytes keep arriving with frozen timestamps", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-frozen-"));
    const engine = new StreamRecordingEngine(liveFetch(true), 60);
    const errors: string[] = [];
    const guard = setTimeout(() => void engine.stop(), 1500);
    try {
      for await (const ev of engine.start({url: "https://x/live.flv", format: "flv"}, path.join(dir, "a.flv"))) {
        if (ev.type === "error") errors.push(ev.error.code);
      }
      expect(errors).toEqual(["NETWORK_UNAVAILABLE"]);
      expect((await stat(path.join(dir, "a.flv"))).size).toBeGreaterThan(13);
    } finally { clearTimeout(guard); await engine.stop(); }
  });

  it.each([false, true])("keeps healthy recording / byte-active preview alive (preview=%s)", async preview => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-progress-"));
    const engine = new StreamRecordingEngine(liveFetch(preview), 60);
    const errors: string[] = [];
    const stop = setTimeout(() => void engine.stop(), 180);
    try {
      for await (const ev of engine.start({url: "https://x/live.flv", format: "flv"}, preview ? null : path.join(dir, "a.flv"))) {
        if (ev.type === "error") errors.push(ev.error.code);
      }
      expect(errors).toEqual([]);
    } finally { clearTimeout(stop); await engine.stop(); }
  });
});

describe("HLS watchdog cleanup", () => {
  it("does not abort after the final playlist completes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lr-hls-end-"));
    let signal: AbortSignal | null = null;
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? null;
      return new Response("#EXTM3U\n#EXT-X-ENDLIST\n");
    }) as typeof fetch;
    const engine = new StreamRecordingEngine(fetcher, 40);
    const events: string[] = [];
    for await (const ev of engine.start({ url: "https://x/live.m3u8", format: "hls" }, path.join(dir, "a.ts"))) events.push(ev.type);
    await new Promise(r => setTimeout(r, 80));
    expect(events).toContain("completed");
    expect(signal!.aborted).toBe(false);
  });
});

describe('recording and preview timelines', () => {
  const head = Buffer.from([70, 76, 86, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]);
  function media(ts: number): Buffer {
    const tag = Buffer.alloc(21);
    tag[0] = 9; tag.writeUIntBE(6, 1, 3);
    tag.writeUIntBE(ts & 0xffffff, 4, 3); tag[7] = ts >>> 24;
    tag[11] = 0x17; tag[12] = 1;
    tag.writeUInt32BE(17, 17);
    return tag;
  }
  const timestamp = (tag: Buffer) => tag.readUIntBE(4, 3) + tag[7]! * 0x1000000;

  it('appends the file without a second FLV header while preview starts a fresh timeline', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-preview-resume-'));
    const out = path.join(dir, 'a.flv');
    const original = Buffer.concat([head, media(2_400_000)]);
    await writeFile(out, original);
    const input = Buffer.concat([head, media(29), media(69)]);
    const engine = new StreamRecordingEngine(mockFetch(200, () => chunksBody([
      input.subarray(0, 7), input.subarray(7, 30), input.subarray(30),
    ])));
    const previews: Buffer[] = [];
    const disk: Buffer[] = [];
    for await (const event of engine.start({ url: 'https://x/live.flv', format: 'flv' }, out, {
      append: true, timestampOffsetMs: 2_400_000,
    })) {
      if (event.type === 'preview_data') {
        previews.push(event.chunk);
        if (event.recordingOffsetMs != null) expect(event.recordingOffsetMs).toBe(2_400_000);
      }
      if (event.type === 'data') {
        expect(event.previewForwarded).toBe(true);
        disk.push(event.chunk);
      }
    }
    expect(Buffer.concat(previews)).toEqual(Buffer.concat([head, media(0), media(40)]));
    expect(Buffer.concat(disk)).toEqual(Buffer.concat([media(2_400_000), media(2_400_040)]));
    expect(await readFile(out)).toEqual(Buffer.concat([original, ...disk]));
  });

  it.each([0x01020304, 0x81020304])('preserves all timestamp bits for long recordings (offset=%s)', (offset) => {
    const normalizer = new FlvTimestampNormalizer({ offsetMs: offset });
    const parts = normalizer.push(Buffer.concat([head, media(29)]));
    expect(timestamp(parts[1]!)).toBe(offset + 29);
    expect(normalizer.lastTimestampMs).toBe(offset + 29);
    const unsigned = new FlvTimestampNormalizer({ rebaseFromFirstMedia: true });
    const normalized = unsigned.push(Buffer.concat([head, media(offset), media(offset + 40)]));
    expect(timestamp(normalized[1]!)).toBe(0);
    expect(timestamp(normalized[2]!)).toBe(40);
  });
});

describe('recording continuity regressions', () => {
  const head = Buffer.from([70, 76, 86, 1, 5, 0, 0, 0, 9, 0, 0, 0, 0]);
  function tag(ts: number, type = 9, sequence = false): Buffer {
    const b = Buffer.alloc(21); b[0] = type; b.writeUIntBE(6, 1, 3);
    b.writeUIntBE(ts & 0xffffff, 4, 3); b[7] = ts >>> 24;
    b[11] = type === 9 ? 0x17 : 0xaf; b[12] = sequence ? 0 : 1; b.writeUInt32BE(17, 17); return b;
  }
  const ts = (b: Buffer) => b.readUIntBE(4, 3) + b[7]! * 0x1000000;

  it('maps a pre-existing preview clock to a new recording clock exactly', () => {
    const n = new FlvTimestampNormalizer({ rebaseFromFirstMedia: true });
    expect(n.timestampOffsetMs).toBeNull();
    n.push(Buffer.concat([head, tag(0, 9, true), tag(45000), tag(55000)]));
    expect(n.timestampOffsetMs).toBe(-45000);
    expect(55000 + n.timestampOffsetMs!).toBe(n.lastTimestampMs);
  });

  it('preserves audio/video alignment and rebases a source clock reset without unsigned underflow', () => {
    const n = new FlvTimestampNormalizer({ rebaseFromFirstMedia: true });
    const first = n.push(Buffer.concat([head, tag(100000, 8), tag(100020), tag(101000, 8), tag(101020)]));
    expect(first.slice(1).map(ts)).toEqual([0, 20, 1000, 1020]);
    const reset = n.push(Buffer.concat([tag(0, 8), tag(20), tag(1000, 8), tag(1020)]));
    expect(reset.map(ts)).toEqual([1021, 1041, 2021, 2041]);
    expect(n.lastTimestampMs).toBe(2041);
  });

  it('rebases resumed media and timestamps codec configuration at the splice', () => {
    const n = new FlvTimestampNormalizer({ skipHeader: true, offsetMs: 600000 });
    const parts = n.push(Buffer.concat([head, tag(0, 9, true), tag(10000), tag(10040)]));
    expect(parts.map(ts)).toEqual([600000, 600000, 600040]);
  });

  it('does not count a slow event consumer as upstream silence', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-consumer-'));
    const engine = new StreamRecordingEngine(mockFetch(200, () => chunksBody([
      Buffer.concat([head, tag(0)]), tag(40), tag(80),
    ])), 25);
    const errors: string[] = [];
    for await (const event of engine.start({ url: 'https://x/live.flv', format: 'flv' }, path.join(dir, 'a.flv'))) {
      if (event.type === 'data') await new Promise(resolve => setTimeout(resolve, 60));
      if (event.type === 'error') errors.push(event.error.code);
    }
    expect(errors).toEqual([]);
    expect((await readFile(path.join(dir, 'a.flv'))).length).toBe(head.length + 63);
  });

  it.each([false, true])('deduplicates HLS when signed URLs or discontinuity window change (shift=%s)', async (shift) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lr-hls-sequence-'));
    let playlists = 0;
    let segments = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).includes('m3u8')) {
        playlists++;
        return new Response(`#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:123\n#EXT-X-DISCONTINUITY-SEQUENCE:${shift ? playlists : 0}\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\ns.ts?token=${playlists}\n${playlists === 2 ? '#EXT-X-ENDLIST\n' : ''}`);
      }
      segments++; return new Response(new Uint8Array([71, 1, 2]));
    }) as typeof fetch;
    const engine = new StreamRecordingEngine(fetcher);
    for await (const _event of engine.start({ url: 'https://x/a.m3u8', format: 'hls' }, path.join(dir, 'a.ts'))) { /* drain */ }
    expect(segments).toBe(1);
    expect(await readFile(path.join(dir, 'a.ts'))).toEqual(Buffer.from([71, 1, 2]));
  });
});

it('handles repeated audio-only clock resets without moving the healthy video clock', () => {
  const head = Buffer.from([70,76,86,1,5,0,0,0,9,0,0,0,0]);
  const tag = (type: number, ts: number) => {
    const b = Buffer.alloc(21); b[0] = type; b.writeUIntBE(6,1,3); b.writeUIntBE(ts,4,3);
    b[11] = type === 8 ? 0xaf : 0x17; b[12] = 1; b.writeUInt32BE(17,17); return b;
  };
  const n = new FlvTimestampNormalizer({ rebaseFromFirstMedia: true });
  n.push(Buffer.concat([head, tag(8, 100000), tag(9, 100020), tag(8, 101000), tag(9, 101020)]));
  const first = n.push(tag(8, 0))[0]!;
  expect(first.readUIntBE(4,3)).toBe(1021);
  const video = n.push(tag(9, 102020))[0]!;
  expect(video.readUIntBE(4,3)).toBe(2020);
  n.push(tag(8, 2000));
  const second = n.push(tag(8, 0))[0]!;
  expect(second.readUIntBE(4,3)).toBe(3022);
});
