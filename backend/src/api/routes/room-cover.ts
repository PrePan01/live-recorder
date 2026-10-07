import { writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Services } from '../../core/services.js';
import type { Room } from '../../types/room.js';
import { AppError } from '../../types/error.js';
import {
  nativePickSaveFile,
  type SaveFileOptions,
  type SaveFilePick,
} from './settings.js';

const MAX_BYTES = 8 * 1024 * 1024;
const CDN_DOMAINS = [
  'hdslb.com',
  'biliimg.com',
  'douyinpic.com',
  'douyinstatic.com',
  'byteimg.com',
  'ibytedtos.com',
  'pstatp.com',
];
function validateUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port)) ||
    !CDN_DOMAINS.some(
      (domain) =>
        url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    )
  ) {
    throw new Error('封面地址无效');
  }
  return url;
}

function imageFormat(
  bytes: Buffer,
): { type: string; extension: string } | null {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return { type: 'image/jpeg', extension: 'jpg' };
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { type: 'image/png', extension: 'png' };
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)))
    return { type: 'image/gif', extension: 'gif' };
  if (
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return { type: 'image/webp', extension: 'webp' };
  if (
    bytes.toString('ascii', 4, 8) === 'ftyp' &&
    ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12))
  )
    return { type: 'image/avif', extension: 'avif' };
  return null;
}

export async function fetchRoomCover(
  room: Room,
  fetcher: typeof fetch = fetch,
) {
  if (room.lastLiveStatus !== 'live' || !room.liveCoverUrl) {
    throw new AppError('RESOURCE_NOT_FOUND', '暂无直播封面', {
      roomId: room.id,
    });
  }
  try {
    let url = validateUrl(room.liveCoverUrl);
    const signal = AbortSignal.timeout(8_000);
    let response: Response | undefined;
    for (let hop = 0; hop < 4; hop++) {
      response = await fetcher(url, {
        signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Referer:
            room.platform === 'bilibili'
              ? 'https://live.bilibili.com/'
              : 'https://live.douyin.com/',
        },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('封面重定向无效');
      url = validateUrl(new URL(location, url).href);
      response = undefined;
    }
    if (!response?.ok || !response.body)
      throw new Error('平台封面暂时无法访问');
    if (
      !response.headers.get('content-type')?.toLowerCase().startsWith('image/')
    ) {
      await response.body.cancel();
      throw new Error('平台未返回图片');
    }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body.cancel();
      throw new Error('封面图片过大');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error('封面图片过大');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel();
    }
    const bytes = Buffer.concat(chunks);
    const format = imageFormat(bytes);
    if (!format) throw new Error('封面图片格式不受支持');
    return { bytes, ...format };
  } catch (error) {
    throw new AppError(
      'NETWORK_UNAVAILABLE',
      error instanceof Error && error.name !== 'TimeoutError'
        ? `封面获取失败：${error.message}`
        : '封面获取超时，请重试',
      { roomId: room.id, retryable: true },
    );
  }
}

export function coverFileName(
  room: Room,
  extension: string,
  now: Date,
): string {
  // Names also enter AppleScript/PowerShell dialog arguments: strip quotes and control characters.
  const name =
    (room.displayName || '直播间')
      .replace(/[<>:"/\\|?*'`$\x00-\x1f\x7f]/g, '_')
      .trim()
      .slice(0, 60) || '直播间';
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${name}-直播封面-${timestamp}.${extension}`;
}

export function registerRoomCoverRoutes(
  app: FastifyInstance,
  services: Services,
  deps: {
    fetcher?: typeof fetch;
    pickSave?: (options: SaveFileOptions) => Promise<SaveFilePick>;
    write?: typeof writeFile;
  } = {},
): void {
  const getRoom = (id: string) => {
    const room = services.rooms.get(id);
    if (!room)
      throw new AppError('RESOURCE_NOT_FOUND', '直播间不存在', { roomId: id });
    return room;
  };
  app.get<{ Params: { id: string }; Querystring: { download?: string } }>(
    '/api/v1/rooms/:id/cover',
    async (req, reply) => {
      const room = getRoom(req.params.id);
      const cover = await fetchRoomCover(room, deps.fetcher);
      reply.type(cover.type).header('X-Content-Type-Options', 'nosniff');
      if (req.query.download === '1') {
        const name = coverFileName(
          room,
          cover.extension,
          new Date(services.clock.now()),
        );
        reply.header(
          'Content-Disposition',
          `attachment; filename="live-cover.${cover.extension}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
        // Browser fallback reads the filename through Axios across origins.
        reply.header('Access-Control-Expose-Headers', 'Content-Disposition');
      } else reply.header('Cache-Control', 'private, max-age=30');
      return reply.send(cover.bytes);
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/v1/rooms/:id/cover/save',
    async (req, reply) => {
      const room = getRoom(req.params.id);
      const cover = await fetchRoomCover(room, deps.fetcher);
      const picked = await (deps.pickSave ?? nativePickSaveFile)({
        defaultName: coverFileName(
          room,
          cover.extension,
          new Date(services.clock.now()),
        ),
        prompt: '选择直播封面保存位置',
        extension: cover.extension,
        filter: `图片 (*.${cover.extension})|*.${cover.extension}`,
      });
      if (picked.status !== 'saved')
        return reply.send({
          ok: true,
          saved: false,
          path: null,
          reason: picked.status === 'unsupported' ? 'no-dialog' : 'cancelled',
        });
      const path = picked.path.toLowerCase().endsWith(`.${cover.extension}`)
        ? picked.path
        : `${picked.path}.${cover.extension}`;
      try {
        await (deps.write ?? writeFile)(path, cover.bytes);
      } catch {
        throw new AppError('CONFIG_EXPORT_FAILED', '无法将封面保存到所选位置', {
          roomId: room.id,
        });
      }
      return reply.send({ ok: true, saved: true, path, reason: null });
    },
  );
}
