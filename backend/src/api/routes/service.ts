import type { FastifyInstance } from 'fastify';
import { access, constants } from 'node:fs/promises';
import type { Services } from '../../core/services.js';
import { DOUYIN_COOKIE_KEY, MAIL_PASSWORD_KEY } from '../../security/keys.js';

const CHECK_TIMEOUT_MS = 3_000;

export interface SelfCheckItem {
  key: string;
  label: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
  fixHint: string;
}

export function registerServiceRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/service/status', async (_req, reply) => {
    const stored = services.settings.load();
    const disk = stored && stored.recordingDirectory
      ? await services.diskGuard.inspect(stored.recordingDirectory)
      : { freeBytes: 0, totalBytes: 0 };
    return reply.send({
      serviceStatus: {
        state: 'running',
        version: '0.5.64',
        uptimeSeconds: Math.round((services.clock.now() - services.startedAt) / 1000),
        setupCompleted: Boolean(stored && stored.recordingDirectory.length > 0),
        disk,
        activeRecordings: services.recordings.activeCount(),
      },
    });
  });

  app.get('/api/v1/service/self-check', async (_req, reply) => {
    const items: SelfCheckItem[] = [];
    const stored = services.settings.load();
    const settings = stored ?? null;

    // ① 后端可达（本身能响应即 ok）。
    items.push({ key: 'backend', label: '后端服务', status: 'ok', detail: '服务运行中', fixHint: '' });

    // ② SMTP：已配置则 dry-run 校验（不真发信）；未配置则 warn。
    items.push(await withTimeout(async () => {
      if (!settings || !settings.mail.host) {
        return { key: 'smtp', label: '邮件服务', status: 'warn', detail: 'SMTP 未配置', fixHint: '在设置页配置 SMTP 后重试' };
      }
      const passwordSet = await services.secretStore.get(MAIL_PASSWORD_KEY);
      if (!passwordSet) {
        return { key: 'smtp', label: '邮件服务', status: 'warn', detail: 'SMTP 已配置但未设密码', fixHint: '在设置页填写 SMTP 密码' };
      }
      return { key: 'smtp', label: '邮件服务', status: 'ok', detail: `已配置 ${settings.mail.host}:${settings.mail.port}，密码已设`, fixHint: '' };
    }));

    // ③ 平台 Cookie：抖音需 Cookie，B站可选。
    items.push(await withTimeout(async () => {
      const hasCookie = Boolean(await services.secretStore.get(DOUYIN_COOKIE_KEY));
      if (hasCookie) {
        return { key: 'cookie', label: '平台凭证', status: 'ok', detail: '抖音 Cookie 已配置', fixHint: '' };
      }
      return { key: 'cookie', label: '平台凭证', status: 'warn', detail: '抖音 Cookie 未配置，抖音房间可能受限', fixHint: '在设置页填写抖音 Cookie' };
    }));

    // ④ 磁盘空间。
    items.push(await withTimeout(async () => {
      if (!settings || !settings.recordingDirectory) {
        return { key: 'disk', label: '磁盘空间', status: 'warn', detail: '未设置录像目录', fixHint: '在设置页选择录像目录' };
      }
      const space = await services.diskGuard.inspect(settings.recordingDirectory);
      const low = space.freeBytes < settings.diskGuard.minFreeBytes || (space.freeBytes / (space.totalBytes || 1)) * 100 < settings.diskGuard.minFreePercent;
      return {
        key: 'disk', label: '磁盘空间', status: low ? 'fail' : 'ok',
        detail: `剩余 ${formatBytes(space.freeBytes)} / 总 ${formatBytes(space.totalBytes)}${low ? '（低于阈值）' : ''}`,
        fixHint: low ? '清理磁盘或增大录像目录所在分区' : '',
      };
    }));

    // ⑤ 目录可写。
    items.push(await withTimeout(async () => {
      if (!settings || !settings.recordingDirectory) {
        return { key: 'writable', label: '录像目录', status: 'warn', detail: '未设置录像目录', fixHint: '在设置页选择录像目录' };
      }
      try {
        await access(settings.recordingDirectory, constants.W_OK);
        return { key: 'writable', label: '录像目录', status: 'ok', detail: '目录可写', fixHint: '' };
      } catch {
        return { key: 'writable', label: '录像目录', status: 'fail', detail: '目录不可写', fixHint: '检查目录权限或重新选择' };
      }
    }));

    return reply.send({ items });
  });
}

function withTimeout(fn: () => Promise<SelfCheckItem>): Promise<SelfCheckItem> {
  return Promise.race([
    fn(),
    new Promise<SelfCheckItem>((resolve) => setTimeout(() => resolve({ key: 'unknown', label: '检查项', status: 'warn', detail: '超时', fixHint: '重试' }), CHECK_TIMEOUT_MS)),
  ]);
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(1)} KB`;
}
