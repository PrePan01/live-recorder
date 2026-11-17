import { AppError } from '../../types/error.js';
import type { FastifyInstance } from 'fastify';

import { NativeBrowserBroker, registerNativeBrowserRoutes } from '../native-browser.js';
const PATHS = new Map([
  ['/api/sns/web/v1/user/selfinfo', 'edith.xiaohongshu.com'],
  ['/api/sns/web/v1/user/otherinfo', 'edith.xiaohongshu.com'],
  ['/api/sns/web/v1/user/hover_card', 'edith.xiaohongshu.com'],
  ['/api/sns/red/live/h5/v1/interaction/get_simple_interaction', 'live-room.xiaohongshu.com'],
  ['/api/sns/red/live/h5/v1/core/current_live_status', 'live-room.xiaohongshu.com'],
]);
export function isXhsNativeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && PATHS.get(url.pathname) === url.hostname;
  } catch { return false; }
}

export class XiaohongshuNativeBroker extends NativeBrowserBroker {
  constructor() {
    super(
      isXhsNativeUrl,
      () => new AppError('PLATFORM_ACCESS_RESTRICTED', '请在桌面客户端登录小红书后重试', { retryable: true }),
      () => new AppError('NETWORK_UNAVAILABLE', '小红书官网请求未完成，请稍后重试', { retryable: true }),
    );
  }
}

export function registerXhsNativeRoutes(app: FastifyInstance, broker: XiaohongshuNativeBroker): void {
  registerNativeBrowserRoutes(app, 'xiaohongshu', broker);
}
