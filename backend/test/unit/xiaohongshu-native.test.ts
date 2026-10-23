import { afterEach, describe, expect, it, vi } from 'vitest';
import { isXhsNativeUrl, XiaohongshuNativeBroker } from '../../src/platform/xiaohongshu-native.js';

const url = 'https://live-room.xiaohongshu.com/api/sns/red/live/h5/v1/interaction/get_simple_interaction?roomId=123';
afterEach(() => vi.useRealTimers());
describe('Xiaohongshu native request broker', () => {
  it('only admits read APIs on their actual platform hosts', () => {
    expect(isXhsNativeUrl(url)).toBe(true);
    expect(isXhsNativeUrl('https://edith.xiaohongshu.com/api/sns/web/v1/user/otherinfo?target_user_id=abc')).toBe(true);
    expect(isXhsNativeUrl('https://edith.xiaohongshu.com/api/sns/web/v1/user/hover_card?target_user_id=abc')).toBe(true);
    for (const raw of [
      'http://127.0.0.1/api/sns/web/v1/user/selfinfo',
      'https://edith.xiaohongshu.com.evil.test/api/sns/web/v1/user/selfinfo',
      'https://edith.xiaohongshu.com/api/sns/web/v1/comment/post',
      'https://secret@edith.xiaohongshu.com/api/sns/web/v1/user/selfinfo',
    ]) expect(isXhsNativeUrl(raw)).toBe(false);
  });
  it('fails immediately without an active desktop consumer', async () => {
    await expect(new XiaohongshuNativeBroker().request(url)).rejects.toMatchObject({ code: 'PLATFORM_ACCESS_RESTRICTED' });
  });
  it('delivers each request once and only resolves its matching response', async () => {
    const broker = new XiaohongshuNativeBroker();
    expect(broker.take()).toEqual([]);
    const pending = broker.request(url);
    const [request] = broker.take();
    expect(request!.url).toBe(url);
    expect(broker.take()).toEqual([]);
    broker.complete('other-request', { status: 200, text: '{}' });
    broker.complete(request!.id, { status: 200, text: '{"success":true}' });
    expect(await pending).toEqual({ status: 200, text: '{"success":true}' });
    broker.close();
  });
  it('releases pending work on abort, timeout and service shutdown', async () => {
    vi.useFakeTimers();
    const broker = new XiaohongshuNativeBroker(); broker.take();
    const abort = new AbortController();
    const cancelled = expect(broker.request(url, abort.signal)).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
    abort.abort(); await cancelled;
    const timedOut = expect(broker.request(url)).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(45000); await timedOut;
    broker.take();
    const closed = expect(broker.request(url)).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
    broker.close(); await closed;
    await expect(broker.request(url)).rejects.toMatchObject({ code: 'PLATFORM_ACCESS_RESTRICTED' });
  });
  it('carries only a session fingerprint when binding a request to native authorization', async () => {
    const broker = new XiaohongshuNativeBroker(); broker.take();
    const hash = 'a'.repeat(64);
    const pending = broker.request(url, undefined, hash);
    const [job] = broker.take();
    expect(job).toMatchObject({ sessionHash: hash });
    expect(job).not.toHaveProperty('cookie');
    broker.complete(job!.id, { status: 200, text: '{}' });
    await pending; broker.close();
  });
  it('publishes deadlines and removes cancelled jobs from the native active set', async () => {
    const broker = new XiaohongshuNativeBroker(); broker.take();
    const controller = new AbortController();
    const pending = expect(broker.request(url, controller.signal)).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
    const [job] = broker.take();
    expect(job!.expiresAt).toBeGreaterThan(Date.now());
    expect(broker.activeRequestIds()).toContain(job!.id);
    controller.abort(); await pending;
    expect(broker.activeRequestIds()).toEqual([]);
    expect(broker.take()).toEqual([]);
    broker.close();
  });
});
