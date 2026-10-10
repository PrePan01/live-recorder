import { describe, expect, it, vi } from 'vitest';
import { DanmakuRenderer, type RenderInput } from './danmakuRenderer';

function fakeAnimation(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  let time = 0;
  const assignedTimes: number[] = [];
  const animation = {
    keyframes, options, assignedTimes, playbackRate: 1, playState: 'running', onfinish: null as (() => void) | null,
    get currentTime() { return time; },
    set currentTime(value: number) { time = value; assignedTimes.push(value); },
    effect: { setKeyframes: vi.fn(), updateTiming: vi.fn() },
    pause: vi.fn(() => { animation.playState = 'paused'; }),
    play: vi.fn(() => { animation.playState = 'running'; }),
    updatePlaybackRate: vi.fn((rate: number) => { animation.playbackRate = rate; }),
    cancel: vi.fn(() => { animation.playState = 'idle'; }),
    advance(ms: number) { if (animation.playState === 'running') time += ms * animation.playbackRate; },
    finish() { animation.playState = 'finished'; animation.onfinish?.(); },
  };
  return animation;
}
function createNode() {
    const animations: ReturnType<typeof fakeAnimation>[] = [];
    const node = { style: {} as Record<string, string>, textContent: '', className: '', removed: false,
      remove: vi.fn(() => { node.removed = true; }),
      animate: vi.fn((keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
        const animation = fakeAnimation(keyframes, options); animations.push(animation); return animation;
      }), animations };
    return node;
}
function setup() {
  const nodes: ReturnType<typeof createNode>[] = [];
  const container = { style: {} as Record<string, string>, appendChild: vi.fn(),
    ownerDocument: { createElement: () => { const node = createNode(); nodes.push(node); return node; } } };
  const measure = vi.fn(() => 100);
  const renderer = new DanmakuRenderer(container as unknown as HTMLElement, measure);
  renderer.resize(960, 540);
  const input: RenderInput = { messages: [{ id: 'a', text: '测试弹幕', tMs: 0 }], gaps: [], maxBullets: 60, opacity: 0.9 };
  return { renderer, container, measure, nodes, input };
}

