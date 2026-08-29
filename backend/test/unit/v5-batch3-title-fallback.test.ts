import { describe, expect, it } from 'vitest';
import { DouyinAdapter } from '../../src/platform/douyin.js';
import type { LiveStatusResult } from '../../src/platform/adapter.js';

function respond(body: unknown, init?: { status?: number }) {
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('V5 Batch3 #128: douyin title fallback', () => {
  it('marks adapter source when nickname/title present', async () => {
    const adapter = new DouyinAdapter(() => Promise.resolve(respond({ status_code: 0, data: { data: [{ id: '1', status: 2, title: '标题', user: { nickname: '主播' }, stream_url: { flv_pull_url: { HD1: 'u' } } }] } })));
    const res = await adapter.checkLiveStatus('https://live.douyin.com/1', 'cookie');
    expect(res.titleSource).toBe('adapter');
    expect(res.titleFallbackUsed).toBe(false);
    expect(res.displayName).toBe('主播');
  });

  it('falls back to safe placeholder when main source lacks title', async () => {
    const adapter = new DouyinAdapter(() => Promise.resolve(respond({ status_code: 0, data: { data: [{ id: '1', status: 2, stream_url: { flv_pull_url: { HD1: 'u' } } }] } })));
    const res = await adapter.checkLiveStatus('https://live.douyin.com/42', 'cookie');
    expect(res.titleSource).toBe('placeholder');
    expect(res.titleFallbackUsed).toBe(true);
    expect(res.displayName).toBe('douyin_42');
    // 录制不阻断：仍判定 live。
    expect(res.status).toBe('live');
  });

  it('classifies cookie failure vs interface change', async () => {
    const noCookie = new DouyinAdapter(() => Promise.resolve(respond({ status_code: 10011, data: {} })));
    const restricted = await noCookie.checkLiveStatus('https://live.douyin.com/1', undefined);
    expect(restricted.status).toBe('restricted');
    expect(restricted.error?.code).toBe('PLATFORM_ACCESS_RESTRICTED');

    const changed = new DouyinAdapter(() => Promise.resolve(respond({ data: { data: [] } })));
    const res = await changed.checkLiveStatus('https://live.douyin.com/1', 'cookie');
    // 空 data 且 status_code 缺省 → 视凭证或结构异常。
    expect(['restricted', 'error']).toContain(res.status);
  });
});