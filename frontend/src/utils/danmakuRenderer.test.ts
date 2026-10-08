import { describe, expect, it, vi } from 'vitest';
import { DanmakuRenderer, type RenderInput } from './danmakuRenderer';

function setup() {
  const sprites: ReturnType<typeof context>[] = [];
  const ctx = context();
  const canvas = { width: 1, height: 1, style: {} } as HTMLCanvasElement;
  const renderer = new DanmakuRenderer(canvas, ctx as unknown as CanvasRenderingContext2D, () => {
    const ctx = context(); sprites.push(ctx);
    return { width: 1, height: 1, getContext: () => ctx } as unknown as HTMLCanvasElement;
  });
  renderer.resize(960, 540, 2);
  const input: RenderInput = { messages: [{ id: 'a', text: '测试弹幕', tMs: 0 }], gaps: [], maxBullets: 40, opacity: 0.9 };
  return { renderer, ctx, sprites, input, canvas };
}
function context() {
  return { measureText: vi.fn(() => ({ width: 100 })), fillText: vi.fn(), drawImage: vi.fn(),
    clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), scale: vi.fn(), globalAlpha: 1 };
}

describe('弹幕画布渲染', () => {
  it('连续动画仅移动缓存图片，文字与阴影只生成一次', () => {
    const { renderer, ctx, sprites, input } = setup();
    for (let t = 0; t < 1000; t += 16) renderer.render(t, input);
    expect(sprites).toHaveLength(1);
    expect(sprites[0].fillText).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.drawImage.mock.calls.length).toBeGreaterThan(50);
    const firstX = ctx.drawImage.mock.calls[0][1];
    const lastX = ctx.drawImage.mock.calls.at(-1)![1];
    expect(Math.abs(firstX - lastX - 992 * 0.16)).toBeLessThanOrEqual(0.25);
  });
  it('暂停、无弹幕及未取得媒体时间时不重复清屏或重绘', () => {
    const { renderer, ctx, input } = setup();
    renderer.render(0, input);
    for (let i = 0; i < 60; i++) renderer.render(0, input);
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    renderer.render(10000, input);
    const clears = ctx.clearRect.mock.calls.length;
    renderer.render(10016, input); renderer.render(NaN, input);
    expect(ctx.clearRect).toHaveBeenCalledTimes(clears);
  });
  it('跳播清屏且重用文字缓存，缺口内消息不显示', () => {
    const { renderer, ctx, sprites, input } = setup();
    renderer.render(0, input); renderer.reset(); renderer.render(100, input);
    expect(sprites).toHaveLength(1);
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    renderer.reset(); renderer.render(0, { ...input, gaps: [{ fromMs: 0, toMs: 1000 }] });
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
  });
  it('消息窗口更新去重，同屏密度受限且超长消息不分配巨型图片', () => {
    const { renderer, ctx, sprites, input } = setup();
    const messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: '相同弹幕', tMs: 0 }));
    renderer.render(0, { ...input, messages, maxBullets: 2 });
    expect(ctx.drawImage).toHaveBeenCalledTimes(2);
    renderer.render(0, { ...input, messages: [...messages], maxBullets: 2 });
    expect(ctx.drawImage).toHaveBeenCalledTimes(4);
    expect(sprites).toHaveLength(1);
    renderer.reset(); ctx.measureText.mockReturnValue({ width: 200000 });
    renderer.render(0, { ...input, messages: [{ id: 'long', text: '超长', tMs: 0 }] });
    expect(sprites).toHaveLength(1);
    expect(ctx.fillText).toHaveBeenCalledTimes(1);
  });
  it('像素比有上限，重复尺寸通知不重置画布', () => {
    const { renderer, canvas } = setup();
    renderer.resize(960, 540, 4); expect(canvas.width).toBe(1920);
    canvas.width = 123;
    renderer.resize(960, 540, 4); expect(canvas.width).toBe(123);
  });
  it('密集长弹幕的活动图片也计入缓存上限，回退消息不逐帧重新生成图片', () => {
    const { renderer, ctx, sprites, input } = setup();
    renderer.resize(960, 3000, 2);
    ctx.measureText.mockReturnValue({ width: 1000 });
    const messages = Array.from({ length: 80 }, (_, i) => ({ id: String(i), text: `长弹幕${i}`, tMs: 0 }));
    const frameInput = { ...input, messages, maxBullets: 80 };
    renderer.render(0, frameInput);
    const allocated = sprites.length;
    expect(allocated).toBeGreaterThan(0);
    expect(allocated * 2024 * 80 * 4).toBeLessThanOrEqual(8 * 1024 * 1024);
    renderer.render(16, frameInput);
    expect(sprites).toHaveLength(allocated);
    expect(ctx.measureText).toHaveBeenCalledTimes(80);
  });
});
