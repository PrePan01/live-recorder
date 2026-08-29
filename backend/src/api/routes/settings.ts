import { access, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';
import { DEFAULT_SETTINGS } from '../../config/defaults.js';
import type { AppSettings, MailConfig, PipelineConfig } from '../../types/index.js';
import { validateSettings } from '../../config/schema.js';
import { DOUYIN_COOKIE_KEY, MAIL_PASSWORD_KEY } from '../../security/keys.js';
import { settingsView } from './settings-view.js';

export { settingsView };

export function registerSettingsRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/settings', async (_req, reply) => {
    return reply.send({ settings: await settingsView(services) });
  });

  app.put('/api/v1/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<AppSettings> & { mail?: MailConfig & { password?: string } } & { douyinCookie?: string };
    const password = typeof body.mail?.password === 'string' && body.mail.password.length > 0 ? body.mail.password : null;
    const douyinCookie = typeof body.douyinCookie === 'string' ? body.douyinCookie : null;
    const incoming = structuredClone(body) as AppSettings & { mail?: MailConfig & { password?: string } };
    if (incoming.mail) delete incoming.mail.password;
    delete (incoming as { douyinCookie?: string }).douyinCookie;
    const merged: AppSettings = {
      ...(services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings)),
      ...incoming,
      mail: { ...(services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings)).mail, ...incoming.mail } as MailConfig,
    };
    validateSettings(merged);
    services.settings.save(merged);
    if (password !== null) await services.secretStore.set(MAIL_PASSWORD_KEY, password);
    if (body.mail?.password === '') await services.secretStore.delete(MAIL_PASSWORD_KEY);
    if (douyinCookie !== null) {
      if (douyinCookie.length > 0) await services.secretStore.set(DOUYIN_COOKIE_KEY, douyinCookie);
      else await services.secretStore.delete(DOUYIN_COOKIE_KEY);
    }
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

  app.get('/api/v1/settings/browse-directories', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const requested = q.path && q.path.length > 0 ? q.path : os.homedir();
    if (!path.isAbsolute(requested)) {
      throw new AppError('DIRECTORY_NOT_WRITABLE', '仅支持绝对路径');
    }
    const target = path.resolve(requested);
    let entries;
    try {
      entries = await readdir(target, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError('RESOURCE_NOT_FOUND', '目录不存在', { details: { resource: 'directory' } });
      }
      throw new AppError('DIRECTORY_NOT_WRITABLE', '目录不可读或权限不足');
    }
    const directories = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(target) === target ? null : path.dirname(target);
    return reply.send({ ok: true, path: target, parent, directories });
  });

  app.post('/api/v1/settings/pick-directory', async (_req, reply) => {
    if (process.env.VITEST === 'true') return reply.send({ ok: true, directory: null });
    const directory = await nativePickDirectory();
    return reply.send({ ok: true, directory });
  });

  // V5 后处理管线配置契约：默认关闭、校验/切片/压缩/归档/并发 N=2。
  app.get('/api/v1/settings/pipeline', async (_req, reply) => {
    const settings = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings);
    return reply.send({ pipeline: settings.pipeline ?? structuredClone(DEFAULT_SETTINGS.pipeline) });
  });

  app.put('/api/v1/settings/pipeline', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<PipelineConfig>;
    const current = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings);
    const merged: PipelineConfig = { ...structuredClone(DEFAULT_SETTINGS.pipeline), ...current.pipeline, ...body };
    const err = validatePipelineConfig(merged);
    if (err) throw err;
    services.settings.save({ ...current, pipeline: merged });
    const view = await settingsView(services);
    services.events.emit({ type: 'settings:updated', data: view });
    return reply.send({ pipeline: merged });
  });
}

/** V5 管线配置校验：返回 AppError 或 null。 */
export function validatePipelineConfig(config: PipelineConfig): AppError | null {
  if (typeof config.enabled !== 'boolean') return new AppError('PIPELINE_CONFIG_INVALID', 'enabled 必须为布尔值');
  if (typeof config.verify !== 'boolean') return new AppError('PIPELINE_CONFIG_INVALID', 'verify 必须为布尔值');
  if (typeof config.segmentSeconds !== 'number' || config.segmentSeconds < 0 || config.segmentSeconds > 86400) {
    return new AppError('PIPELINE_CONFIG_INVALID', 'segmentSeconds 需在 0-86400 之间');
  }
  if (config.crf !== null && (typeof config.crf !== 'number' || config.crf < 0 || config.crf > 51)) {
    return new AppError('PIPELINE_CONFIG_INVALID', 'crf 需为 null 或 0-51 之间');
  }
  if (typeof config.archiveDirectory !== 'string') return new AppError('PIPELINE_CONFIG_INVALID', 'archiveDirectory 必须为字符串');
  if (typeof config.maxConcurrency !== 'number' || config.maxConcurrency < 1 || config.maxConcurrency > 2) {
    return new AppError('PIPELINE_CONFIG_INVALID', 'maxConcurrency 需为 1-2（V5 定 N=2）');
  }
  return null;
}

/** 系统原生目录选择器（macOS 访达 / Windows 资源管理器），取消返回 null。 */
export function nativePickDirectory(): Promise<string | null> {
  return new Promise((resolve) => {
    let command: string;
    let args: string[];
    if (process.platform === 'darwin') {
      command = 'osascript';
      args = ['-e', 'POSIX path of (choose folder with prompt "选择录像保存目录")'];
    } else if (process.platform === 'win32') {
      command = 'powershell';
      args = ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; if($f.ShowDialog() -eq 'OK'){ $f.SelectedPath }"];
    } else {
      command = 'zenity';
      args = ['--file-selection', '--directory'];
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const picked = out.trim();
      resolve(picked.length > 0 ? picked : null);
    });
  });
}
