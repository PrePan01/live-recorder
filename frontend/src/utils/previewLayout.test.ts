import { describe, expect, it } from 'vitest';
import { fitPreviewBox, fitPreviewBoxByHeight } from './previewLayout';

describe('fitPreviewBox', () => {
  it('横屏按宽度适配，高度不设上限（保持既有行为）', () => {
    expect(fitPreviewBox(16 / 9, 1104, 710)).toEqual({ width: 1104, height: 621 });
    // 可用高度很小也不压缩横屏：横屏弹窗的高度由宽度决定。
    expect(fitPreviewBox(16 / 9, 1440, 300)).toEqual({ width: 1440, height: 810 });
  });

  it('竖屏按可用高度适配并收窄宽度', () => {
    // 9:16 按弹窗宽度会得到 1962 高，必须被压到可用高度。
    const box = fitPreviewBox(9 / 16, 1104, 700);
    expect(box.height).toBe(700);
    expect(box.width).toBeCloseTo(393.75);
  });

  it('竖屏未超过可用高度时保持给定宽度', () => {
    const box = fitPreviewBox(9 / 16, 320, 700);
    expect(box.width).toBe(320);
    expect(box.height).toBeCloseTo(568.89, 1);
  });

  it('比例无效（0 / 负数 / NaN）时退回 16:9', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fitPreviewBox(bad, 1104, 710)).toEqual({ width: 1104, height: 621 });
    }
  });
});

describe('fitPreviewBoxByHeight', () => {
  it('竖屏按高度缩放：宽度随比例算出', () => {
    expect(fitPreviewBoxByHeight(9 / 16, 600, 700)).toEqual({
      width: 337.5,
      height: 600,
    });
  });

  it('高度超过可用高度时被压回上限', () => {
    expect(fitPreviewBoxByHeight(9 / 16, 900, 700)).toEqual({
      width: 393.75,
      height: 700,
    });
  });
});
