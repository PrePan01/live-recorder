import { createHash } from 'node:crypto';
import type { LiveStatusResult, PlatformAdapter, PreviewSourceResult, Quality, RecordingSourceResult, StreamUrlResult } from '../adapter.js';
import type { ChineseLivePlatform } from '../../security/keys.js';
import { AppError } from '../../types/error.js';
import { chineseRoomUrl, parseChineseRoomLink } from './url.js';

export const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
export function md5Hex(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

const SNAPSHOT_MS = 5_000;
const MAX_ROOM_ENTRIES = 256;
const QUALITY_ORDER: Quality[] = ['360p', '540p', '720p', '1080p', 'original'];

export interface RoomSnapshot {
  id: string;
  live: LiveStatusResult;
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

export function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/.test(value))) return;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function streamStartedAt(value: unknown): string | undefined {
  const seconds = number(value);
  if (!seconds || seconds < 0 || seconds > 9_999_999_999) return;
  return new Date(seconds * 1000).toISOString();
}

export function httpsUrl(value: unknown, domains?: readonly string[]): URL | undefined {
  const input = string(value);
  if (!input) return;
  try {
    const url = new URL(input.startsWith('//') ? `https:${input}` : input);
    if (!['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password) return;
    if (domains && !domains.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return;
    url.protocol = 'https:';
    return url;
  } catch {
    return;
  }
}

export function sameSiteHeaders(platform: ChineseLivePlatform, room: string, cookie?: string): Record<string, string> {
  return {
    'User-Agent': WEB_UA,
    Referer: chineseRoomUrl(platform, room),
    Origin: `https://www.${platform}.com`,
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

export function protocolChanged(label: string): AppError {
  return new AppError('PLATFORM_CHANGED', `${label}响应格式异常`, { retryable: true });
}

export async function webRequest(fetcher: typeof fetch, label: string, url: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: 'manual',
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000),
    });
  } catch {
    throw new AppError('NETWORK_UNAVAILABLE', `${label}请求失败`, { retryable: true });
  }
  return response;
}

export async function responseBytes(response: Response, label: string, maxBytes = 4 * 1024 * 1024): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) throw new AppError('RESOURCE_NOT_FOUND', `${label}资源不存在`);
    if (response.status === 401 || response.status === 403) throw new AppError('PLATFORM_ACCESS_RESTRICTED', `${label}访问受限`);
    throw new AppError('PLATFORM_SERVER_ERROR', `${label}请求失败（HTTP ${response.status}）`, { retryable: true });
  }
  if (!response.body) throw protocolChanged(label);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.byteLength;
      if (bytes > maxBytes) throw protocolChanged(label);
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('NETWORK_UNAVAILABLE', `${label}读取失败`, { retryable: true });
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function responseText(response: Response, label: string, maxBytes?: number): Promise<string> {
  return (await responseBytes(response, label, maxBytes)).toString('utf8');
}

export async function responseJson(response: Response, label: string): Promise<Record<string, unknown>> {
  const text = await responseText(response, label);
  try {
    const value = object(JSON.parse(text));
    if (value) return value;
  } catch { /* Invalid upstream data. */ }
  throw protocolChanged(label);
}

export function qualityFromLabel(label: unknown, height?: unknown): Quality | undefined {
  const size = number(height) ?? number(/(?:^|\D)(1080|720|540|360)\s*p(?:\d{2})?(?!\w)/i.exec(string(label) ?? '')?.[1]);
  const key = `${size}p` as Quality;
  if (QUALITY_ORDER.includes(key)) return key;
  const tier = string(label)?.trim();
  // Map named AVC tiers to the application's quality presets.
  if (tier === '流畅') return '360p';
  if (tier === '高清' || tier === '标清') return '540p';
  if (tier === '超清') return '720p';
  if (tier && /^蓝光(?:\s*\d+(?:\.\d+)?M)?$/i.test(tier)) return '1080p';
  return undefined;
}

export function chooseQuality<T extends { quality: Quality }>(options: T[], requested: Quality): T | undefined {
  const target = QUALITY_ORDER.indexOf(requested);
  const sorted = [...options].sort((a, b) => QUALITY_ORDER.indexOf(b.quality) - QUALITY_ORDER.indexOf(a.quality));
  return sorted.find(option => QUALITY_ORDER.indexOf(option.quality) <= target) ?? sorted.at(-1);
}

export function boundedSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_ROOM_ENTRIES) map.delete(map.keys().next().value!);
}

function accountScope(cookie?: string): string {
  return cookie ? createHash('sha256').update(cookie).digest('hex') : '';
}

abstract class HttpLiveAdapter<P extends ChineseLivePlatform, Snapshot extends RoomSnapshot> implements PlatformAdapter {
  abstract readonly platform: P;
  protected abstract fetchRoom(room: string, cookie?: string): Promise<Snapshot>;
  protected abstract fetchStream(snapshot: Snapshot, quality: Quality, cookie: string | undefined, avoid?: string): Promise<StreamUrlResult>;
  private readonly snapshots = new Map<string, { snapshot: Snapshot; expiresAt: number }>();
  private readonly roomRequests = new Map<string, Promise<Snapshot>>();
  private readonly sourceRequests = new Map<string, Promise<RecordingSourceResult>>();
  private readonly failedSources = new Map<string, { host: string; expiresAt: number }>();

