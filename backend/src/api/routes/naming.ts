import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';
import type { Platform, Quality } from '../../types/index.js';
import { DEFAULT_NAMING_RULE, NAMING_VARS } from '../../types/index.js';

const MAX_TEMPLATE_LEN = 200;
const MAX_BASE_LEN = 120;

export interface NamingContext {
  room: string;
  platform: Platform;
  date: string;
  time: string;
  quality: Quality;
  roomId: string;
}

/** 模板解析：#115 变量替换 + 非法字符过滤 + 长度截断 + 空结果回退。 */
export function resolveNaming(template: string, ctx: NamingContext, disambiguator: string): string {
  let name = template;
  for (const v of NAMING_VARS) {
    const value = v === 'room' ? sanitizeToken(ctx.room) : v === 'platform' ? ctx.platform : v === 'roomId' ? ctx.roomId : v === 'quality' ? ctx.quality : ctx[v];
    name = name.replaceAll(`{${v}}`, String(value));
  }
  // 过滤非法字符（Windows 保留符 + 控制字符），压缩连续分隔符。
  name = sanitizeToken(name);
  // 空模板或全部变量被清空 → 回退用 disambiguator。
  if (!name) name = sanitizeToken(disambiguator);
  // 截断（保留扩展名由调用方处理）。
  return name.slice(0, MAX_BASE_LEN) || 'recording';
}

function sanitizeToken(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^_+|_+$/g, '').replace(/\s+/g, '_');
}

export function registerNamingRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/settings/naming-rule', async (_req, reply) => {
    const settings = services.settings.load();
    return reply.send({ namingRule: settings?.namingRule ?? DEFAULT_NAMING_RULE });
  });

  app.put('/api/v1/settings/naming-rule', async (req, reply) => {
    const body = (req.body ?? {}) as { namingRule?: unknown };
    if (typeof body.namingRule !== 'string' || body.namingRule.length === 0 || body.namingRule.length > MAX_TEMPLATE_LEN) {
      throw new AppError('CONFIG_INVALID', `namingRule 需为 1-${MAX_TEMPLATE_LEN} 字符`);
    }
    const settings = services.settings.load() ?? ({ recordingDirectory: '' } as Record<string, unknown>);
    const next = { ...settings, namingRule: body.namingRule };
    services.settings.save(next as never);
    const view = await (await import('./settings-view.js')).settingsView(services);
    services.events.emit({ type: 'settings:updated', data: view });
    return reply.send({ namingRule: body.namingRule });
  });

  // 实时示例：给定占位值渲染模板（FE 输入时预览）。
  app.post('/api/v1/settings/naming-rule/preview', async (req, reply) => {
    const body = (req.body ?? {}) as { namingRule?: unknown; room?: unknown; platform?: unknown };
    const template = typeof body.namingRule === 'string' && body.namingRule.length > 0 ? body.namingRule : DEFAULT_NAMING_RULE;
    if (template.length > MAX_TEMPLATE_LEN) throw new AppError('CONFIG_INVALID', `namingRule 过长`);
    const ctx: NamingContext = {
      room: typeof body.room === 'string' && body.room ? body.room : '主播名',
      platform: body.platform === 'douyin' ? 'douyin' : 'bilibili',
      date: '2026-08-29',
      time: '18_30_00',
      quality: '1080p',
      roomId: 'room_01J...',
    };
    return reply.send({ example: resolveNaming(template, ctx, 'recording') });
  });
}