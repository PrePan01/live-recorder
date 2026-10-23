import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnYoutube, terminateYoutube, youtubeError } from '../../src/platform/youtube-runtime.js';
import type { ChildProcess } from 'node:child_process';

const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) terminateYoutube(child, true); });

describe('YouTube process tree shutdown', () => {
  it.skipIf(process.platform === 'win32')('terminates inherited pipes after the extractor has already exited', async () => {
    const child = spawnYoutube(['-e', `
      const { spawn } = require('node:child_process');
      const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] });
      descendant.unref();
      process.exit(0);
    `], process.execPath);
    children.push(child);
    let closed = false;
    const finished = once(child, 'close').then(() => { closed = true; });
    await once(child, 'exit');
    expect(child.exitCode).toBe(0);
    expect(closed).toBe(false);
    terminateYoutube(child, true);
    await finished;
    expect(closed).toBe(true);
    const kill = vi.spyOn(process, 'kill');
    try {
      terminateYoutube(child, true);
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  }, 10_000);
});

describe('YouTube error buckets', () => {
  it('classifies a missing channel or video as non-retryable not-found', () => {
    for (const stderr of [
      'ERROR: [youtube:tab] @no_such_handle: The channel does not exist.',
      'ERROR: [youtube] zzzzzzzzzzz: Video unavailable',
      'ERROR: Unsupported URL: https://www.youtube.com/@nothing',
      // 真实 API 404 词面（不存在的 @handle/视频 ID 复测原文）
      "YouTube said: ERROR - Requested entity was not found.\nUnable to download API page: HTTP Error 404: Not Found",
      'ERROR: [youtube] zzzzzzzzzzz: This video is unavailable',
      // 平台错误横幅兜底未来变体（词面枚举永远滞后）
      'YouTube said: ERROR - some future error variant',
      // gettext 本地化词面（真实 Cookie 场景复测原文）：强制英文为主、中文词面为辅
      'ERROR: [youtube] qafakevid88: 此视频不能观看',
      'ERROR: 无法下载 API 页面：HTTP 错误 404：未找到',
    ]) {
      const error = youtubeError(stderr);
      // 归链接码而非内容码：内容码承载「未开播/已结束」且被状态检测吸收为 offline，
      // 永久链接失败必须走错误通道浮出（fake video ID 触点修复的前提）。
      expect(error.code).toBe('ROOM_LINK_INVALID');
      expect(error.retryable).toBe(false);
      expect(error.message).toContain('未找到');
    }
  });

  it('keeps network failures retryable and content verdicts non-retryable', () => {
    const network = youtubeError('ERROR: unable to download: Connection reset by peer');
    expect(network.code).toBe('NETWORK_UNAVAILABLE');
    expect(network.retryable).toBe(true);
    const privateVideo = youtubeError('ERROR: Video unavailable. This video is private');
    expect(privateVideo.code).toBe('PLATFORM_ACCESS_RESTRICTED');
    expect(privateVideo.retryable).toBe(false);
    const notLive = youtubeError('ERROR: This live event will begin in a few moments');
    expect(notLive.code).toBe('ROOM_CONTENT_UNAVAILABLE');
    expect(notLive.retryable).toBe(false);
  });

  it('gives a channel without live content its own permanent verdict', () => {
    // 真实频道复测原文（有频道、无直播 tab）：永久内容事实不该落网络桶误导重试。
    const error = youtubeError('ERROR: [youtube:tab] @veritasium: This channel does not have a streams tab');
    expect(error.code).toBe('ROOM_LINK_INVALID');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('没有直播');
  });

  it('classifies the extractor authcheck self-check failure as an authorization verdict', () => {
    // 真实 Cookie 场景复测原文（跳过自检前）：提示性 stderr 曾把真 404 拦下、误落网络桶。
    const warning = "ube:tab] @qa_probe_ccc: Playlists that require authentication may not extract correctly without a successful webpage download. If you are not downloading private content, or your cookies are only for the first account and channel, pass \"--extractor-args youtubetab:skip=authcheck\" to skip this check";
    const error = youtubeError(warning);
    expect(error.code).toBe('PLATFORM_ACCESS_RESTRICTED');
    expect(error.retryable).toBe(false);
  });

  it('does not mistake DNS host errors or plain download failures for content-not-found', () => {
    const dns = youtubeError('ERROR: unable to download: Host not found');
    expect(dns.code).toBe('NETWORK_UNAVAILABLE');
    expect(dns.retryable).toBe(true);
    // 本地化裸「无法下载 API 页面」不带 404/未找到 语境时属网络类，不能进不可重试桶。
    const localizedNetwork = youtubeError('ERROR: 无法下载 API 页面：网络超时');
    expect(localizedNetwork.code).toBe('NETWORK_UNAVAILABLE');
    expect(localizedNetwork.retryable).toBe(true);
  });
});
