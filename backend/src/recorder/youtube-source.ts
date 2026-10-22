import type { YoutubeMediaSource } from '../platform/adapter.js';

/** Reuse yt-dlp's selected public HLS inputs without launching a second extractor.
 * Other quality selections and authenticated downloads keep the yt-dlp path. */
export interface YoutubeHlsTrack { url: string; headers: Record<string, string> }
interface YoutubeFormat {
  url?: string; height?: number; vcodec?: string; acodec?: string;
  protocol?: string; http_headers?: Record<string, unknown>; has_drm?: boolean;
}
export function youtubeSelectedHls(source: YoutubeMediaSource): YoutubeHlsTrack[] | null {
  const snapshot = source.snapshot;
  if (source.cookie || !snapshot || snapshot.expiresAt <= Date.now() ||
      Buffer.byteLength(snapshot.json) > 8 * 1024 * 1024) return null;
  const capped = /^bv\[height<=(360|540|720|1080)\]\+ba\/b\[height<=\1\]\/bv\+ba\/b$/.exec(source.formatSelector);
  if (!capped && source.formatSelector !== 'bv+ba/b') return null;
  try {
    const info = JSON.parse(snapshot.json) as {
      id?: string;
      requested_formats?: YoutubeFormat[];
      formats?: YoutubeFormat[];
    };
    const formats = info.requested_formats;
    if (info.id !== source.videoId || formats?.length !== 2) return null;
    let video = formats.find(f => f.vcodec && f.vcodec !== 'none' && f.acodec === 'none');
    const audio = formats.find(f => f.vcodec === 'none');
    if (video && capped && (video.height ?? Infinity) > Number(capped[1])) {
      // yt-dlp has already sorted these formats. Its bv[height<=N] selector
      // takes the last matching video-only entry; keep its ranking and audio.
      video = info.formats?.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec === 'none' &&
        Number.isFinite(f.height) && f.height! > 0 && f.height! <= Number(capped[1])).at(-1);
    }
    if (!video || !audio || !Number.isFinite(video.height) || video.height! <= 0 || video.has_drm || audio.has_drm) return null;
    const tracks: YoutubeHlsTrack[] = [];
    for (const format of [video, audio]) {
      if (format.protocol !== 'm3u8_native' || !format.url) return null;
      const url = new URL(format.url);
      if (url.protocol !== 'https:' || url.username || url.password ||
          !url.hostname.endsWith('.googlevideo.com')) return null;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(format.http_headers ?? {})) {
        if (!/^[A-Za-z0-9-]+$/.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value) ||
            /^(?:cookie|authorization|proxy-authorization)$/i.test(name)) return null;
        headers[name] = value;
      }
      tracks.push({ url: format.url, headers });
    }
    return tracks;
  } catch { return null; }
}

export function youtubeDirectInputs(source: YoutubeMediaSource, authArgs: string[]): string[] | null {
  const tracks = youtubeSelectedHls(source);
  if (!tracks) return null;
  const args: string[] = [];
  const proxyIndex = authArgs.indexOf('--proxy');
  for (const track of tracks) {
    args.push('-rw_timeout', '15000000');
    if (proxyIndex >= 0 && authArgs[proxyIndex + 1]) args.push('-http_proxy', authArgs[proxyIndex + 1]!);
    const headers = Object.entries(track.headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
    if (headers) args.push('-headers', headers);
    args.push('-i', track.url);
  }
  return args;
}
