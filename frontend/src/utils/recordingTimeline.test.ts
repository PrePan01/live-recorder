import { describe, expect, it } from "vitest";
import {
  previewPosition,
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
