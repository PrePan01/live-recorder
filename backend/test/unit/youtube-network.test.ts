import { afterEach, expect, it, vi } from 'vitest';
const request = vi.hoisted(() => vi.fn<typeof fetch>(async () => new Response('{}')));
vi.mock('undici', () => ({ fetch: request, ProxyAgent: class { close() { return Promise.resolve(); } } }));
import { youtubeFetch } from '../../src/platform/youtube-network.js';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it('bridges a foreign SDK Request into URL, headers and body bytes for proxy fetch', async () => {
  vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:12345');
  const body = new TextEncoder().encode('{"continuation":"next"}');
  const foreign = {
    url: 'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat',
    method: 'POST', headers: new Headers({ 'content-type': 'application/json' }),
    signal: new AbortController().signal, redirect: 'follow',
    arrayBuffer: async () => body.buffer,
    toString: () => '[object Request]',
  } as unknown as Request;
  await youtubeFetch(foreign);
  expect(request).toHaveBeenCalledWith(foreign.url, expect.objectContaining({
    method: 'POST', body: body.buffer, dispatcher: expect.anything(),
  }));
  expect(new Headers(request.mock.calls[0]?.[1]?.headers).get('content-type')).toBe('application/json');
});
