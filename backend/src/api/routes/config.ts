import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { AppSettings, Platform } from '../../types/index.js';
import type { Services } from '../../core/services.js';
import { validateSettings } from '../../config/schema.js';
import { settingsView } from './settings-view.js';
import { DEFAULT_SETTINGS } from '../../config/defaults.js';

export interface ExportConfig {
  version: 1;
  exportedAt: string;
  settings: Awaited<ReturnType<typeof settingsView>>;
  rooms: ReturnType<Services['rooms']['list']>;
  alerts: ReturnType<Services['alerts']['list']>;
}

export interface ImportConfigInput {
  version?: number;
  settings?: Partial<AppSettings>;
  rooms?: Array<{ platform: string; url: string; displayName?: string; enabled?: boolean }>;
  alerts?: Array<{ level: string; source: string; message: string; occurredAt: string; resolved?: boolean }>;
}

export function registerConfigRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/config/export', async (_req, reply) => {
    const config: ExportConfig = {
      version: 1,
      exportedAt: services.clock.iso(),
      settings: await settingsView(services),
      rooms: services.rooms.list(),
      alerts: services.alerts.list(),
    };
    return reply.send({ config });
  });

  app.post('/api/v1/config/import', async (req, reply) => {
    const body = (req.body ?? {}) as { config?: ImportConfigInput };
    const incoming = body.config;
    if (!incoming || typeof incoming !== 'object') {
      throw new AppError('CONFIG_LOAD_FAILED', '导入内容缺失');
    }
    let appliedSettings = false;
    if (incoming.settings !== undefined) {
      const current = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings);
      const merged: AppSettings = {
        ...current,
        ...incoming.settings,
        mail: { ...current.mail, ...incoming.settings.mail } as AppSettings['mail'],
      };
      validateSettings(merged);
      services.settings.save(merged);
      appliedSettings = true;
    }
    let importedRooms = 0;
    let skippedRooms = 0;
    if (Array.isArray(incoming.rooms)) {
      const existing = new Set(services.rooms.list().map((r) => `${r.platform}|${r.url}`));
      try {
        for (const item of incoming.rooms) {
          if (!item || typeof item.url !== 'string' || (item.platform !== 'bilibili' && item.platform !== 'douyin')) continue;
          const key = `${item.platform}|${item.url}`;
          if (existing.has(key)) {
            skippedRooms += 1;
            continue;
          }
          services.rooms.create({
            platform: item.platform as Platform,
            url: item.url,
            displayName: typeof item.displayName === 'string' ? item.displayName : '',
            enabled: item.enabled ?? true,
          });
          existing.add(key);
          importedRooms += 1;
        }
      } catch (err) {
        throw new AppError('CONFIG_LOAD_FAILED', '房间导入失败', { details: { appliedSettings, importedRooms, skippedRooms } });
      }
    }
    let importedAlerts = 0;
    if (Array.isArray(incoming.alerts)) {
      try {
        for (const a of incoming.alerts) {
          if (!a || typeof a.message !== 'string' || a.resolved === true) continue;
          const level = a.level === 'error' || a.level === 'warning' ? a.level : 'info';
          services.alerts.create({ level, source: typeof a.source === 'string' ? a.source : 'import', message: a.message, occurredAt: typeof a.occurredAt === 'string' ? a.occurredAt : services.clock.iso() });
          importedAlerts += 1;
        }
      } catch {
        throw new AppError('CONFIG_LOAD_FAILED', '告警导入失败', { details: { appliedSettings, importedRooms, skippedRooms, importedAlerts } });
      }
    }
    if (appliedSettings) {
      services.events.emit({ type: 'settings:updated', data: await settingsView(services) });
    }
    return reply.send({ ok: true, appliedSettings, importedRooms, skippedRooms, importedAlerts });
  });
}