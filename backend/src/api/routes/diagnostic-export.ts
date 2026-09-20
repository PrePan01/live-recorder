import { writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../../core/services.js';
import { AppError } from '../../types/error.js';
import { createDiagnosticBundle } from '../diagnostic-bundle.js';
import { nativePickSaveFile } from './settings.js';

export interface DiagnosticExportFileResult {
  ok: true;
  saved: boolean;
  path: string | null;
  reason: 'cancelled' | 'no-dialog' | null;
}

function fileName(services: Services): string {
  return `live-recorder-diagnostics-${services.clock.iso().slice(0, 10)}.zip`;
}

export function registerDiagnosticExportRoutes(app: FastifyInstance, services: Services): void {
  app.post('/api/v1/diagnostics/export-file', async (req, reply) => {
    const body = (req.body ?? {}) as { frontendDiagnostics?: unknown; includeRooms?: unknown };
    if (process.env.VITEST === 'true') return reply.send({ ok: true, saved: false, path: null, reason: 'cancelled' } satisfies DiagnosticExportFileResult);
    const picked = await nativePickSaveFile({
      defaultName: fileName(services),
      prompt: '选择诊断日志保存位置',
      extension: 'zip',
      filter: 'ZIP 诊断包 (*.zip)|*.zip',
    });
    if (picked.status === 'unsupported') return reply.send({ ok: true, saved: false, path: null, reason: 'no-dialog' } satisfies DiagnosticExportFileResult);
    if (picked.status === 'cancelled') return reply.send({ ok: true, saved: false, path: null, reason: 'cancelled' } satisfies DiagnosticExportFileResult);
    try {
      const target = /\.zip$/i.test(picked.path) ? picked.path : `${picked.path}.zip`;
      await writeFile(target, await createDiagnosticBundle(services, { frontendDiagnostics: body.frontendDiagnostics, includeRooms: body.includeRooms !== false }));
      return reply.send({ ok: true, saved: true, path: target, reason: null } satisfies DiagnosticExportFileResult);
    } catch {
      throw new AppError('CONFIG_EXPORT_FAILED', '无法写入诊断日志到所选位置');
    }
  });

  app.post('/api/v1/diagnostics/export-download', async (req, reply) => {
    const body = (req.body ?? {}) as { frontendDiagnostics?: unknown; includeRooms?: unknown };
    const archive = await createDiagnosticBundle(services, { frontendDiagnostics: body.frontendDiagnostics, includeRooms: body.includeRooms !== false });
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', `attachment; filename="${fileName(services)}"`)
      .send(archive);
  });
}
