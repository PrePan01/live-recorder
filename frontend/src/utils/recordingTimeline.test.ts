import { describe, expect, it } from "vitest";
import {
  previewPosition,
  recordingTimelineEnd,
  recordingSeekTarget,
  rangeAtSecond,
  timelinePercent,
  timelineSecondAt,
} from "./recordingTimeline";

describe("录制时间轴的位置来源", () => {
  it("返回直播后定位已录尾部，不使用固定选区结束位置", () => {
    expect(previewPosition("live", 95, 35)).toBe(95);
    expect(timelinePercent(95, 120)).toBeCloseTo(79.1667);
  });

  it("直播尾部随录制增长，而选区边界保持不动", () => {
    expect(previewPosition("live", 100, undefined)).toBe(100);
  });

  it("加载回看期间保留直播位置，首帧就绪后使用新位置", () => {
    expect(previewPosition("live", 105, 100, true)).toBe(100);
    expect(previewPosition("history", 105, 25, false)).toBe(25);
  });

  it("回看切回直播加载时保持原位置，就绪后移到直播尾部", () => {
    expect(previewPosition("history", 105, 25, true)).toBe(25);
    expect(previewPosition("live", 105, 25, false)).toBe(105);
  });

  it("拖动左右手柄不影响视频位置来源", () => {
    expect(previewPosition("history", 95, 80)).toBe(80);
    expect(previewPosition("live", 95, undefined)).toBe(95);
  });

  it("松手后跟随新回看位置，并限制在已录范围", () => {
    expect(previewPosition("history", 95, 25)).toBe(25);
    expect(previewPosition("history", 95, 30.5)).toBe(30.5);
    expect(previewPosition("history", 95, 110)).toBe(95);
  });

  it("轨道未提供预览模式时不显示指示", () => {
    expect(previewPosition(undefined, 95, 40)).toBeUndefined();
  });
});

describe("指针与绘制坐标使用相同的轨道内部宽度", () => {
  it.each([426, 732])(
    "宽度 %s：秒数与百分比往返一致，边框不引入偏移",
    (width) => {
      const contentLeft = 22;
      for (const second of [0, 20, 65, 95]) {
        const x = contentLeft + (width * timelinePercent(second, 120)) / 100;
        expect(timelineSecondAt(x, contentLeft, width, 120, 95)).toBe(second);
      }
    },
  );

  it("超出轨道或进入未录制区域时钳制到有效范围", () => {
    expect(timelineSecondAt(-100, 22, 426, 120, 95)).toBe(0);
    expect(timelineSecondAt(1000, 22, 426, 120, 95)).toBe(95);
  });

  it("选区提交计算不影响仍在播放的视频位置", () => {
    const moved = rangeAtSecond([20, 80], "start", 30, 95);
    const released = rangeAtSecond(moved, "start", 45, 95);
    expect(released).toEqual([45, 80]);
    expect(previewPosition("history", 95, 70)).toBe(70);
    expect(rangeAtSecond([20, 80], "start", 90, 95)).toEqual([79, 80]);
    expect(rangeAtSecond([20, 80], "end", 10, 95)).toEqual([20, 21]);
  });
});

describe("文件回放轨道与录制轨道的交互区别", () => {
  it("短视频和带小数的片尾使用真实时长，录制模式继续跨分钟扩展", () => {
    expect(recordingTimelineEnd(28.995, "playback")).toBe(28.995);
    expect(recordingTimelineEnd(28.995, "recording")).toBe(60);
    expect(recordingTimelineEnd(95, "recording")).toBe(120);
    expect(recordingTimelineEnd(95, "playback")).toBe(95);
    expect(recordingTimelineEnd(0, "playback")).toBe(0);
  });

  it("文件片尾是有效跳播秒数，录制片尾仍返回直播", () => {
    for (const point of [28.995, 30, 100]) {
      expect(recordingSeekTarget("playback", "playhead", point, 28.995)).toBe(
        28.995,
      );
      expect(recordingSeekTarget("recording", "playhead", point, 28.995)).toBe(
        "live",
      );
    }
    expect(recordingSeekTarget("playback", "playhead", -5, 28.995)).toBe(0);
    expect(recordingSeekTarget("playback", "playhead", 12.5, 28.995)).toBe(
      12.5,
    );
  });

  it("文件选区手柄不提交播放定位，录制模式保留手柄跳播", () => {
    for (const kind of ["start", "end"] as const) {
      expect(recordingSeekTarget("playback", kind, 20, 95)).toBeUndefined();
      expect(recordingSeekTarget("recording", kind, 20, 95)).toBe(20);
    }
    expect(recordingSeekTarget("recording", "end", 95, 95)).toBe("live");
  });

  it("视频不可定位时忽略提交，包括未就绪、错误和非法时间", () => {
    expect(
      recordingSeekTarget("playback", "playhead", 20, 95, true),
    ).toBeUndefined();
    for (const duration of [0, -1, NaN, Infinity]) {
      expect(
        recordingSeekTarget("playback", "playhead", 20, duration),
      ).toBeUndefined();
    }
    expect(
      recordingSeekTarget("playback", "playhead", NaN, 95),
    ).toBeUndefined();
  });

  it("文件轨道右端准确对应带小数的片尾，游标随媒体时间而非选区", () => {
    const end = recordingTimelineEnd(28.995, "playback");
    expect(timelineSecondAt(448, 22, 426, end, end)).toBe(end);
    expect(timelinePercent(end, end)).toBe(100);
    expect(previewPosition("history", end, 21.5)).toBe(21.5);
    expect(rangeAtSecond([0, end], "end", 15, end)).toEqual([0, 15]);
    expect(previewPosition("history", end, 21.5)).toBe(21.5);
  });
});
