import type { ErrorObject, Platform, Quality } from '../types/index.js';

export type { Quality };

export interface LiveStatusResult {
  status: 'offline' | 'live' | 'restricted' | 'error';
  streamSessionId?: string;
  streamTitle?: string;
  displayName?: string;
  availableQualities?: Quality[];
  error?: ErrorObject;
  /** V5 #128 标题来源：adapter=主源识别、fallback=回退源、placeholder=安全占位。 */
  titleSource?: 'adapter' | 'fallback' | 'placeholder';
  /** V5 #128 是否使用了回退源（主源不可用但回退成功）。 */
  titleFallbackUsed?: boolean;
}

export interface StreamUrlResult {
  url: string;
  format: 'flv' | 'hls';
  actualQuality: Quality;
  headers?: Record<string, string>;
}

export interface PlatformAdapter {
  readonly platform: Platform;
  checkLiveStatus(roomUrl: string, cookie?: string): Promise<LiveStatusResult>;
  getStreamUrl(roomUrl: string, quality: Quality, cookie?: string): Promise<StreamUrlResult>;
  normalizeUrl(rawUrl: string): string;
  validateUrl(rawUrl: string): boolean;
}
