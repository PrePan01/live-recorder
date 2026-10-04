import { describe, expect, it, vi } from "vitest";
import { seekPlaybackConfig } from "./seekPlaybackConfig";

describe("回看音频时间戳缺口", () => {
  it("用实际 mpegts 解封装实现验证一小时 AAC 缺口不会生成数十万帧或栈溢出", async () => {
    vi.stubGlobal("self", {
      navigator: {
        userAgent:
          "Mozilla/5.0 AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15",
      },
    });
    try {
      // @ts-expect-error mpegts 的内部 JS 解封装器未公开类型，只在此回归测试中直接喂样本。
      const { default: Remuxer } =
        await import("../../node_modules/mpegts.js/src/remux/mp4-remuxer.js");
      const remux = new Remuxer(seekPlaybackConfig);
      // 最小媒体元数据，直接喂样本以隔离 AAC 时间戳缺口处理。
      remux._dtsBase = 0;
      remux._dtsBaseInited = true;
      remux._audioMeta = {
        id: 2,
        codec: "mp4a.40.2",
        originalCodec: "mp4a.40.2",
        refSampleDuration: (1024 / 48000) * 1000,
        channelCount: 2,
      };
      const emitted = vi.fn();
      remux.onMediaSegment = emitted;
      const batch = (time: number) => ({
        id: 2,
        sequenceNumber: 0,
        length: 3,
        samples: [
          { unit: new Uint8Array([1, 2, 3]), length: 3, dts: time, pts: time },
        ],
      });
      remux._remuxAudio(batch(0), true);
      expect(() => remux._remuxAudio(batch(3_600_000), true)).not.toThrow();
      expect(emitted).toHaveBeenCalledTimes(2);
      expect(emitted.mock.calls[1][1].sampleCount).toBe(1);
      remux.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
