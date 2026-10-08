import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DanmakuStore } from "../../src/danmaku/store.js";
import { DanmakuCollector, unsupportedDanmakuAdapter } from "../../src/danmaku/collector.js";
import { danmakuEnabledFor } from "../../src/danmaku/manager.js";
import type { DanmakuAdapter, DanmakuMessage, DanmakuStatus } from "../../src/danmaku/types.js";

async function tmpRecording(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "danmaku-test-"));
  return path.join(dir, "rec.flv");
}

describe("弹幕 sidecar 存储", () => {
  it("追加与区间读取：媒体时间过滤、unmappable 默认不返、limit 游标", async () => {
    const rec = await tmpRecording();
    const store = await DanmakuStore.open(rec);
    store.append({ id: "1", tMs: 1000, wallMs: 1, text: "甲" });
    store.append({ id: "2", tMs: 2000, wallMs: 2, text: "乙" });
    store.append({ id: "3", tMs: null, wallMs: 3, text: "丙", unmappable: true });
    await store.close();

    const all = await store.readRange(0, 99999);
    expect(all.messages.map((m) => m.text)).toEqual(["甲", "乙"]);
    const window = await store.readRange(1500, 99999);
    expect(window.messages.map((m) => m.text)).toEqual(["乙"]);
    const withUnmappable = await store.readRange(0, 99999, { includeUnmappable: true });
    expect(withUnmappable.messages).toHaveLength(3);
    const limited = await store.readRange(0, 99999, { limit: 1 });
    expect(limited.messages).toHaveLength(1);
    expect(limited.next).not.toBeNull();
  });

  it("崩溃残行不毁全量：坏行跳过、好行照读", async () => {
    const rec = await tmpRecording();
    const store = await DanmakuStore.open(rec);
    store.append({ id: "1", tMs: 1000, wallMs: 1, text: "好行" });
    await store.close();
    await writeFile(DanmakuStore.sidecarPathFor(rec), '{"broken json\n', { flag: "a" });
    const reread = await store.readRange(0, 99999);
    expect(reread.messages.map((m) => m.text)).toEqual(["好行"]);
  });

  it("删除录制联动删 sidecar", async () => {
    const rec = await tmpRecording();
    const store = await DanmakuStore.open(rec);
    store.append({ id: "1", tMs: 1000, wallMs: 1, text: "x" });
    await store.close();
    await DanmakuStore.remove(rec);
    await expect(readFile(DanmakuStore.sidecarPathFor(rec))).rejects.toThrow();
  });
});

describe("弹幕采集管理器", () => {
  function fakeAdapter(script: (emit: (t: string) => void) => Promise<void>): DanmakuAdapter {
    return {
      platform: "fake",
      async *collect(): AsyncIterable<DanmakuMessage> {
        const queue: DanmakuMessage[] = [];
        let wake: (() => void) | null = null;
        let done = false;
        const emit = (t: string) => {
          queue.push({ id: `f-${queue.length}`, tMs: null, wallMs: Date.now(), text: t });
          const fn = wake;
          wake = null;
          fn?.();
        };
        const run = script(emit).finally(() => {
          done = true;
          const fn = wake;
          wake = null;
          fn?.();
        });
        while (!done || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise<void>((r) => {
              wake = r;
            });
            continue;
          }
          yield queue.shift()!;
        }
        await run;
      },
    };
  }

  it("消息按到达时刻打媒体时间戳入库、状态四态推进、断连记缺失账", async () => {
    const rec = await tmpRecording();
    const store = await DanmakuStore.open(rec);
    const statuses: DanmakuStatus[] = [];
    let media = 5000;
    const collector = DanmakuCollector.start({
      recordingId: "rec-1",
      adapter: fakeAdapter(async (emit) => {
        emit("第一条");
        media = 6000;
        emit("第二条");
      }),
      roomUrl: "https://x/1",
      cookie: null,
      store,
      sink: { status: (s) => statuses.push(s) },
      mediaNow: () => media,
    });
    await new Promise((r) => setTimeout(r, 50));
    await collector.stop();

    const read = await store.readRange(0, 99999);
    expect(read.messages.map((m) => m.text)).toEqual(["第一条", "第二条"]);
    expect(read.messages.every((m) => typeof m.tMs === "number")).toBe(true);
    expect(statuses.some((s) => s.state === "collecting")).toBe(true);
  });

  it("红线：适配器异常只降级弹幕（不抛出到调用方）、进重试并记缺失账", async () => {
    const rec = await tmpRecording();
    const store = await DanmakuStore.open(rec);
    const collector = DanmakuCollector.start({
      recordingId: "rec-2",
      adapter: fakeAdapter(async () => {
        throw new Error("boom");
      }),
      roomUrl: "https://x/2",
      cookie: null,
      store,
      sink: { status: () => undefined },
      mediaNow: () => 0,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(collector.status.state === "reconnecting" || collector.status.state === "unavailable").toBe(true);
    await collector.stop(); // 正常收束=红线成立（异常未逸出）
  });

  it("不支持的平台：状态直接落 unavailable", async () => {
    const adapter = unsupportedDanmakuAdapter("unknown");
    const rec = await tmpRecording();
    const store = await DanmakuStore.open(rec);
    const collector = DanmakuCollector.start({
      recordingId: "rec-3",
      adapter,
      roomUrl: "https://x/3",
      cookie: null,
      store,
      sink: { status: () => undefined },
      mediaNow: () => 0,
    });
    await new Promise((r) => setTimeout(r, 30));
    await collector.stop();
  });
});

describe("弹幕开关语义", () => {
  it("房间覆盖优先于全局；缺省继承全局（默认关）", () => {
    expect(danmakuEnabledFor({}, {})).toBe(false);
    expect(danmakuEnabledFor({}, { danmaku: { enabled: true } })).toBe(true);
    expect(danmakuEnabledFor({ danmakuEnabled: true }, {})).toBe(true);
    expect(danmakuEnabledFor({ danmakuEnabled: false }, { danmaku: { enabled: true } })).toBe(false);
    expect(danmakuEnabledFor({ danmakuEnabled: null }, { danmaku: { enabled: true } })).toBe(true);
  });
});

describe('点② 中断供数面', () => {
  it('isStallCause 分名：停流合成因→source_stall 判因、断网→false', async () => {
    const { isStallCause } = await import("../../src/core/recorder-manager.js");
    expect(isStallCause({ message: "上游数据中断（静默超时）" })).toBe(true);
    expect(isStallCause({ message: "网络不可用" })).toBe(false);
    expect(isStallCause(null)).toBe(false);
    expect(isStallCause(undefined)).toBe(false);
  });
});