  validateUrl(raw: string): boolean {
    return parseChineseRoomLink(this.platform, raw) !== null;
  }

  protected roomFromUrl(raw: string): string {
    const room = parseChineseRoomLink(this.platform, raw);
    if (!room) throw new AppError('ROOM_LINK_INVALID', '直播间链接无效');
    return room;
  }

  normalizeUrl(raw: string): string {
    return chineseRoomUrl(this.platform, this.roomFromUrl(raw));
  }

  async resolveRoomUrl(raw: string, cookie?: string): Promise<string> {
    const room = this.roomFromUrl(raw);
    const snapshot = await this.roomSnapshot(room, cookie);
    return chineseRoomUrl(this.platform, snapshot.id);
  }

  async checkLiveStatus(raw: string, cookie?: string): Promise<LiveStatusResult> {
    try {
      return (await this.roomSnapshot(this.roomFromUrl(raw), cookie)).live;
    } catch (error) {
      const failure = error instanceof AppError ? error : protocolChanged('直播平台');
      return { status: failure.code === 'PLATFORM_ACCESS_RESTRICTED' ? 'restricted' : 'error', error: failure.toObject() };
    }
  }

  protected async roomSnapshot(room: string, cookie?: string, fresh = false): Promise<Snapshot> {
    const scope = accountScope(cookie);
    const key = `${scope}:${room}`;
    const active = this.roomRequests.get(key);
    if (active) return active;
    const saved = this.snapshots.get(key);
    if (!fresh && saved && saved.expiresAt > Date.now()) return saved.snapshot;
    const request = this.fetchRoom(room, cookie).then(snapshot => {
      const entry = { snapshot, expiresAt: Date.now() + SNAPSHOT_MS };
      boundedSet(this.snapshots, key, entry);
      if (snapshot.id !== room) boundedSet(this.snapshots, `${scope}:${snapshot.id}`, entry);
      return snapshot;
    }).finally(() => this.roomRequests.delete(key));
    this.roomRequests.set(key, request);
    return request;
  }

  noteMediaSourceFailure(roomUrl: string, sourceUrl: string): void {
    const room = parseChineseRoomLink(this.platform, roomUrl);
    const host = httpsUrl(sourceUrl)?.hostname;
    if (room && host) boundedSet(this.failedSources, room, { host, expiresAt: Date.now() + 30_000 });
  }

  resolveRecordingSource(raw: string, quality: Quality, cookie?: string, context?: { previousStreamUrl?: string }): Promise<RecordingSourceResult> {
    const previousHost = httpsUrl(context?.previousStreamUrl)?.hostname;
    return this.resolveSource(raw, quality, cookie, previousHost, Boolean(previousHost));
  }

  resolvePreviewSource(raw: string, quality: Quality, cookie?: string, context?: { fresh?: boolean }): Promise<PreviewSourceResult> {
    return this.resolveSource(raw, quality, cookie, undefined, context?.fresh);
  }

  async getStreamUrl(raw: string, quality: Quality, cookie?: string): Promise<StreamUrlResult> {
    const result = await this.resolveSource(raw, quality, cookie);
    if (result.status === 'live') return result.stream;
    if (result.error) throw AppError.fromObject(result.error);
    throw new AppError('ROOM_CONTENT_UNAVAILABLE', '直播间未开播');
  }

  private async resolveSource(raw: string, quality: Quality, cookie?: string, previousHost?: string, fresh = false): Promise<RecordingSourceResult> {
    try {
      const room = this.roomFromUrl(raw);
      const failure = this.failedSources.get(room);
      const avoid = previousHost ?? (failure && failure.expiresAt > Date.now() ? failure.host : undefined);
      const key = JSON.stringify([room, quality, accountScope(cookie), avoid, fresh || Boolean(avoid)]);
      let request = this.sourceRequests.get(key);
      if (!request) {
        request = this.lookupSource(room, quality, cookie, avoid, fresh || Boolean(avoid))
          .finally(() => this.sourceRequests.delete(key));
        this.sourceRequests.set(key, request);
      }
      return await request;
    } catch (error) {
      const failure = error instanceof AppError ? error : protocolChanged('直播平台');
      return { status: failure.code === 'PLATFORM_ACCESS_RESTRICTED' ? 'restricted' : 'error', error: failure.toObject() };
    }
  }

  private async lookupSource(room: string, quality: Quality, cookie: string | undefined, avoid: string | undefined, fresh: boolean): Promise<RecordingSourceResult> {
    const snapshot = await this.roomSnapshot(room, cookie, fresh);
    const { live } = snapshot;
    if (live.status === 'offline') return { status: 'offline' };
    if (live.status !== 'live') throw live.error ? AppError.fromObject(live.error) : protocolChanged('直播平台');
    return { status: 'live', stream: await this.fetchStream(snapshot, quality, cookie, avoid) };
  }
}

export { HttpLiveAdapter };
