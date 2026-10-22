import { describe, expect, it } from 'vitest';
import type { YoutubeMediaSource } from '../../src/platform/adapter.js';
import { youtubeDirectInputs } from '../../src/recorder/youtube-source.js';

const formats = () => [
  { url: 'https://manifest.googlevideo.com/video.m3u8', height: 1080, vcodec: 'avc1.640028', acodec: 'none', protocol: 'm3u8_native', http_headers: { 'User-Agent': 'test' } },
  { url: 'https://manifest.googlevideo.com/audio.m3u8', vcodec: 'none', acodec: 'mp4a.40.2', protocol: 'm3u8_native', http_headers: { 'User-Agent': 'test' } },
];
function source(patch: Partial<YoutubeMediaSource> = {}): YoutubeMediaSource {
  return { videoId: 'rFZHOHl-L8A', formatSelector: 'bv[height<=1080]+ba/b[height<=1080]/bv+ba/b',
    snapshot: { expiresAt: Date.now() + 15_000, json: JSON.stringify({ id: 'rFZHOHl-L8A', requested_formats: formats() }) }, ...patch };
}

describe('YouTube selected HLS input reuse', () => {
  it('preserves selected video/audio order, request headers and the same proxy on each input', () => {
    const args = youtubeDirectInputs(source(), ['--proxy', 'http://127.0.0.1:7999']);
    expect(args).toEqual([
      '-rw_timeout', '15000000', '-http_proxy', 'http://127.0.0.1:7999', '-headers', 'User-Agent: test\r\n', '-i', 'https://manifest.googlevideo.com/video.m3u8',
      '-rw_timeout', '15000000', '-http_proxy', 'http://127.0.0.1:7999', '-headers', 'User-Agent: test\r\n', '-i', 'https://manifest.googlevideo.com/audio.m3u8',
    ]);
  });
  it('also reuses the selected original quality', () => {
    expect(youtubeDirectInputs(source({ formatSelector: 'bv+ba/b' }), [])).not.toBeNull();
  });
  it('uses the existing yt-dlp ranking for a lower requested resolution without changing the selected audio', () => {
    const selected = formats();
    const lower = [
      { ...selected[0], height: 360, url: 'https://manifest.googlevideo.com/360.m3u8' },
      { ...selected[0], height: 720, url: 'https://manifest.googlevideo.com/720-low.m3u8' },
      { ...selected[0], height: 720, url: 'https://manifest.googlevideo.com/720-best.m3u8' },
      selected[0],
    ];
    const args = youtubeDirectInputs(source({ formatSelector: 'bv[height<=720]+ba/b[height<=720]/bv+ba/b',
      snapshot: { expiresAt: Date.now() + 15000, json: JSON.stringify({ id: 'rFZHOHl-L8A', formats: lower, requested_formats: selected }) } }), []);
    expect(args).toContain('https://manifest.googlevideo.com/720-best.m3u8');
    expect(args).toContain('https://manifest.googlevideo.com/audio.m3u8');
    expect(args).not.toContain('https://manifest.googlevideo.com/video.m3u8');
  });
  it.each([
    { cookie: 'saved credential' },
    { snapshot: undefined },
    { snapshot: { json: '{}', expiresAt: Date.now() - 1 } },
    { snapshot: { json: 'x'.repeat(8 * 1024 * 1024 + 1), expiresAt: Date.now() + 15_000 } },
    { formatSelector: 'bv[height<=720]+ba/b[height<=720]/bv+ba/b' },
    { formatSelector: 'unexpected-format-selector' },
  ])('keeps the normal downloader when credentials, freshness or quality require it: case %#', patch => {
    expect(youtubeDirectInputs(source(patch), [])).toBeNull();
  });
  it.each(['different-video', 'missing-audio', 'foreign-host', 'http-url', 'dash', 'header-injection', 'credential-header', 'invalid-json'])('falls back safely for %s', variant => {
    const selected = formats();
    let id = 'rFZHOHl-L8A';
    if (variant === 'different-video') id = 'other-video';
    if (variant === 'missing-audio') selected.pop();
    if (variant === 'foreign-host') selected[0]!.url = 'https://example.com/video.m3u8';
    if (variant === 'http-url') selected[0]!.url = 'http://manifest.googlevideo.com/video.m3u8';
    if (variant === 'dash') selected[0]!.protocol = 'http_dash_segments';
    if (variant === 'header-injection') selected[0]!.http_headers = { 'User-Agent': 'test\r\nCookie: secret' };
    if (variant === 'credential-header') Object.assign(selected[0]!.http_headers, { Cookie: 'secret' });
    const value = source({ snapshot: { expiresAt: Date.now() + 15_000,
      json: variant === 'invalid-json' ? '{' : JSON.stringify({ id, requested_formats: selected }) } });
    expect(youtubeDirectInputs(value, [])).toBeNull();
  });
});
