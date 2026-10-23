import { describe, it, expect, vi } from "vitest";
import { readFile, stat } from "node:fs/promises";
import {
  YoutubeAdapter,
  youtubeQuality,
  youtubeFormat,
} from "../../src/platform/youtube.js";
import {
  parseYoutubeUrl,
  normalizeYoutubeUrl,
} from "../../src/platform/youtube-url.js";
import {
  normalizeYoutubeCookies,
  youtubeError,
  youtubeArguments,
} from "../../src/platform/youtube-runtime.js";
import { youtubeCookieHeader } from "../../src/danmaku/adapters/youtube.js";
import { AppError } from "../../src/types/error.js";
import { parseSystemProxy } from "../../src/platform/youtube-network.js";

const video = "abcdefghijk";
const channel = "UCabcdefghijklmnopqrstuv";
const live = {
  id: video,
  live_status: "is_live",
  title: "Live",
  channel: "Creator",
  formats: [{ height: 2160 }, { height: 720 }, { height: 360 }],
};
describe("YouTube URL and platform contract", () => {
  it.each([
    `https://youtu.be/${video}?si=tracking`,
    `https://m.youtube.com/watch?v=${video}&t=2`,
    `https://www.youtube.com/live/${video}`,
  ])("canonicalizes one broadcast: %s", (url) => {
    expect(normalizeYoutubeUrl(url)).toBe(
      `https://www.youtube.com/watch?v=${video}`,
    );
  });
  it.each([
    "https://youtube.com.evil.test/watch?v=abcdefghijk",
    "file:///tmp/live",
    "https://evil.test/@creator",
    "https://youtube.com/playlist?list=abc",
    "https://youtube.com/shorts/abcdefghijk",
    "https://user:password@youtube.com/watch?v=abcdefghijk",
  ])("rejects unsupported or untrusted target: %s", (url) =>
    expect(parseYoutubeUrl(url)).toBeNull(),
  );
  it("normalizes channel URLs and keeps a video distinct from its channel", () => {
    expect(
      normalizeYoutubeUrl(`https://youtube.com/channel/${channel}/live`),
    ).toBe(`https://www.youtube.com/channel/${channel}`);
    expect(normalizeYoutubeUrl("https://youtube.com/@creator/streams")).toBe(
      "https://www.youtube.com/@creator",
    );
    expect(parseYoutubeUrl(`https://youtube.com/watch?v=${video}`)?.kind).toBe(
      "video",
    );
  });
  it("resolves and persists a stable channel ID", async () => {
    const extract = vi
      .fn()
      .mockResolvedValue({ channel_id: channel, entries: [] });
    const save = vi.fn();
    const adapter = new YoutubeAdapter(extract, {
      load: () => undefined,
      save,
    });
    expect(
      await adapter.resolveRoomUrl("https://youtube.com/@creator/live"),
    ).toBe(`https://www.youtube.com/channel/${channel}`);
    expect(save).toHaveBeenCalledWith(
      "https://www.youtube.com/@creator",
      `https://www.youtube.com/channel/${channel}`,
    );
  });
  it("maps current broadcast metadata and keeps originals available", async () => {
    const adapter = new YoutubeAdapter(vi.fn().mockResolvedValue(live));
    expect(
      await adapter.checkLiveStatus(`https://youtu.be/${video}`),
    ).toMatchObject({
      status: "live",
      streamSessionId: video,
      availableQualities: ["original", "1080p", "720p", "540p", "360p"],
    });
    expect(
      await adapter.getStreamUrl(`https://youtu.be/${video}`, "original"),
    ).toMatchObject({
      format: "youtube",
      actualQuality: "original",
      youtube: { videoId: video, formatSelector: "bv+ba/b" },
    });
  });
  it("keeps the channel avatar when video thumbnails contain only covers", async () => {
    const avatarUrl = 'https://yt3.googleusercontent.com/channel-avatar';
    const adapter = new YoutubeAdapter(vi.fn()
      .mockResolvedValueOnce({ channel: 'Creator', thumbnails: [{ url: avatarUrl }], entries: [live] })
      .mockResolvedValueOnce({ ...live, thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' }));
    expect(await adapter.checkLiveStatus(`https://youtube.com/channel/${channel}`)).toMatchObject({
      status: 'live', avatarUrl,
      liveCoverUrl: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',
    });
  });
  it("loads and reuses a channel avatar for a video target", async () => {
    const avatarUrl = 'https://yt3.ggpht.com/channel-avatar';
    const extract = vi.fn().mockImplementation(async (url: string) => url.endsWith('/streams')
      ? { id: channel, thumbnails: [{ url: avatarUrl }] }
      : { ...live, channel_id: channel });
    const adapter = new YoutubeAdapter(extract);
    for (let i = 0; i < 2; i++) expect(await adapter.checkLiveStatus(`https://youtu.be/${video}`)).toMatchObject({ avatarUrl });
    expect(extract.mock.calls.filter(([url]) => url.endsWith('/streams'))).toHaveLength(1);
  });
  it("still loads channel artwork for an offline video during normal status checks", async () => {
    const avatarUrl = 'https://yt3.ggpht.com/offline-channel';
    const extract = vi.fn().mockImplementation(async (url: string) => url.endsWith('/streams')
      ? { id: channel, thumbnails: [{ url: avatarUrl }] }
      : { ...live, channel_id: channel, live_status: 'was_live' });
    expect(await new YoutubeAdapter(extract).checkLiveStatus(`https://youtu.be/${video}`))
      .toMatchObject({ status: 'offline', avatarUrl });
  });
  it("does not wait for channel artwork in the media startup path and reuses extracted formats", async () => {
    const info = { ...live, channel_id: channel, epoch: Date.now() / 1000,
      formats: [{ height: 720, url: 'https://media.example/live.m3u8' }] };
    const extract = vi.fn().mockImplementation(async (url: string) => {
      if (url.endsWith('/streams')) throw new Error('Artwork must not block media');
      return info;
    });
    const stream = await new YoutubeAdapter(extract).getStreamUrl(`https://youtu.be/${video}`, '720p');
    expect(extract).toHaveBeenCalledOnce();
    expect(JSON.parse(stream.youtube!.snapshot!.json)).toEqual(info);
    expect(stream.youtube!.snapshot!.expiresAt).toBeGreaterThan(Date.now());
    expect(await new YoutubeAdapter(extract).checkLiveStatusForStartup(`https://youtu.be/${video}`)).toMatchObject({ status: 'live', streamSessionId: video });
    expect(extract.mock.calls.some(([url]) => url.endsWith('/streams'))).toBe(false);
  });
  it.each(["is_upcoming", "was_live", "post_live", "not_live"])(
    "does not record %s as a live stream",
    async (status) => {
      const adapter = new YoutubeAdapter(
        vi.fn().mockResolvedValue({ id: video, live_status: status }),
      );
      expect(
        await adapter.checkLiveStatus(`https://youtu.be/${video}`),
      ).toEqual({ status: "offline" });
    },
  );
  it("selects the earliest concurrent stream and retains it across checks", async () => {
    const extract = vi
      .fn()
      .mockResolvedValueOnce({
        entries: [
          { id: "newnewnewne1", live_status: "is_live", release_timestamp: 20 },
          { id: video, live_status: "is_live", release_timestamp: 10 },
        ],
      })
      .mockResolvedValueOnce(live)
      .mockResolvedValueOnce({
        entries: [
          { id: "newnewnewne1", live_status: "is_live", release_timestamp: 5 },
          { id: video, live_status: "is_live", release_timestamp: 10 },
        ],
      })
      .mockResolvedValueOnce(live);
    const adapter = new YoutubeAdapter(extract);
    await adapter.checkLiveStatus(`https://youtube.com/channel/${channel}`);
    await adapter.checkLiveStatus(`https://youtube.com/channel/${channel}`);
    expect(extract.mock.calls[3]?.[0]).toBe(
      `https://www.youtube.com/watch?v=${video}`,
    );
  });
  it("pins reconnect to the recorded video instead of resolving the channel again", async () => {
    const extract = vi
      .fn()
      .mockResolvedValue({ id: video, live_status: "was_live" });
    const adapter = new YoutubeAdapter(extract);
    expect(
      await adapter.resolveRecordingSource(
        `https://youtube.com/channel/${channel}`,
        "original",
        undefined,
        { streamSessionId: video },
      ),
    ).toEqual({ status: "offline" });
    expect(extract).toHaveBeenCalledWith(
      `https://www.youtube.com/watch?v=${video}`,
      undefined,
    );
  });
  it("reports restricted access separately from network faults", async () => {
    const adapter = new YoutubeAdapter(
      vi
        .fn()
        .mockRejectedValue(
          new AppError("PLATFORM_ACCESS_RESTRICTED", "restricted"),
        ),
    );
    expect(
      await adapter.checkLiveStatus(`https://youtu.be/${video}`),
    ).toMatchObject({ status: "restricted", error: { retryable: false } });
    expect(youtubeError("Sign in to confirm you are not a bot").code).toBe(
      "PLATFORM_ACCESS_RESTRICTED",
    );
  });
  it("reports actual fallback quality without restricting original codecs", () => {
    expect(youtubeQuality(live, "1080p")).toBe("720p");
    expect(youtubeQuality(live, "original")).toBe("original");
    expect(youtubeFormat("720p")).toContain("bv[height<=720]+ba");
    expect(youtubeQuality({ ...live, formats: [{ height: 1080 }] }, "720p")).toBe("1080p");
    expect(youtubeQuality({ ...live, formats: [{ height: 2160 }] }, "1080p")).toBe("original");
  });
  it("ends recovery when the recorded broadcast is no longer available instead of retrying forever", async () => {
    const adapter = new YoutubeAdapter(vi.fn().mockRejectedValue(
      new AppError('ROOM_CONTENT_UNAVAILABLE', 'YouTube 直播已结束')));
    expect(await adapter.resolveRecordingSource(`https://youtu.be/${video}`, 'original', undefined,
      { streamSessionId: video })).toEqual({ status: 'offline' });
  });
});

describe("YouTube credential boundaries", () => {
  const cookie =
    "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret\n.evil.test\tTRUE\t/\tTRUE\t0\tsession\tother\n";
  it("passes fresh extracted media through a private temporary file and cleans it with credentials", async () => {
    const json = JSON.stringify({ id: video, formats: [{ url: 'https://media.example/signed' }] });
    const auth = await youtubeArguments(cookie, { json, expiresAt: Date.now() + 15_000 });
    const file = auth.args[auth.args.indexOf('--load-info-json') + 1]!;
    const cookieFile = auth.args[auth.args.indexOf('--cookies') + 1]!;
    try {
      expect(await readFile(file, 'utf8')).toBe(json);
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await readFile(cookieFile, 'utf8')).toContain('SID\tsecret');
    } finally { await auth.dispose(); }
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(cookieFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it("falls back to extraction when the media snapshot has expired or exceeds its bound", async () => {
    for (const snapshot of [{ json: '{}', expiresAt: Date.now() - 1 },
      { json: 'x'.repeat(8 * 1024 * 1024 + 1), expiresAt: Date.now() + 15_000 }]) {
      const auth = await youtubeArguments(undefined, snapshot);
      try { expect(auth.args).not.toContain('--load-info-json'); }
      finally { await auth.dispose(); }
    }
  });
  it("retains YouTube cookies and removes unrelated domains", () => {
    expect(normalizeYoutubeCookies(cookie)).toContain("SID\tsecret");
    expect(normalizeYoutubeCookies(cookie)).not.toContain("evil.test");
    expect(youtubeCookieHeader(cookie)).toBe("SID=secret");
  });
  it.each([
    "SID=secret",
    "# Netscape HTTP Cookie File\n",
    "# Netscape HTTP Cookie File\ninvalid\n",
  ])("rejects malformed or empty input", (raw) =>
    expect(() => normalizeYoutubeCookies(raw)).toThrow(),
  );
});

describe("YouTube system network routing", () => {
  it("reads an enabled macOS proxy and ignores disabled entries", () => {
    expect(
      parseSystemProxy(
        "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 7890",
        "darwin",
      ),
    ).toBe("http://127.0.0.1:7890");
    expect(
      parseSystemProxy(
        "HTTPEnable : 0\nHTTPProxy : localhost\nHTTPPort : 1234",
        "darwin",
      ),
    ).toBeUndefined();
  });
  it("uses the Windows HTTPS route for both parser and media", () => {
    expect(
      parseSystemProxy(
        JSON.stringify({
          ProxyEnable: 1,
          ProxyServer: "http=localhost:8080;https=localhost:8081",
        }),
        "win32",
      ),
    ).toBe("http://localhost:8081");
    expect(
      parseSystemProxy(
        JSON.stringify({ ProxyEnable: 0, ProxyServer: "localhost:8080" }),
        "win32",
      ),
    ).toBeUndefined();
  });
});

describe("check failure surfacing", () => {
  it("surfaces a missing channel as a room error instead of silent offline", async () => {
    const extract = vi.fn().mockRejectedValue(new AppError(
      "ROOM_LINK_INVALID",
      "未找到该频道或直播，请检查链接是否正确（重试不会恢复）",
      { retryable: false },
    ));
    const status = await new YoutubeAdapter(extract).checkLiveStatus("https://www.youtube.com/watch?v=zzzzzzzzzzz");
    expect(status.status).toBe("error");
    const error = (status as { error?: { code?: string; retryable?: boolean } }).error;
    expect(error?.code).toBe("ROOM_LINK_INVALID");
    expect(error?.retryable).toBe(false);
  });
});
