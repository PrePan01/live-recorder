import { describe, expect, it } from 'vitest';
import {
  defaultDanmakuEnabled,
  platformCheckInterval,
  resolveDanmakuEnabled,
  resolveRoomPolicy,
  roomQuality,
} from '../../src/config/room-policy.js';
import type { AppSettings, Room } from '../../src/types/index.js';

const settings = {
  checkIntervalSec: { default: 60, bilibili: 30, douyin: 120 },
  quality: '1080p',
  autoRecord: true,
  danmaku: { enabled: true },
} as unknown as AppSettings;

const roomWith = (patch: Partial<Room>): Room =>
  ({ platform: 'bilibili', checkIntervalSec: null, quality: null, autoRecord: null, danmakuEnabled: null, ...patch }) as Room;

describe('继承生效值唯一出口（T1/T2/T4）', () => {
  it('三层覆盖矩阵：房间 > 标签 > 全局，null=跟随上层', () => {
    const tag = { checkIntervalSec: 45, quality: '720p' as const, autoRecord: false, danmakuEnabled: false };
    // 全层缺省 → 全局
    const globalOnly = resolveRoomPolicy(roomWith({}), settings, null);
    expect(globalOnly.checkIntervalSec).toEqual({ value: 30, source: 'global' }); // bilibili 平台值
    expect(globalOnly.quality).toEqual({ value: '1080p', source: 'global' });
    expect(globalOnly.autoRecord).toEqual({ value: true, source: 'global' });
    expect(globalOnly.danmakuEnabled).toEqual({ value: true, source: 'global' });
    // 仅标签覆盖 → 标签
    const tagOnly = resolveRoomPolicy(roomWith({}), settings, tag);
    expect(tagOnly.checkIntervalSec).toEqual({ value: 45, source: 'tag' });
    expect(tagOnly.quality).toEqual({ value: '720p', source: 'tag' });
    expect(tagOnly.autoRecord).toEqual({ value: false, source: 'tag' });
    expect(tagOnly.danmakuEnabled).toEqual({ value: false, source: 'tag' });
    // 房间+标签+全局全有 → 房间赢
    const allLayers = resolveRoomPolicy(roomWith({ checkIntervalSec: 15, quality: 'original', autoRecord: false, danmakuEnabled: true }), settings, tag);
    expect(allLayers.checkIntervalSec).toEqual({ value: 15, source: 'room' });
    expect(allLayers.quality).toEqual({ value: 'original', source: 'room' });
    expect(allLayers.autoRecord).toEqual({ value: false, source: 'room' });
    expect(allLayers.danmakuEnabled).toEqual({ value: true, source: 'room' });
    // 房间缺省 + 标签缺省项 → 该项落全局（混合覆盖）
    const mixed = resolveRoomPolicy(roomWith({ checkIntervalSec: 15 }), settings, tag);
    expect(mixed.checkIntervalSec.source).toBe('room');
    expect(mixed.quality).toEqual({ value: '720p', source: 'tag' });
  });

  it('T2 来源=最近显式覆盖层：值巧合等于全局也标 room', () => {
    const same = resolveRoomPolicy(roomWith({ checkIntervalSec: 30 }), settings, null); // 30=全局值
    expect(same.checkIntervalSec).toEqual({ value: 30, source: 'room' });
  });

  it('T4 边界：全 null 落全局、平台默认兜底含在全局层、弹幕全局仅显式 true 开', () => {
    expect(resolveRoomPolicy(roomWith({}), { ...settings, checkIntervalSec: { default: 60 } } as unknown as AppSettings, null)
      .checkIntervalSec).toEqual({ value: 60, source: 'global' }); // 无平台值 → default
    expect(platformCheckInterval('xiaohongshu', null)).toBe(120); // 平台默认兜底单出口
    expect(platformCheckInterval('douyin', null)).toBe(120);
    expect(platformCheckInterval('bilibili', null)).toBe(60);
    expect(defaultDanmakuEnabled({ danmaku: { enabled: false } })).toBe(false);
    expect(defaultDanmakuEnabled({})).toBe(false); // 缺省=关（沿用既有语义）
    expect(resolveDanmakuEnabled(roomWith({ danmakuEnabled: null }), { danmaku: { enabled: false } })).toBe(false);
    expect(resolveDanmakuEnabled(roomWith({ danmakuEnabled: true }), { danmaku: { enabled: false } })).toBe(true);
  });

  it('行为等价：执行侧助手与收敛前表达式逐项一致', () => {
    expect(roomQuality(roomWith({ quality: null }), settings)).toBe('1080p');
    expect(roomQuality(roomWith({ quality: '720p' }), settings)).toBe('720p');
    const auto = resolveRoomPolicy(roomWith({ autoRecord: null }), settings).autoRecord.value;
    expect(auto).toBe((null ?? settings.autoRecord ?? false));
    const noGlobal = resolveRoomPolicy(roomWith({ autoRecord: null }), { ...settings, autoRecord: undefined } as unknown as AppSettings).autoRecord.value;
    expect(noGlobal).toBe(false);
    // 间隔：房间值优先，否则平台解析（与 scheduler 收敛前表达式同式）
    expect(resolveRoomPolicy(roomWith({ checkIntervalSec: 25 }), settings).checkIntervalSec.value * 1000).toBe(25_000);
    expect(resolveRoomPolicy(roomWith({ checkIntervalSec: null }), settings).checkIntervalSec.value * 1000)
      .toBe(platformCheckInterval('bilibili', settings) * 1000);
  });
});
