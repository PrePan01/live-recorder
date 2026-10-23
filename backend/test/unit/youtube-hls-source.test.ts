import { describe, expect, it, vi } from 'vitest';
import { YoutubeHlsSource } from '../../src/recorder/youtube-hls-source.js';

const tracks = ['video', 'audio'].map(name => ({ url: `https://manifest.googlevideo.com/${name}/index.m3u8`, headers: { 'User-Agent': `${name}-agent` } }));
const playlist = (sequence = 42) => `#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:5,\na.ts\n#EXTINF:5,\nb.ts\n#EXTINF:5,\nc.ts\n`;
const segments = (body: string) => body.split('\n').filter(line => line && !line.startsWith('#'));

describe('YouTube parallel HLS source', () => {
  it('delivers the first prefetched packet while the rest of its segment is still pending', async () => {
    let finish!: ReadableStreamDefaultController<Uint8Array>;
    let firstReads = 0;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) return new Response(playlist());
      if (!url.endsWith('/video/a.ts')) return new Response('other media');
      firstReads++;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        finish = controller;
        controller.enqueue(new TextEncoder().encode('first packet'));
        init!.signal!.addEventListener('abort', () => controller.error(new Error('stopped')), { once: true });
      } }));
    }) as typeof fetch;
    const source = await YoutubeHlsSource.open(tracks, new AbortController().signal, () => {}, fetcher);
    try {
      const text = await (await fetch(source.inputs[0]!)).text();
      const response = await fetch(segments(text)[0]!);
      const reader = response.body!.getReader();
      let first: Uint8Array | undefined;
      void reader.read().then(result => { first = result.value; });
      await vi.waitFor(() => expect(new TextDecoder().decode(first)).toBe('first packet'));
      // Only now can a whole-segment buffer complete. The decoder has already
      // received the first packet without a second download or a new HLS batch.
      finish.enqueue(new TextEncoder().encode('last packet')); finish.close();
      const chunks: Uint8Array[] = [];
      for (;;) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); }
      expect(Buffer.concat(chunks).toString()).toBe('last packet');
      expect(firstReads).toBe(1);
    } finally { await source.close(); }
  });
  it.each(['before-response', 'after-response'])('retries a failed speculative prefetch (%s) when the decoder requests the segment', async stage => {
    const calls = new Map<string, number>();
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) return new Response(playlist());
      const attempt = (calls.get(url) ?? 0) + 1;
      calls.set(url, attempt);
      if (attempt === 1) {
        if (stage === 'before-response') throw new Error('temporary prefetch failure');
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error('temporary body failure')); } }));
      }
      return new Response('recovered media');
    }) as typeof fetch;
    const source = await YoutubeHlsSource.open(tracks, new AbortController().signal, () => {}, fetcher);
    try {
      const text = await (await fetch(source.inputs[0]!)).text();
      const response = await fetch(segments(text)[0]!);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('recovered media');
      expect(calls.get('https://manifest.googlevideo.com/video/a.ts')).toBe(2);
    } finally { await source.close(); }
  });
  it('cancels a claimed progressive fetch when the decoder disconnects mid-segment', async () => {
    let mediaSignal: AbortSignal | undefined;
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('.m3u8')) return new Response(playlist());
      if (!url.endsWith('/video/a.ts')) return new Response('other media');
      mediaSignal = init!.signal!;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        mediaSignal!.addEventListener('abort', () => controller.error(new Error('cancelled')), { once: true });
      } }));
    }) as typeof fetch;
    const source = await YoutubeHlsSource.open(tracks, new AbortController().signal, () => {}, fetcher);
    try {
      const text = await (await fetch(source.inputs[0]!)).text();
      const response = await fetch(segments(text)[0]!);
      const reader = response.body!.getReader();
      expect((await reader.read()).value?.byteLength).toBe(3);
      await reader.cancel();
      await vi.waitFor(() => expect(mediaSignal?.aborted).toBe(true));
    } finally { await source.close(); }
  });
  it('fetches both manifests and starting segments in parallel, preserves input order and reuses their bytes', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const manifests = new Promise<void>(resolve => { release = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); calls.push(url);
      const name = url.includes('/video/') ? 'video' : 'audio';
      expect(new Headers(init?.headers).get('user-agent')).toBe(`${name}-agent`);
      if (url.endsWith('.m3u8')) { await manifests; return new Response(playlist()); }
      return new Response(`${name}:${url.split('/').at(-1)}`);
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    const opening = YoutubeHlsSource.open(tracks, controller.signal, () => {}, fetcher);
    await vi.waitFor(() => expect(calls.filter(url => url.endsWith('.m3u8'))).toHaveLength(2));
    release();
    const source = await opening;
    try {
      expect(calls.filter(url => url.endsWith('/a.ts'))).toHaveLength(2);
      const video = await (await fetch(source.inputs[0]!)).text();
      const audio = await (await fetch(source.inputs[1]!)).text();
      expect(video).toContain('#EXT-X-MEDIA-SEQUENCE:42');
      expect(video).not.toContain('googlevideo.com');
      expect(await (await fetch(segments(video)[0]!)).text()).toBe('video:a.ts');
      expect(await (await fetch(segments(audio)[0]!)).text()).toBe('audio:a.ts');
      expect(calls.filter(url => url.endsWith('/a.ts'))).toHaveLength(2);
      expect((await fetch(source.inputs[0]!.replace(/\/[^/]+\/index.m3u8$/, '/arbitrary-url'))).status).toBe(404);
      expect((await fetch(source.inputs[0]!, { method: 'POST' })).status).toBe(404);
    } finally { await source.close(); }
  });

  it('refreshes playlists and forwards byte ranges without using a whole-segment prefetch', async () => {
    let sequence = 42;
    const ranges: (string | null)[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('.m3u8')) return new Response(playlist(sequence));
      const range = new Headers(init?.headers).get('range'); ranges.push(range);
      return new Response(range ? 'partial' : 'whole', { status: range ? 206 : 200,
        headers: range ? { 'Content-Range': 'bytes 2-8/20' } : {} });
    }) as typeof fetch;
    const source = await YoutubeHlsSource.open(tracks, new AbortController().signal, () => {}, fetcher);
    try {
      await fetch(source.inputs[0]!);
      sequence = 43;
      const updated = await (await fetch(source.inputs[0]!)).text();
      expect(updated).toContain('#EXT-X-MEDIA-SEQUENCE:43');
      const response = await fetch(segments(updated)[0]!, { headers: { Range: 'bytes=2-8' } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 2-8/20');
      expect(await response.text()).toBe('partial');
      expect(ranges).toContain('bytes=2-8');
    } finally { await source.close(); }
  });

  it('releases the input server and cancels pending upstream reads on stop', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('.m3u8')) return new Response(playlist());
      signals.push(init!.signal!);
      return new Response(new ReadableStream({ start(c) {
        init!.signal!.addEventListener('abort', () => c.error(new Error('stopped')), { once: true });
      } }));
    }) as typeof fetch;
    const controller = new AbortController();
    const source = await YoutubeHlsSource.open(tracks, controller.signal, () => {}, fetcher);
    const url = source.inputs[0]!;
    controller.abort();
    await source.close();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    await expect(fetch(url)).rejects.toThrow();
  });

  it('streams large prefetched segments through the bounded queue without downloading them twice', async () => {
    let mediaCalls = 0;
    const large = new Uint8Array(2 * 1024 * 1024 + 1);
    const fetcher = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('.m3u8')) return new Response(playlist());
      mediaCalls++; return new Response(large);
    }) as typeof fetch;
    const source = await YoutubeHlsSource.open(tracks, new AbortController().signal, () => {}, fetcher);
    try {
      const text = await (await fetch(source.inputs[0]!)).text();
      expect((await (await fetch(segments(text)[0]!)).arrayBuffer()).byteLength).toBe(large.byteLength);
      expect(mediaCalls).toBe(4);
    } finally { await source.close(); }
  });

  it('rejects foreign media resources before issuing upstream requests to them', async () => {
    const fetcher = vi.fn(async () => new Response('#EXTM3U\n#EXTINF:5,\nhttp://127.0.0.1/private\n'));
    await expect(YoutubeHlsSource.open(tracks, new AbortController().signal, () => {}, fetcher as typeof fetch)).rejects.toThrow('Unsupported');
    expect(fetcher.mock.calls.length).toBe(2);
  });
});
