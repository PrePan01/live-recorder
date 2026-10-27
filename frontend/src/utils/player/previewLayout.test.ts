import { describe, expect, it } from "vitest";
import {
  fitPreviewBox,
  fitPreviewBoxByHeight,
  fitPreviewContent,
} from "./previewLayout";

describe("fitPreviewBox", () => {
  it("横屏在可用高度不足时缩小，避免覆盖弹窗操作区", () => {
    expect(fitPreviewBox(16 / 9, 1104, 710)).toEqual({
      width: 1104,
      height: 621,
    });
    expect(fitPreviewBox(16 / 9, 1440, 300)).toEqual({
      width: 533.3333333333333,
      height: 300,
    });
  });

  it("竖屏按可用高度适配并收窄宽度", () => {
    // 9:16 按弹窗宽度会得到 1962 高，必须被压到可用高度。
    const box = fitPreviewBox(9 / 16, 1104, 700);
    expect(box.height).toBe(700);
    expect(box.width).toBeCloseTo(393.75);
  });

  it("竖屏未超过可用高度时保持给定宽度", () => {
    const box = fitPreviewBox(9 / 16, 320, 700);
    expect(box.width).toBe(320);
    expect(box.height).toBeCloseTo(568.89, 1);
  });

  it("比例无效（0 / 负数 / NaN）时退回 16:9", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fitPreviewBox(bad, 1104, 710)).toEqual({
        width: 1104,
        height: 621,
      });
    }
  });
});

describe("fitPreviewBoxByHeight", () => {
  it("竖屏按高度缩放：宽度随比例算出", () => {
    expect(fitPreviewBoxByHeight(9 / 16, 600, 700)).toEqual({
      width: 337.5,
      height: 600,
    });
  });

  it("高度超过可用高度时被压回上限", () => {
    expect(fitPreviewBoxByHeight(9 / 16, 900, 700)).toEqual({
      width: 393.75,
      height: 700,
    });
  });
});

describe("fitPreviewContent", () => {
  it("各类比例在宽高约束和轨道动画下保持比例且不越界", () => {
    for (const ratio of [1 / 10, 9 / 16, 3 / 4, 1, 4 / 3, 16 / 9, 21 / 9, 10]) {
      for (const availableWidth of [240, 450, 1104]) {
        for (const availableHeight of [100, 400, 700]) {
          const trackHeight = Math.min(180, availableHeight);
          for (const occupiedTrackHeight of [0, trackHeight / 2, trackHeight]) {
            const { videoBox, contentHeight } = fitPreviewContent({
              ratio,
              availableWidth,
              availableHeight,
              trackHeight,
              occupiedTrackHeight,
            });
            expect(videoBox.width).toBeLessThanOrEqual(availableWidth + 1e-6);
            expect(videoBox.height + occupiedTrackHeight).toBeLessThanOrEqual(
              availableHeight + 1e-6,
            );
            expect(contentHeight).toBeLessThanOrEqual(availableHeight + 1e-6);
            expect(videoBox.width).toBeCloseTo(videoBox.height * ratio);
          }
        }
      }
    }
  });

  it("窄窗口中的竖屏同时限制宽度，避免画面被裁切", () => {
    const { videoBox } = fitPreviewContent({
      ratio: 9 / 16,
      availableWidth: 240,
      availableHeight: 900,
      trackHeight: 180,
      occupiedTrackHeight: 180,
      preferredVideoHeight: 700,
    });
    expect(videoBox.width).toBe(240);
    expect(videoBox.height).toBeCloseTo((240 * 16) / 9);
  });

  it("横屏和方形的整个轨道区域始终与视频同宽，包括受高度限制时", () => {
    const layout = {
      availableWidth: 1104,
      availableHeight: 900,
      trackHeight: 180,
      occupiedTrackHeight: 180,
    };
    for (const ratio of [1, 4 / 3, 16 / 9, 21 / 9]) {
      for (const availableHeight of [400, 900]) {
        for (const occupiedTrackHeight of [0, 90, 180]) {
          const { videoBox, trackWidth } = fitPreviewContent({
            ...layout,
            ratio,
            availableHeight,
            occupiedTrackHeight,
          });
          expect(trackWidth).toBe(videoBox.width);
        }
      }
    }
  });

  it("竖屏轨道在收放过程中保持可用宽度的 80%", () => {
    const layout = {
      ratio: 9 / 16,
      availableWidth: 1104,
      availableHeight: 700,
      trackHeight: 180,
    };
    for (const occupiedTrackHeight of [0, 90, 180]) {
      expect(
        fitPreviewContent({ ...layout, occupiedTrackHeight }).trackWidth,
      ).toBe(1104 * 0.8);
    }
  });

  it("保留竖屏手动缩小的高度", () => {
    const { videoBox } = fitPreviewContent({
      ratio: 9 / 16,
      availableWidth: 1104,
      availableHeight: 900,
      trackHeight: 180,
      occupiedTrackHeight: 180,
      preferredVideoHeight: 300,
    });
    expect(videoBox).toEqual({ width: 168.75, height: 300 });
  });
});
