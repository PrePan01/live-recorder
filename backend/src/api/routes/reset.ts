import { lstat, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../../core/services.js';
import { AppError } from '../../types/error.js';
import { MAIL_PASSWORD_KEY, DOUYIN_COOKIE_KEY, OPENLIST_TOKEN_KEY } from '../../security/keys.js';

const SECRET_KEYS = [MAIL_PASSWORD_KEY, DOUYIN_COOKIE_KEY, OPENLIST_TOKEN_KEY];

export function registerResetRoutes(app: FastifyInstance, services: Services, otherWrites: () => number): void {
  app.post('/api/v1/settings/reset', async (req, reply) => {
    const body = req.body as { keepRecordings?: unknown; confirm?: unknown } | null;
    if (body?.confirm !== 'RESET' || typeof body.keepRecordings !== 'boolean') {
      throw new AppError('CONFIG_INVALID', '请确认重置并明确是否保留录像文件');
    }
    if (services.resetting || otherWrites() > 1 || services.scheduler.isChecking ||
        services.manager.busy || services.pipeline.busy || services.uploader.busy ||
        services.exporter.busy || services.notifier.busy) {
      throw new AppError('DIAGNOSTIC_CONFLICT', '存在进行中的检测、录制、转码、上传或导出任务，请结束后重试');
    }
    services.resetting = true;
    const wasRunning = services.scheduler.isRunning;
    services.scheduler.stop();
    const staged: Array<{ original: string; temporary: string }> = [];
    const secrets = new Map<string, string | null>();
    let committed = false;
    try {
      // Stop preview streams before clearing records.
      await services.manager.resetIdleState();
      for (const key of SECRET_KEYS) secrets.set(key, await services.secretStore.get(key));
      if (!body.keepRecordings) {
        // Only files explicitly associated with recordings; never recursively delete a user's directory.
        const rows = services.db.prepare(`
          SELECT file_path AS path FROM recordings WHERE file_path IS NOT NULL
          UNION SELECT cover_path AS path FROM recordings WHERE cover_path IS NOT NULL
          UNION SELECT path FROM pipeline_artifacts WHERE path IS NOT NULL
        `).all() as { path: string }[];
        const files = new Set(rows.map((row) => row.path).filter(Boolean));
        for (const file of files) {
          if (!path.isAbsolute(file)) throw new AppError('CONFIG_INVALID', '录像路径不是绝对路径，重置已取消');
          let info;
          try { info = await lstat(file); } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          if (!info.isFile() && !info.isSymbolicLink()) {
            throw new AppError('CONFIG_INVALID', '录像路径指向目录，重置已取消');
          }
          const temporary = path.join(path.dirname(file), `.lr-reset-${randomUUID()}`);
          await rename(file, temporary);
          staged.push({ original: file, temporary });
        }
      }
      for (const key of SECRET_KEYS) await services.secretStore.delete(key);
      services.db.transaction(() => {
        services.db.exec(`
          DELETE FROM diagnostic_actions;
          DELETE FROM diagnostics;
          DELETE FROM pipeline_artifacts;
          DELETE FROM pipeline_runs;
          DELETE FROM upload_jobs;
          DELETE FROM export_jobs;
          DELETE FROM recording_schedules;
          DELETE FROM room_tags;
          DELETE FROM tags;
          DELETE FROM recordings;
          DELETE FROM rooms;
          DELETE FROM alerts;
          DELETE FROM settings;
        `);
      })();
      committed = true;
      services.manager.clearPendingConfirmations();
      services.statsCache = undefined;
      services.notifier.reset();
      services.uploader.resetIdleState();
      const retainedFiles: string[] = [];
      for (const file of staged) {
        try { await unlink(file.temporary); }
        catch { retainedFiles.push(file.temporary); }
      }
      return reply.send({ ok: true, keptRecordings: body.keepRecordings, retainedFiles });
    } catch (error) {
      if (!committed) {
        const restored = await Promise.allSettled([
          ...staged.map((file) => rename(file.temporary, file.original)),
          ...[...secrets].map(([key, value]) => value === null ? services.secretStore.delete(key) : services.secretStore.set(key, value)),
        ]);
        if (restored.some((result) => result.status === 'rejected')) {
          throw new AppError('CONFIG_LOAD_FAILED', '重置失败，部分文件或凭证恢复失败，请保留数据目录并检查后重试');
        }
      }
      if (error instanceof AppError) throw error;
      throw new AppError('CONFIG_LOAD_FAILED', '重置失败，未清空配置数据，请检查文件权限或钥匙串访问权限');
    } finally {
      services.resetting = false;
      if (wasRunning) services.scheduler.start();
    }
  });
}
