import type { Quality } from '../adapter.js';
import { httpsUrl, list, number, object, protocolChanged, qualityFromLabel, streamStartedAt, string, type RoomSnapshot } from '../chinese-live/adapter.js';
import { numericRoomId } from '../chinese-live/url.js';
import { AppError } from '../../types/error.js';

const MEDIA_HOSTS = ['huya.com', 'msstatic.com', 'huyaos.com', 'aisee.tv'];
export interface HuyaLine {
  base: URL;
  name: string;
  suffix: string;
  antiCode: string;
  format: 'flv' | 'hls';
  priority: number;
}

export interface HuyaRoom extends RoomSnapshot {
  uid: string | undefined;
  category: number | undefined;
  rates: Array<{ ratio: number; quality: Quality }>;
  lines: HuyaLine[];
}

function scriptData(html: string, name: string): Record<string, unknown> | undefined {
  const start = new RegExp(`\\b${name}\\s*=\\s*(?=\\{)`).exec(html);
  if (!start) return;
  const input = html.slice(start.index + start[0].length);
  const tokens = /\s+|"(?:[^"\\]|\\[\s\S])*"|'(?:[^'\\]|\\[\s\S])*'|[{}\[\]:,]|-?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|[$\w]+/gy;
  const output: string[] = [];
  let depth = 0;
  for (let matched = tokens.exec(input); matched; matched = tokens.exec(input)) {
    let token = matched[0]!;
    if (!token.trim()) continue;
    if (token === '{' || token === '[') depth++;
    if (token === '}' || token === ']') {
      depth--;
      if (output.at(-1) === ',') output.pop();
    }
    if (token.startsWith("'")) {
      const body = token.slice(1, -1).replace(/\\'|\\x[\da-f]{2}|\\v|\\0|"/gi, match => {
        if (match === "\\'") return "'";
        if (match === '"') return '\\"';
        return match.toLowerCase() === '\\v' ? '\\u000b' : match === '\\0' ? '\\u0000' : `\\u00${match.slice(2)}`;
      });
      token = `"${body}"`;
    } else if (/^[$A-Za-z_]/.test(token)) {
      if (/^\s*:/.test(input.slice(tokens.lastIndex, tokens.lastIndex + 40))) token = JSON.stringify(token);
      else if (token === 'undefined') token = 'null';
      else if (!['true', 'false', 'null'].includes(token)) return;
    }
    output.push(token);
    if (depth === 0) {
      try { return object(JSON.parse(output.join(''))); } catch { return; }
    }
  }
}

function streamData(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return object(value);
  try { return object(JSON.parse(Buffer.from(value, 'base64').toString('utf8'))); } catch { return; }
}

function roomLines(value: unknown): HuyaLine[] {
  return list(value).flatMap(item => {
    const line = object(item);
    if (!line || number(line.iCodecType) === 265) return [];
    const name = string(line.sStreamName);
    if (!name || !/^[\w-]{1,180}$/.test(name)) return [];
    return (['flv', 'hls'] as const).flatMap(format => {
      const prefix = format === 'flv' ? 'sFlv' : 'sHls';
      const base = httpsUrl(line[`${prefix}Url`], MEDIA_HOSTS);
      const suffix = string(line[`${prefix}UrlSuffix`]);
      const antiCode = string(line[`${prefix}AntiCode`]);
      if (!base || suffix !== (format === 'flv' ? 'flv' : 'm3u8') || !antiCode) return [];
      return [{ base, suffix, antiCode, name, format, priority: number(line.iWebPriorityRate) ?? 0 }];
    });
  });
}

export function parseHuyaRoom(html: string): HuyaRoom {
  const player = scriptData(html, 'hyPlayerConfig');
  const stream = streamData(player?.stream);
  const data = object(list(stream?.data)[0]);
  const game = object(data?.gameLiveInfo);
  const room = scriptData(html, 'TT_ROOM_DATA');
  const profile = scriptData(html, 'TT_PROFILE_INFO');
  const id = numericRoomId(game?.profileRoom ?? room?.profileRoom ?? profile?.profileRoom ?? room?.lProfileRoom);
  const status = room?.state ?? room?.isOn ?? player?.isOn;
  const offline = room?.isReplay === true || status === 'OFF' || status === false || number(status) === 0 ||
    /(?:主播还没开播|主播暂未开播|主播已下播|主播不在家|主播离开一下)/.test(html);
  const restricted = number(game?.isSecret ?? room?.isSecret) === 1 || html.includes('该主播涉嫌违规，正在整改中');
  if (!id) {
    if (restricted) throw new AppError('PLATFORM_ACCESS_RESTRICTED', '虎牙直播间访问受限');
    if (html.includes('虎牙君找不到这个主播')) throw new AppError('ROOM_LINK_INVALID', '虎牙直播间不存在');
    throw protocolChanged('虎牙直播间');
  }
  const lines = roomLines(data?.gameStreamInfoList);
  const live = !offline && (status === 'ON' || status === true || number(status) === 1 || lines.length > 0);
  if (!restricted && !live && !offline) throw protocolChanged('虎牙直播间');
  const rates = list(stream?.vMultiStreamInfo).flatMap(value => {
    const rate = object(value);
    const ratio = number(rate?.iBitRate);
    const label = string(rate?.sDisplayName);
    const quality = ratio === 0 ? 'original' : qualityFromLabel(label, rate?.iHeight);
    return ratio !== undefined && ratio >= 0 && quality && [undefined, 0, 264].includes(number(rate?.iCodecType)) ? [{ ratio, quality }] : [];
  });
  if (list(stream?.vMultiStreamInfo).length === 0 && lines.length) rates.push({ ratio: 0, quality: 'original' });
  const started = streamStartedAt(game?.startTime ?? room?.startTime);
  const session = string(game?.liveId) ?? numericRoomId(game?.liveId) ?? (started ? `${id}:${started}` : undefined);
  const displayName = string(game?.nick ?? profile?.nick ?? room?.nick);
  const streamTitle = string(game?.introduction ?? game?.roomName ?? room?.introduction);
  const avatarUrl = [game?.avatar180, profile?.avatar180, profile?.avatar].map(value => httpsUrl(value, MEDIA_HOSTS)).find(Boolean)?.href;
  const liveCoverUrl = [game?.screenshot, room?.screenshot].map(value => httpsUrl(value, MEDIA_HOSTS)).find(Boolean)?.href;
  return {
    id,
    uid: [game?.uid, profile?.uid, profile?.yyid, room?.lYyid, object(list(data?.gameStreamInfoList)[0])?.lPresenterUid]
      .map(numericRoomId).find(Boolean),
    category: number(game?.gid ?? room?.gid),
    rates,
    lines,
    live: {
      status: restricted ? 'restricted' : live ? 'live' : 'offline',
      ...(restricted ? { error: new AppError('PLATFORM_ACCESS_RESTRICTED', '虎牙直播间访问受限，请检查授权').toObject() } : {}),
      ...(live && session ? { streamSessionId: session } : {}),
      ...(live && started ? { platformStartedAt: started } : {}),
      ...(displayName ? { displayName } : {}),
      ...(streamTitle ? { streamTitle } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(liveCoverUrl ? { liveCoverUrl } : {}),
      ...(live ? { availableQualities: [...new Set(rates.map(rate => rate.quality))] } : {}),
    },
  };
}