describe('弹幕原生动画生命周期', () => {
  it('创建一次完整的线性出入场轨迹，媒体时钟反复停住也不重建或逐帧改位置', () => {
    const { renderer, nodes, input } = setup();
    renderer.tick(0, input, 1);
    const animation = nodes[0].animations[0];
    for (let frame = 0; frame < 144; frame++) {
      animation.advance(1000 / 144);
      renderer.tick(0, input, 1);
    }
    expect(nodes).toHaveLength(1);
    expect(nodes[0].animate).toHaveBeenCalledTimes(1);
    expect(animation.currentTime).toBeCloseTo(1000);
    expect(animation.assignedTimes).toEqual([]);
    expect(animation.pause).not.toHaveBeenCalled();
    expect(animation.updatePlaybackRate).not.toHaveBeenCalled();
    expect(animation.effect.setKeyframes).not.toHaveBeenCalled();
    expect(animation.keyframes).toEqual([{ transform: 'translate3d(960px,0,0)' }, { transform: 'translate3d(-108px,0,0)' }]);
    expect(animation.options.duration).toBe((960 + 108) / 0.16);
    expect(animation.options.easing).toBe('linear');
  });
  it('迟到消息从边缘入场，换表及主线程调度中断不改变已有轨迹', () => {
    const { renderer, nodes, input } = setup();
    renderer.tick(0, input, 1);
    const animation = nodes[0].animations[0];
    animation.advance(1500); // The browser, rather than JS ticks, owns elapsed animation time.
    const messages = [...input.messages, { id: 'late', text: '迟到', tMs: 200 }];
    renderer.tick(1500, { ...input, messages }, 1);
    expect(animation.currentTime).toBe(1500);
    expect(animation.assignedTimes).toEqual([]);
    expect(nodes[1].animations[0].assignedTimes).toEqual([]);
    expect(nodes[1].animations[0].keyframes[0].transform).toBe('translate3d(960px,0,0)');
  });
  it('暂停、恢复和倍速保持当前位置，只有状态变化才操作动画', () => {
    const { renderer, nodes, input } = setup();
    renderer.tick(0, input, 1);
    const animation = nodes[0].animations[0]; animation.advance(500);
    renderer.tick(500, input, 0); animation.advance(1000);
    renderer.tick(500, input, 0);
    expect(animation.currentTime).toBe(500);
    expect(animation.pause).toHaveBeenCalledTimes(1);
    renderer.tick(500, input, 2); animation.advance(100);
    renderer.tick(700, input, 2);
    expect(animation.currentTime).toBe(700);
    expect(animation.play).toHaveBeenCalledTimes(1);
    expect(animation.updatePlaybackRate).toHaveBeenCalledTimes(1);
    expect(animation.assignedTimes).toEqual([]);
  });
  it('未来消息按原始媒体时间调度，跳播恢复历史位置并淡入', () => {
    const { renderer, nodes, input } = setup();
    const messages = [...input.messages, { id: 'future', text: '未来', tMs: 1200 }];
    renderer.tick(1000, { ...input, messages }, 0);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].animations[0].assignedTimes).toEqual([1000]);
    expect(nodes[0].animations[0].pause).toHaveBeenCalledTimes(1);
    expect(nodes[0].animations[1].options.duration).toBe(120);
    renderer.tick(1200, { ...input, messages }, 1);
    expect(nodes).toHaveLength(2);
    expect(nodes[1].animations[0].assignedTimes).toEqual([]);
  });
  it('同轨道按实际动画进度留出间距，媒体时钟阶梯不影响防碰撞', () => {
    const { renderer, nodes, input } = setup(); renderer.resize(960, 28);
    renderer.tick(0, input, 1);
    nodes[0].animations[0].advance(800); // 128px > 102px text + 24px gap.
    renderer.tick(0, { ...input, messages: [...input.messages, { id: 'b', text: '第二条', tMs: 0 }] }, 1);
    expect(nodes).toHaveLength(2);
    expect(nodes[1].style.top).toBe('0px');
    renderer.tick(0, { ...input, messages: [...input.messages,
      { id: 'b', text: '第二条', tMs: 0 }, { id: 'c', text: '过近', tMs: 0 }] }, 1);
    expect(nodes).toHaveLength(2);
  });
  it('离场立即回收节点与动画，重置和销毁取消所有活动动画', () => {
    const { renderer, nodes, input } = setup(); renderer.tick(0, input, 1);
    nodes[0].animations[0].finish();
    expect(nodes[0].removed).toBe(true);
    renderer.tick(0, { ...input, messages: [...input.messages, { id: 'b', text: '新弹幕', tMs: 0 }] }, 1);
    expect(nodes).toHaveLength(2);
    renderer.reset();
    expect(nodes[1].animations[0].cancel).toHaveBeenCalledTimes(1);
    renderer.tick(1000, input, 1); renderer.destroy();
    expect(nodes[2].removed).toBe(true);
    expect(nodes[2].animations.every(a => a.cancel.mock.calls.length === 1)).toBe(true);
  });
  it('缺口、无时间、无法映射和过期消息不出场，未取得媒体时间时隐藏并冻结', () => {
    const { renderer, nodes, container, input } = setup();
    renderer.tick(0, { ...input, messages: [
      { id: 'null', text: '无时间', tMs: null }, { id: 'bad', text: '无法映射', tMs: 0, unmappable: true },
      ...input.messages], gaps: [{ fromMs: 0, toMs: 1000 }] }, 1);
    expect(nodes).toHaveLength(0);
    renderer.reset(); renderer.tick(10000, input, 1);
    expect(nodes).toHaveLength(0);
    renderer.reset(); renderer.tick(0, input, 1); renderer.tick(NaN, input, 1);
    expect(container.style.visibility).toBe('hidden');
    expect(nodes[0].animations[0].pause).toHaveBeenCalledTimes(1);
  });
  it('分批入场并限制活动图层，重复文本复用测量，超长文本限制图层宽度', () => {
    const { renderer, nodes, measure, input } = setup(); renderer.resize(960, 3000);
    const messages = Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: '相同弹幕', tMs: 0 }));
    const frameInput = { ...input, messages, maxBullets: 100 };
    renderer.tick(0, frameInput, 1); expect(nodes).toHaveLength(4);
    for (let i = 0; i < 30; i++) renderer.tick(0, frameInput, 1);
    expect(nodes).toHaveLength(80); expect(measure).toHaveBeenCalledTimes(1);
    renderer.reset(); measure.mockReturnValue(200000);
    renderer.tick(0, { ...input, messages: [{ id: 'long', text: '超长弹幕', tMs: 0 }] }, 1);
    expect(nodes.at(-1)!.style.width).toBe('4096px');
  });
  it('缩放容器保留弹幕横向位置，重复尺寸通知不重启动画', () => {
    const { renderer, nodes, input } = setup(); renderer.tick(0, input, 1);
    const animation = nodes[0].animations[0]; animation.advance(1000);
    renderer.resize(1200, 540);
    expect(1200 - animation.currentTime * 0.16).toBe(960 - 1000 * 0.16);
    renderer.resize(1200, 540);
    expect(animation.effect.setKeyframes).toHaveBeenCalledTimes(1);
    expect(nodes[0].animate).toHaveBeenCalledTimes(1);
  });
  it('密集超长弹幕按总图层面积限额，销毁回收后可重新入场', () => {
    const { renderer, nodes, measure, input } = setup(); renderer.resize(960, 3000);
    measure.mockReturnValue(4000);
    const messages = Array.from({ length: 80 }, (_, i) => ({ id: String(i), text: `长弹幕${i}`, tMs: 0 }));
    const frameInput = { ...input, messages, maxBullets: 80 };
    for (let i = 0; i < 20; i++) renderer.tick(0, frameInput, 1);
    const count = nodes.length;
    expect(count).toBeGreaterThan(0);
    expect(count * 4002 * 28).toBeLessThanOrEqual(1024 * 1024);
    renderer.reset(); renderer.tick(0, frameInput, 1);
    expect(nodes.length).toBe(count + 4);
  });
  it('弹幕内容按文本显示，HTML不会被作为节点解析', () => {
    const { renderer, nodes, input } = setup();
    renderer.tick(0, { ...input, messages: [{ id: 'html', text: '<img src=x onerror=alert(1)>', tMs: 0 }] }, 1);
    expect(nodes[0].textContent).toBe('<img src=x onerror=alert(1)>');
  });
});
