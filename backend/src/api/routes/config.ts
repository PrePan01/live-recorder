import { writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { AppSettings, Platform } from '../../types/index.js';
import type { Services } from '../../core/services.js';
import { validateSettings } from '../../config/schema.js';
import { settingsView } from './settings-view.js';
import { DEFAULT_SETTINGS } from '../../config/defaults.js';
import { nativePickSaveFile } from './settings.js';
import { exportPredictionArchive, importPredictionArchive, type PredictionArchive, type PredictionImportSummary } from '../../core/prediction-archive.js';

export interface ExportConfig {
  version: 1;
  exportedAt: string;
  settings: Awaited<ReturnType<typeof settingsView>>;
  rooms: ReturnType<Services['rooms']['list']>;
  alerts: ReturnType<Services['alerts']['list']>;
  /** 开播预测的样本与校准数据；按 platform+url 归属，导入时映射到本地房间。 */
  prediction: PredictionArchive;
}

export interface ImportConfigInput {
  version?: number;
  settings?: Partial<AppSettings>;
  rooms?: Array<{ platform: string; url: string; displayName?: string; enabled?: boolean }>;
  alerts?: Array<{ level: string; source: string; message: string; occurredAt: string; resolved?: boolean }>;
  prediction?: unknown;
}

async function buildExportConfig(services: Services): Promise<ExportConfig> {
  return {
    version: 1,
    exportedAt: services.clock.iso(),
    settings: await settingsView(services),
    rooms: services.rooms.list(),
    alerts: services.alerts.list(),
    prediction: exportPredictionArchive(services),
  };
}

/** 把导出内容写入指定路径，返回实际写入的文件名。 */
export async function exportConfigToPath(services: Services, target: string): Promise<string> {
  const filePath = /\.json$/i.test(target) ? target : `${target}.json`;
  const payload = `${JSON.stringify({ config: await buildExportConfig(services) }, null, 2)}\n`;
  await writeFile(filePath, payload, 'utf8');
  return filePath;
}

export function registerConfigRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/config/export', async (_req, reply) => {
    return reply.send({ config: await buildExportConfig(services) });
  });

  app.post('/api/v1/config/export-file', async (_req, reply) => {
    if (process.env.VITEST === 'true') return reply.send({ ok: true, saved: false, path: null, reason: 'cancelled' });
    const picked = await nativePickSaveFile(`live-recorder-config-${services.clock.iso().slice(0, 10)}.json`);
    if (picked.status === 'unsupported') return reply.send({ ok: true, saved: false, path: null, reason: 'no-dialog' });
    if (picked.status === 'cancelled') return reply.send({ ok: true, saved: false, path: null, reason: 'cancelled' });
    try {
      const filePath = await exportConfigToPath(services, picked.path);
      return reply.send({ ok: true, saved: true, path: filePath, reason: null });
    } catch {
      throw new AppError('CONFIG_EXPORT_FAILED', '无法写入所选位置');
    }
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
    // 预测数据必须排在房间导入之后：房间先落地，样本才能按 platform+url 找到归属。
    let prediction: PredictionImportSummary | null = null;
    if (incoming.prediction !== undefined) {
      try {
        prediction = importPredictionArchive(services, incoming.prediction);
      } catch {
        throw new AppError('CONFIG_LOAD_FAILED', '开播预测数据导入失败', { details: { appliedSettings, importedRooms, skippedRooms } });
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
    return reply.send({ ok: true, appliedSettings, importedRooms, skippedRooms, importedAlerts, prediction });
  });
}
