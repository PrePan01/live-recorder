import { access, mkdir, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';
import { DEFAULT_SETTINGS } from '../../config/defaults.js';
import type { AppSettings, MailConfig, SettingsView } from '../../types/index.js';
import { validateSettings } from '../../config/schema.js';
import { MAIL_PASSWORD_KEY } from '../../security/keys.js';

async function settingsView(services: Services): Promise<SettingsView> {
  const stored = services.settings.load();
  const settings: AppSettings = stored ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings);
  const passwordSet = await services.secretStore.has(MAIL_PASSWORD_KEY);
  const mail = { ...settings.mail, passwordSet };
  return {
    recordingDirectory: settings.recordingDirectory,
    maxConcurrentRecordings: settings.maxConcurrentRecordings,
    quality: settings.quality,
    checkIntervalSec: settings.checkIntervalSec,
    retry: settings.retry,
    diskGuard: settings.diskGuard,
    mail,
  };
}

export function registerSettingsRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/settings', async (_req, reply) => {
    return reply.send({ settings: await settingsView(services) });
  });

  app.put('/api/v1/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<AppSettings> & { mail?: MailConfig & { password?: string } };
    const password = typeof body.mail?.password === 'string' && body.mail.password.length > 0 ? body.mail.password : null;
    const incoming = structuredClone(body) as AppSettings & { mail?: MailConfig & { password?: string } };
    if (incoming.mail) delete incoming.mail.password;
    const merged: AppSettings = {
      ...(services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings)),
      ...incoming,
      mail: { ...(services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings)).mail, ...incoming.mail } as MailConfig,
    };
    validateSettings(merged);
    services.settings.save(merged);
    if (password !== null) await services.secretStore.set(MAIL_PASSWORD_KEY, password);
    if (body.mail?.password === '') await services.secretStore.delete(MAIL_PASSWORD_KEY);
    const view = await settingsView(services);
    services.events.emit({ type: 'settings:updated', data: view });
    return reply.send({ settings: view });
  });

  app.post('/api/v1/settings/validate-directory', async (req, reply) => {
    const body = (req.body ?? {}) as { directory?: string };
    const dir = typeof body.directory === 'string' ? body.directory : '';
    if (dir.length === 0 || !path.isAbsolute(dir)) {
      throw new AppError('DIRECTORY_NOT_WRITABLE', '目录不存在或不可写');
    }
    try {
      await mkdir(dir, { recursive: true });
      const probe = path.join(dir, `.lr-probe-${services.clock.now()}`);
      await writeFile(probe, 'x', { flag: 'wx' });
      await rm(probe, { force: true });
      await access(dir, constants.W_OK);
    } catch {
      throw new AppError('DIRECTORY_NOT_WRITABLE', '目录不存在或不可写');
    }
    return reply.send({ ok: true });
  });

  app.post('/api/v1/settings/test-smtp', async (_req, reply) => {
    const stored = services.settings.load();
    if (!stored || !stored.mail.host) {
      throw new AppError('SMTP_SEND_FAILED', 'SMTP 未配置', { retryable: true });
    }
    try {
      await services.mailer.send(stored.mail, {
        to: stored.mail.recipients,
        subject: '[直播录制助手] SMTP 测试',
        text: '这是一封测试邮件。',
      });
    } catch {
      throw new AppError('SMTP_SEND_FAILED', '邮件发送失败', { retryable: true });
    }
    return reply.send({ ok: true });
  });
}
