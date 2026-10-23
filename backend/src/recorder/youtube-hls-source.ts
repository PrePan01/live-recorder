import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { youtubeFetch } from '../platform/youtube-network.js';
import type { YoutubeHlsTrack } from './youtube-source.js';

const PLAYLIST_LIMIT = 2 * 1024 * 1024;
const PREFETCH_HIGH_WATER_MARK = 1024 * 1024;
const ROUTE_LIMIT = 4096;
const ROUTE_BYTES_LIMIT = 8 * 1024 * 1024;
type Resource = YoutubeHlsTrack & { kind: 'playlist' | 'segment' | 'init' | 'key'; bytes: number };
type Prefetch = {
  ready: Promise<Response>; body: Promise<void>; stream: PassThrough;
  abort: AbortController; timer: ReturnType<typeof setTimeout>;
};

/** Network input belongs to the source session, rather than FFmpeg's sequential
 * avformat_open_input calls. Both tracks start fetching before either is probed.
 * FFmpeg still demuxes, synchronizes and copies the original packets. */
export class YoutubeHlsSource {
  private readonly abort = new AbortController();
  private readonly routes = new Map<string, Resource>();
  private readonly prefetched = new Map<string, Prefetch>();
  private readonly initial = new Map<string, Buffer>();
  private readonly prefix = `/${randomBytes(24).toString('hex')}/`;
  private routeBytes = 0;
  private base = '';
  private requests = 0;
  private closed = false;
  private readonly server = createServer((req, res) => { void this.serve(req, res); });
  private readonly onAbort = () => { void this.close(); };
  readonly inputs: string[] = [];

  private constructor(
    private readonly tracks: YoutubeHlsTrack[],
    private readonly signal: AbortSignal,
    private readonly stage: (name: string) => void,
    private readonly fetcher: typeof fetch,
  ) {}

  static async open(tracks: YoutubeHlsTrack[], signal: AbortSignal,
    stage: (name: string) => void = () => {}, fetcher: typeof fetch = youtubeFetch): Promise<YoutubeHlsSource> {
    const source = new YoutubeHlsSource(tracks, signal, stage, fetcher);
    try { await source.start(); return source; }
    catch (error) { await source.close(); throw error; }
  }

  private async start(): Promise<void> {
    this.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    this.signal.throwIfAborted();
    this.signal.addEventListener('abort', this.onAbort, { once: true });
    this.abort.signal.throwIfAborted();
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('YouTube input server unavailable');
    this.base = `http://127.0.0.1:${address.port}`;
    this.server.maxConnections = 8;
    const first: Promise<unknown>[] = [];
    await Promise.all(this.tracks.map(async track => {
      const local = this.register(track.url, track.headers, 'playlist');
      const resource = this.routes.get(new URL(local).pathname)!;
      const response = await this.request(resource);
      const body = await this.read(response, PLAYLIST_LIMIT);
      if (!body) throw new Error('YouTube playlist exceeds limit');
      const text = body.toString('utf8');
      const rewritten = this.rewrite(text, resource);
      this.initial.set(new URL(local).pathname, Buffer.from(rewritten));
      // Keep the same default HLS starting point (-3). Do not skip live content.
      if (!/#EXT-X-(?:STREAM-INF|BYTERANGE)/.test(text)) {
        const segments = text.split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
        for (const [index, segment] of segments.slice(-3, -1).entries()) {
          const url = new URL(segment.trim(), resource.url).href;
          const pending = this.preload(url, resource.headers);
          if (index === 0) first.push(pending);
        }
      }
      this.inputs.push(local);
    }));
    // Promise completion order must not reorder video and audio input mappings.
    this.inputs.splice(0, this.inputs.length,
      ...this.tracks.map(track => this.register(track.url, track.headers, 'playlist')));
    this.stage('youtube_manifests_ready');
    if (first.length === this.tracks.length)
      void Promise.all(first).then(() => { if (!this.closed) this.stage('youtube_initial_segments_ready'); }, () => {});
  }

