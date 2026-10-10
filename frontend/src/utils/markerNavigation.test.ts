import { describe, expect, it } from "vitest";
import {
  markerClipRange,
  markerNeighbors,
  markerClipName,
} from "./markerNavigation";
import type { RecordingMarker } from "../types/recording";

const markers = [10, 20, 30].map((positionSeconds) => ({
  positionSeconds,
})) as RecordingMarker[];
describe("标记导航", () => {
  it("直播的上一个为最后一个标记，没有下一个", () => {
    expect(markerNeighbors(markers, undefined, true)).toEqual({
      current: -1,
      previous: 2,
      next: -1,
    });
  });
  it("回看正确处理标记间的位置和两端边界", () => {
    expect(markerNeighbors(markers, 15, false)).toEqual({
      current: 0,
      previous: 0,
      next: 1,
    });
    expect(markerNeighbors(markers, 10, false)).toEqual({
      current: 0,
      previous: -1,
      next: 1,
    });
    expect(markerNeighbors(markers, 30, false)).toEqual({
      current: 2,
      previous: 1,
      next: -1,
    });
  });
  it("空列表与未知播放位置不产生跳转目标", () => {
    expect(markerNeighbors([], 10, false)).toEqual({
      current: -1,
      previous: -1,
      next: -1,
    });
    expect(markerNeighbors(markers, undefined, false)).toEqual({
      current: -1,
      previous: -1,
      next: -1,
    });
  });
  it("标记前后导出范围受实际录制边界约束", () => {
    expect(markerClipRange(10, 40)).toEqual([5, 25]);
    expect(markerClipRange(2, 10)).toEqual([0, 10]);
    expect(markerClipRange(30, 32)).toEqual([25, 32]);
    expect(markerClipRange(0, 0)).toBeNull();
    expect(markerClipRange(100, 10)).toBeNull();
  });
  it("两种播放器生成相同的合法片段文件名", () => {
    expect(markerClipName("直播/回看", "精彩:片段\n")).toBe(
      "直播_回看_精彩_片段_",
    );
    expect(markerClipName("直播")).toBe("直播_片段");
    expect(markerClipName("名".repeat(200))).toHaveLength(120);
  });
});
