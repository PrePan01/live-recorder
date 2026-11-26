import type { Platform } from "../types/room.js";
import { chineseRoomUrl, parseChineseRoomLink } from "./chinese-live/url.js";
import { normalizeYoutubeUrl, parseYoutubeUrl } from './youtube/url.js';
import type { PlatformAdapter, LiveStatusResult, StreamUrlResult } from './adapter.js';
import type { Quality } from '../types/index.js';
import { normalizeXiaohongshuUrl, parseXiaohongshuUrl } from './xiaohongshu/url.js';
import { normalizeDouyinUrl, parseDouyinRoomId } from './douyin/url.js';
import { normalizeBilibiliUrl, validateBilibiliUrl } from './bilibili/url.js';

/**
 * Fake 平台适配器：可编程开播/未开播/受限/错误序列，并生成最小可播放 FLV。
 * 阶段 B 全 fake 交付用，FE 可直接连预览链路。
 */
export class FakePlatformAdapter implements PlatformAdapter {
  readonly platform: Platform;
  private callCount = 0;
  /** 可编程结果队列；耗尽后回落到 live。 */
  public script: LiveStatusResult[] = [{ status: 'offline' }, { status: 'live', streamSessionId: 'sess_fake_1', streamTitle: 'Fake 直播', availableQualities: ['original', '1080p', '720p'] }];

  constructor(platform: Platform = 'bilibili') {
    this.platform = platform;
  }

  setScript(results: LiveStatusResult[]): void {
    this.script = results;
    this.callCount = 0;
  }

  async checkLiveStatus(roomUrl: string): Promise<LiveStatusResult> {
    const result = this.script[this.callCount] ?? { status: 'live', streamSessionId: `sess_${this.callCount}`, streamTitle: 'Fake 直播' };
    this.callCount += 1;
    return { ...result, displayName: result.displayName ?? 'Fake 主播' };
  }

  async getStreamUrl(roomUrl: string, quality: Quality): Promise<StreamUrlResult> {
    return { url: `fake://stream/${encodeURIComponent(roomUrl)}?q=${quality}`, format: 'flv', actualQuality: quality };
  }

  normalizeUrl(raw: string): string {
    if (this.platform === "douyu" || this.platform === "huya") return chineseRoomUrl(this.platform, parseChineseRoomLink(this.platform, raw)!);
    if (this.platform === "youtube") return normalizeYoutubeUrl(raw);
    if (this.platform === 'xiaohongshu') return normalizeXiaohongshuUrl(raw);
    if (this.platform === 'douyin') return normalizeDouyinUrl(raw);
    return normalizeBilibiliUrl(raw);
  }

  validateUrl(raw: string): boolean {
    if (this.platform === "douyu" || this.platform === "huya") return parseChineseRoomLink(this.platform, raw) !== null;
    if (this.platform === "youtube") return parseYoutubeUrl(raw) !== null;
    if (this.platform === 'xiaohongshu') return parseXiaohongshuUrl(raw) !== null;
    // 与真实适配器口径一致，便于 fake 模式下按 URL 自动识别平台。
    return this.platform === 'bilibili'
      ? validateBilibiliUrl(raw)
      : parseDouyinRoomId(raw) !== null;
  }
}

/** 纯视频 FLV，配置和两个关键帧各自使用完整的标签。 */
export function buildMinimalFlv(): Buffer {
  const header = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x01, 0x00, 0x00, 0x00, 0x09]);
  const prevSize0 = Buffer.alloc(4);
  const meta = flvTag(0x12, 0, amfMeta());
  const sps = Buffer.from([0x67, 0x64, 0x00, 0x1e, 0xac, 0xd9, 0x4a]);
  const pps = Buffer.from([0x68, 0xeb, 0x23, 0xcb, 0x22]);
  const config = flvTag(0x09, 0, Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), avcc([sps], [pps])]));
  const nal = Buffer.from([0x65, 0x88, 0x84, 0x00, 0x33, 0xff, 0xff]);
  const keyframe = Buffer.concat([Buffer.from([0x17, 1, 0, 0, 0]), uint32(nal.length), nal]);
  const v1 = flvTag(0x09, 40, keyframe);
  const v2 = flvTag(0x09, 140, keyframe);
  return Buffer.concat([header, prevSize0, meta, size(meta), config, size(config), v1, size(v1), v2, size(v2)]);
}

function flvTag(type: number, ts: number, data: Buffer): Buffer {
  const head = Buffer.alloc(11);
  head[0] = type;
  head.writeUIntBE(data.length, 1, 3);
  head.writeUIntBE(ts, 4, 3);
  head[7] = (ts >> 24) & 0xff;
  head[8] = 0;
  head[9] = 0;
  head[10] = 0;
  return Buffer.concat([head, data]);
}

function size(tag: Buffer): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(11 + tag.length, 0);
  return b;
}

function amfMeta(): Buffer {
  const name = Buffer.from([0x02, 0x00, 0x0a, ...Buffer.from('onMetaData')]);
  const ecma = Buffer.concat([
    Buffer.from([0x08, 0x00, 0x00, 0x00, 0x06]),
    stringField('duration'), numField(0),
    stringField('width'), numField(1280),
    stringField('height'), numField(720),
    stringField('videodatarate'), numField(2000),
    stringField('framerate'), numField(30),
    stringField('cankeyframes'), boolField(true),
    Buffer.from([0x00, 0x00, 0x09]),
  ]);
  const scriptTagData = Buffer.concat([name, ecma]);
  return scriptTagData;
}

function avcc(sps: Buffer[], pps: Buffer[]): Buffer {
  const parts: Uint8Array[] = [Buffer.from([0x01, sps[0]![1]!, sps[0]![2]!, sps[0]![3]!, 0xff, 0xe1])];
  for (const s of sps) parts.push(uint16(s.length), s);
  parts.push(Buffer.from([pps.length & 0xff]));
  for (const p of pps) parts.push(uint16(p.length), p);
  return Buffer.concat(parts);
}

function stringField(s: string): Buffer {
  return Buffer.concat([uint16(s.length), Buffer.from(s)]);
}
function numField(n: number): Buffer {
  const b = Buffer.alloc(9);
  b[0] = 0x00;
  b.writeDoubleBE(n, 1);
  return b;
}
function boolField(v: boolean): Buffer {
  return Buffer.from([0x01, v ? 1 : 0]);
}
function uint24(n: number): Buffer {
  const b = Buffer.alloc(3);
  b.writeUIntBE(n, 0, 3);
  return b;
}
function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}
function uint16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n, 0);
  return b;
}
