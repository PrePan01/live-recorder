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
import { DOUYIN_COOKIE_KEY, BILIBILI_COOKIE_KEY, MAIL_PASSWORD_KEY } from '../../security/keys.js';
import { settingsView } from './settings-view.js';

export { settingsView };

const BILIBILI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function registerSettingsRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/settings', async (_req, reply) => {
    return reply.send({ settings: await settingsView(services) });
  });

  app.put('/api/v1/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<AppSettings> & { mail?: MailConfig & { password?: string } } & { douyinCookie?: string; bilibiliCookie?: string };
    const password = typeof body.mail?.password === 'string' && body.mail.password.length > 0 ? body.mail.password : null;
    const douyinCookie = typeof body.douyinCookie === 'string' ? normalizeDouyinCookie(body.douyinCookie) : null;
    const bilibiliCookie = typeof body.bilibiliCookie === 'string' ? normalizeBilibiliCookie(body.bilibiliCookie) : null;
    const incoming = structuredClone(body) as AppSettings & { mail?: MailConfig & { password?: string } };
    if (incoming.mail) delete incoming.mail.password;
    delete (incoming as { douyinCookie?: string }).douyinCookie;
    delete (incoming as { bilibiliCookie?: string }).bilibiliCookie;
    const merged: AppSettings = {
      ...(services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings)),
      ...incoming,
      mail: { ...(services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings)).mail, ...incoming.mail } as MailConfig,
    };
    validateSettings(merged);
    services.settings.save(merged);
    if (merged.highlightEnabled === false) await services.manager.disableAllHighlightBuffers();
    if (password !== null) await services.secretStore.set(MAIL_PASSWORD_KEY, password);
    if (body.mail?.password === '') await services.secretStore.delete(MAIL_PASSWORD_KEY);
    if (douyinCookie !== null) {
      if (douyinCookie.length > 0) {
        validateDouyinCookie(douyinCookie);
        await services.secretStore.set(DOUYIN_COOKIE_KEY, douyinCookie);
        // 平台请求最久可超过前端 10 秒 HTTP 超时；后台复检既不阻塞保存，
        // 也会等待旧 Cookie 的在途请求结束后再用新 Cookie 发起全量检测。
        void services.scheduler.recheckDouyinRoomsAfterCookieUpdate().catch(() => undefined);
      } else {
        await services.secretStore.delete(DOUYIN_COOKIE_KEY);
      }
    }
    if (bilibiliCookie !== null) {
      if (bilibiliCookie.length > 0) {
        validateBilibiliCookie(bilibiliCookie);
        await services.secretStore.set(BILIBILI_COOKIE_KEY, bilibiliCookie);
        void services.scheduler.recheckBilibiliRoomsAfterCookieUpdate().catch(() => undefined);
      } else {
        await services.secretStore.delete(BILIBILI_COOKIE_KEY);
      }
    }
    const view = await settingsView(services);
    services.events.emit({ type: 'settings:updated', data: view });
    return reply.send({ settings: view });
  });

  // The desktop Douyin login webview obtains HttpOnly cookies through the native
  // cookie store.  Keep its write path deliberately narrow: it must not need to
  // round-trip the complete settings form just to persist an authorization.
  app.post('/api/v1/settings/douyin-cookie', async (req, reply) => {
    const body = (req.body ?? {}) as { cookie?: unknown };
    if (typeof body.cookie !== 'string') {
      throw new AppError('CONFIG_INVALID', '未读取到抖音登录凭证，请先在授权窗口完成登录后重试');
    }
    const cookie = normalizeDouyinCookie(body.cookie);
    validateDouyinCookie(cookie);
    await services.secretStore.set(DOUYIN_COOKIE_KEY, cookie);
    void services.scheduler.recheckDouyinRoomsAfterCookieUpdate().catch(() => undefined);
    const view = await settingsView(services);
    services.events.emit({ type: 'settings:updated', data: view });
    return reply.send({ settings: view });
  });

  // Settings loads this separately from the normal settings view so a slow or
  // temporarily unreachable Douyin endpoint never delays the entire page.
  app.get('/api/v1/settings/douyin-cookie-status', async (_req, reply) => {
    const cookie = await services.secretStore.get(DOUYIN_COOKIE_KEY);
    if (!cookie) return reply.send({ status: 'missing' });
    return reply.send({ status: await checkDouyinCookieStatus(cookie) });
  });

  // 与抖音授权同构：桌面端登录窗口通过原生 Cookie 库读取 HttpOnly 凭证后，
  // 只需写一个字段，不必回传整份设置表单。
  app.post('/api/v1/settings/bilibili-cookie', async (req, reply) => {
    const body = (req.body ?? {}) as { cookie?: unknown };
    if (typeof body.cookie !== 'string') {
      throw new AppError('CONFIG_INVALID', '未读取到B站登录凭证，请先在授权窗口完成登录后重试');
    }
    const cookie = normalizeBilibiliCookie(body.cookie);
    validateBilibiliCookie(cookie);
    await services.secretStore.set(BILIBILI_COOKIE_KEY, cookie);
    void services.scheduler.recheckBilibiliRoomsAfterCookieUpdate().catch(() => undefined);
    const view = await settingsView(services);
    services.events.emit({ type: 'settings:updated', data: view });
    return reply.send({ settings: view });
  });

  app.get('/api/v1/settings/bilibili-cookie-status', async (_req, reply) => {
    const cookie = await services.secretStore.get(BILIBILI_COOKIE_KEY);
    if (!cookie) return reply.send({ status: 'missing' });
    return reply.send({ status: await checkBilibiliCookieStatus(cookie) });
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

  // V5 邮件简化（Batch2 #117）：SMTP 服务商预设 + 独立 email 端点。
  app.get('/api/v1/settings/email/presets', async (_req, reply) => {
    return reply.send({ presets: SMTP_PRESETS });
  });

  app.get('/api/v1/settings/email', async (_req, reply) => {
    const view = await settingsView(services);
    return reply.send({ email: { ...view.mail, provider: detectProvider(view.mail.host) } });
  });

  app.put('/api/v1/settings/email', async (req, reply) => {
    const body = (req.body ?? {}) as MailConfig & { password?: string; provider?: string; recordingDirectory?: string };
    const stored = services.settings.load() ?? (structuredClone(DEFAULT_SETTINGS) as unknown as AppSettings);
    const { password, provider, ...mailPatch } = body;
    void provider;
    // 顶层设置字段（如 recordingDirectory）合并，mail 单独合并。
    const topLevel = { ...stored, ...pickTopLevel(mailPatch as Record<string, unknown>) };
    const merged: AppSettings = { ...topLevel, mail: { ...stored.mail, ...mailPatch } };
    validateSettings(merged);
    services.settings.save(merged);
    if (typeof password === 'string') {
      if (password.length > 0) await services.secretStore.set(MAIL_PASSWORD_KEY, password);
      else await services.secretStore.delete(MAIL_PASSWORD_KEY);
    }
    const view = await settingsView(services);
    services.events.emit({ type: 'settings:updated', data: view });
    return reply.send({ email: { ...view.mail, provider: detectProvider(view.mail.host) } });
  });

  app.post('/api/v1/settings/email/test', async (_req, reply) => {
    const stored = services.settings.load();
    if (!stored || !stored.mail.host) throw new AppError('SMTP_SEND_FAILED', 'SMTP 未配置', { retryable: true });
    try {
      await services.mailer.send(stored.mail, {
        to: stored.mail.recipients,
        subject: '[直播录制助手] 邮件测试',
        text: '这是一封测试邮件。',
      });
    } catch {
      throw new AppError('SMTP_SEND_FAILED', '邮件发送失败', { retryable: true });
    }
    return reply.send({ ok: true });
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

type DouyinCookieStatus = 'valid' | 'invalid' | 'unknown';
type BilibiliCookieStatus = 'valid' | 'invalid' | 'unknown';

/** Verify a stored login session without exposing the cookie or response body. */
async function checkDouyinCookieStatus(cookie: string): Promise<DouyinCookieStatus> {
  try {
    const response = await fetch('https://creator.douyin.com/web/api/media/user/info', {
      headers: {
        Cookie: cookie,
        Referer: 'https://creator.douyin.com/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return 'unknown';
    const body = await response.json() as { status_code?: unknown };
    if (body.status_code === 0) return 'valid';
    // Douyin returns 8 for an anonymous or expired web session.  Treat the
    // explicit credential/risk signal as invalid as well.
    if (body.status_code === 8 || body.status_code === 10011) return 'invalid';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 浏览器开发者工具有时会把 `Cookie:` 前缀或换行一并复制，规范化后再发给抖音。 */
function normalizeDouyinCookie(value: string): string {
  return value
    .replace(/^\s*cookie\s*:\s*/i, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/** 同 normalizeDouyinCookie：去掉 `Cookie:` 前缀与换行。 */
function normalizeBilibiliCookie(value: string): string {
  return value
    .replace(/^\s*cookie\s*:\s*/i, '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
}

/**
 * B站授权校验：`SESSDATA` 是 B站 的 HttpOnly 登录凭证，未登录时 getRoomPlayInfo
 * 只返回 720p 及以下档位，因此缺它就是「授权无效」而不是「稍后可用」。
 * `DedeUserID` 虽非 HttpOnly，但属登录凭证组的一部份，缺失说明复制不完整。
 */
function validateBilibiliCookie(cookie: string): void {
  const hasPair = /(?:^|;\s*)[^=;\s]+=[^;]*/.test(cookie);
  if (!hasPair) {
    throw new AppError('CONFIG_INVALID', 'B站 Cookie 格式无效，请粘贴完整 Cookie 字符串（形如 k=v; k2=v2）');
  }
  if (!/(?:^|;\s*)SESSDATA=[^;]+/.test(cookie)) {
    throw new AppError(
      'CONFIG_INVALID',
      'Cookie 缺少 SESSDATA（B站 HttpOnly 登录凭证，方式一 document.cookie 读取不到）。请改用方式二：F12 → 网络(Network) → 点开任意 live.bilibili.com 请求 → 在「请求标头」里复制完整 Cookie 整段',
    );
  }
  if (!/(?:^|;\s*)DedeUserID=[^;]+/.test(cookie)) {
    throw new AppError(
      'CONFIG_INVALID',
      'Cookie 缺少登录凭证 DedeUserID。请确认已在上方窗口完成 B站 登录，并复制完整 Cookie',
    );
  }
}

/** B站 登录态探测：nav 接口仅在已登录时返回 code=0 且 isLogin=true。 */
async function checkBilibiliCookieStatus(cookie: string): Promise<BilibiliCookieStatus> {
  try {
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: {
        Cookie: cookie,
        Referer: 'https://www.bilibili.com/',
        'User-Agent': BILIBILI_UA,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return 'unknown';
    const body = await response.json() as { code?: unknown; data?: { isLogin?: unknown } };
    if (body.code === 0 && body.data?.isLogin === true) return 'valid';
    // -101 账号未登录是 B站 对匿名/过期会话的明确答复。
    if (body.code === -101 || body.data?.isLogin === false) return 'invalid';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * #30 抖音 Cookie 校验：方式一 `copy(document.cookie)` 只能读取非 HttpOnly 的 Cookie，
 * 而抖音的 `ttwid`（反爬必需）与 `sessionid`（登录凭证）均标记 HttpOnly，取不到 → 取流「身份验证失败」。
 * 这里在保存时校验必需字段，缺失即明确报错并引导改用方式二（网络面板复制完整 Cookie），
 * 避免保存一个永远不可用的 Cookie 后反复困惑。
 */
function validateDouyinCookie(cookie: string): void {
  const hasPair = /(?:^|;\s*)[^=;\s]+=[^;]*/.test(cookie);
  if (!hasPair) {
    throw new AppError('CONFIG_INVALID', '抖音 Cookie 格式无效，请粘贴完整 Cookie 字符串（形如 k=v; k2=v2）');
  }
  if (!/(?:^|;\s*)ttwid=[^;]+/.test(cookie)) {
    throw new AppError(
      'CONFIG_INVALID',
      'Cookie 缺少 ttwid（抖音 HttpOnly 凭证，方式一 document.cookie 读取不到）。请改用方式二：F12 → 网络(Network) → 点开任意 live.douyin.com 请求 → 在「请求标头」里复制完整 Cookie 整段',
    );
  }
  if (!/(?:^|;\s*)(?:sessionid|sessionid_ss)=[^;]+/.test(cookie)) {
    throw new AppError(
      'CONFIG_INVALID',
      'Cookie 缺少登录凭证 sessionid（HttpOnly）。请确认已在浏览器登录抖音，并用方式二从网络面板复制完整 Cookie',
    );
  }
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

/** V5 邮件服务商预设（#117）：常用 SMTP 一键填充。 */
export const SMTP_PRESETS = [
  { id: 'qq', name: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: true },
  { id: '163', name: '网易 163', host: 'smtp.163.com', port: 465, secure: true },
  { id: 'gmail', name: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true },
  { id: 'outlook', name: 'Outlook', host: 'smtp-mail.outlook.com', port: 587, secure: false },
  { id: 'custom', name: '自定义', host: '', port: 465, secure: true },
] as const;

/** 按 host 探测服务商 id（供 FE 预设下拉回显）。 */
export function detectProvider(host: string): string {
  if (!host) return 'custom';
  const found = SMTP_PRESETS.find((p) => p.host && host.includes(p.host.replace(/^smtp\./, '')));
  return found ? found.id : 'custom';
}

/** 从 mail 更新 payload 中提取顶层设置字段（非 MailConfig 键）。 */
function pickTopLevel(body: Record<string, unknown>): Record<string, unknown> {
  const mailKeys = new Set(['enabled', 'host', 'port', 'secure', 'username', 'from', 'recipients']);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!mailKeys.has(k)) out[k] = v;
  }
  return out;
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
      args = ['-NoProfile', '-Command', "Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.FolderBrowserDialog; if($f.ShowDialog() -eq 'OK'){ [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($f.SelectedPath)) }"];
    } else {
      command = 'zenity';
      args = ['--file-selection', '--directory'];
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const picked = out.trim();
      resolve(picked.length > 0 ? decodeDialogPath(picked) : null);
    });
  });
}

/**
 * 还原对话框回传的路径。Windows 分支的 PowerShell 回传 base64：管道输出的编码由控制台
 * 代码页决定，中文路径按 UTF-8 解码会乱码，base64 只含 ASCII 不受影响。
 */
function decodeDialogPath(raw: string): string {
  return process.platform === 'win32' ? Buffer.from(raw, 'base64').toString('utf8') : raw;
}

export type SaveFilePick =
  | { status: 'saved'; path: string }
  | { status: 'cancelled' }
  | { status: 'unsupported' };

/** 系统原生“另存为”选择器；用户取消返回 cancelled，无原生对话框可用时返回 unsupported。 */
export interface SaveFileOptions {
  defaultName: string;
  prompt?: string;
  extension?: string;
  filter?: string;
}

export function nativePickSaveFile(options: SaveFileOptions | string): Promise<SaveFilePick> {
  const { defaultName, prompt = '选择配置文件保存位置', extension = 'json', filter = 'JSON 文件 (*.json)|*.json' } = typeof options === 'string' ? { defaultName: options } : options;
  return new Promise((resolve) => {
    let command: string;
    let args: string[];
    if (process.platform === 'darwin') {
      command = 'osascript';
      args = ['-e', `POSIX path of (choose file name with prompt "${prompt}" default name "${defaultName}")`];
    } else if (process.platform === 'win32') {
      command = 'powershell';
      args = [
        '-NoProfile',
        '-Command',
        `Add-Type -AssemblyName System.Windows.Forms; $f=New-Object System.Windows.Forms.SaveFileDialog; $f.FileName='${defaultName}'; $f.DefaultExt='${extension}'; $f.Filter='${filter}'; if($f.ShowDialog() -eq 'OK'){ [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($f.FileName)) }`,
      ];
    } else {
      command = 'zenity';
      args = ['--file-selection', '--save', '--confirm-overwrite', `--filename=${defaultName}`];
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let unsupported = false;
    child.stdout.on('data', (d) => (out += String(d)));
    child.on('error', () => {
      unsupported = true;
      resolve({ status: 'unsupported' });
    });
    child.on('close', () => {
      if (unsupported) return;
      const picked = out.trim();
      if (picked.length === 0) {
        resolve({ status: 'cancelled' });
        return;
      }
      resolve({ status: 'saved', path: decodeDialogPath(picked) });
    });
  });
}