  private register(raw: string, headers: Record<string, string>, kind: Resource['kind']): string {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !url.hostname.endsWith('.googlevideo.com') || raw.length > 16_384)
      throw new Error('Unsupported YouTube media resource');
    const suffix = { playlist: 'index.m3u8', segment: 'segment.ts', init: 'init.mp4', key: 'key.key' }[kind];
    const key = `${this.prefix}${createHash('sha256').update(`${kind}:${url.href}`).digest('hex')}/${suffix}`;
    if (!this.routes.has(key)) {
      const bytes = Buffer.byteLength(url.href);
      while (this.routes.size >= ROUTE_LIMIT || this.routeBytes + bytes > ROUTE_BYTES_LIMIT) {
        let oldest: string | undefined;
        for (const [key, resource] of this.routes) {
          if (resource.kind !== 'playlist') { oldest = key; break; }
        }
        if (oldest === undefined) throw new Error('YouTube playlist route limit exceeded');
        this.routeBytes -= this.routes.get(oldest)!.bytes;
        this.routes.delete(oldest);
      }
      this.routes.set(key, { url: url.href, headers, kind, bytes });
      this.routeBytes += bytes;
    }
    return this.base + key;
  }

  private rewrite(text: string, resource: Resource): string {
    if (!text.startsWith('#EXTM3U')) throw new Error('Invalid YouTube playlist');
    let variant = false;
    const fragmented = /#EXT-X-MAP:/.test(text);
    return text.split(/\r?\n/).map(line => {
      if (line.startsWith('#')) {
        variant = line.startsWith('#EXT-X-STREAM-INF:');
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
          const kind = /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):/.test(line) ? 'playlist'
            : line.startsWith('#EXT-X-KEY:') ? 'key' : 'init';
          return `URI="${this.register(new URL(uri, resource.url).href, resource.headers, kind)}"`;
        });
      }
      if (!line.trim()) return line;
      const kind = variant ? 'playlist' : fragmented ? 'init' : 'segment';
      variant = false;
      return this.register(new URL(line.trim(), resource.url).href, resource.headers, kind);
    }).join('\n');
  }

  private async request(resource: YoutubeHlsTrack, signal = this.abort.signal, range?: string): Promise<Response> {
    const response = await this.fetcher(resource.url, {
      headers: { ...resource.headers, ...(range ? { Range: range } : {}) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`YouTube media HTTP ${response.status}`); }
    return response;
  }

  private async read(response: Response, limit: number): Promise<Buffer | null> {
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return Buffer.concat(chunks, bytes);
        bytes += next.value.byteLength;
        if (bytes > limit) { await reader.cancel(); return null; }
        chunks.push(Buffer.from(next.value));
      }
    } finally { reader.releaseLock(); }
  }

  private preload(url: string, headers: Record<string, string>): Promise<void> {
    const existing = this.prefetched.get(url);
    if (existing) return existing.body;
    // Two segments per track. Backpressure bounds the staging queues; a decoder
    // can consume the first bytes before the complete segment has downloaded.
    if (this.prefetched.size >= 4) return Promise.resolve();
    const abort = new AbortController();
    const stream = new PassThrough({ highWaterMark: PREFETCH_HIGH_WATER_MARK });
    stream.on('error', () => {});
    stream.once('close', () => abort.abort());
    let producer: Promise<void> = Promise.resolve();
    const ready = this.request({ url, headers }, AbortSignal.any([this.abort.signal, abort.signal])).then(response => {
      if (response.body) {
        producer = pipeline(Readable.fromWeb(response.body as never), stream);
        void producer.catch(() => {});
      } else stream.end();
      return response;
    });
    const body = ready.then(() => producer).catch(error => {
      stream.destroy(error instanceof Error ? error : new Error('YouTube segment prefetch failed'));
      throw error;
    });
    void body.catch(() => {});
    const timer = setTimeout(() => {
      this.prefetched.delete(url);
      abort.abort(); stream.destroy();
    }, 10_000);
    timer.unref();
    this.prefetched.set(url, { ready, body, stream, abort, timer });
    return body;
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = req.url ?? '';
    const resource = this.routes.get(key);
    if (this.closed || req.method !== 'GET' || !resource || this.requests >= 8) {
      res.writeHead(404).end(); return;
    }
    this.requests++;
    // Keep playlist routes and currently read segments alive when old DVR routes roll out.
    this.routes.delete(key); this.routes.set(key, resource);
    const connection = new AbortController();
    const stop = () => connection.abort();
    res.once('close', stop);
    try {
      const initial = this.initial.get(key);
      if (initial) {
        this.initial.delete(key);
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(initial);
        return;
      }
      const cached = this.prefetched.get(resource.url);
      if (cached && (!req.headers.range || req.headers.range === 'bytes=0-')) {
        this.prefetched.delete(resource.url); clearTimeout(cached.timer);
        // A speculative read failing must not poison the decoder's later read.
        // The on-demand request below has its own timeout and cancellation.
        const cancelCached = () => { cached.abort.abort(); cached.stream.destroy(); };
        connection.signal.addEventListener('abort', cancelCached, { once: true });
        if (connection.signal.aborted) cancelCached();
        try {
          const response = await cached.ready.catch(() => null);
          if (response && !cached.stream.destroyed) {
            const headers: Record<string, string> = {};
            for (const name of ['content-type', 'content-range']) {
              const value = response.headers.get(name); if (value) headers[name] = value;
            }
            res.writeHead(response.status, headers);
            await pipeline(cached.stream, res);
            return;
          }
          cached.abort.abort(); cached.stream.destroy();
        } finally { connection.signal.removeEventListener('abort', cancelCached); }
      }
      const response = await this.request(resource,
        AbortSignal.any([this.abort.signal, connection.signal]), req.headers.range);
      if (resource.kind === 'playlist') {
        const body = await this.read(response, PLAYLIST_LIMIT);
        if (!body) throw new Error('YouTube playlist exceeds limit');
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        res.end(this.rewrite(body.toString('utf8'), resource));
      } else {
        const headers: Record<string, string> = {};
        for (const name of ['content-type', 'content-range']) {
          const value = response.headers.get(name); if (value) headers[name] = value;
        }
        res.writeHead(response.status, headers);
        if (response.body) await pipeline(Readable.fromWeb(response.body as never), res);
        else res.end();
      }
    } catch {
      if (res.headersSent) res.destroy(); else res.writeHead(502).end();
    } finally { res.off('close', stop); this.requests--; }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener('abort', this.onAbort);
    this.abort.abort();
    for (const value of this.prefetched.values()) {
      clearTimeout(value.timer); value.abort.abort(); value.stream.destroy();
    }
    this.prefetched.clear(); this.initial.clear(); this.routes.clear(); this.routeBytes = 0;
    this.server.closeAllConnections();
    if (this.server.listening)
      await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
