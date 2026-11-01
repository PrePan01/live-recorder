import { describe, expect, it } from 'vitest';
import { StreamRecordingEngine } from '../../src/recorder/stream-recorder.js';
import type { RecordingEvent, StreamInput } from '../../src/recorder/engine.js';

async function drain(engine: StreamRecordingEngine, format: StreamInput['format']) {
  const events: RecordingEvent[] = [];
  for await (const event of engine.start({ url: 'https://example.test/live', format }, null)) events.push(event);
  return events;
}

describe('bounded stream startup', () => {
  it.each(['flv', 'hls'] as const)('%s aborts a request that never returns headers', async format => {
    let aborted = false;
    const fetcher = (async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => {
        aborted = true;
        reject(options!.signal!.reason);
      }, { once: true });
    })) as typeof fetch;
    const events = await drain(new StreamRecordingEngine(fetcher, 40), format);
    expect(aborted).toBe(true);
    expect(events).toEqual([expect.objectContaining({ type: 'error', error: expect.objectContaining({
      code: 'NETWORK_UNAVAILABLE', retryable: true,
      details: expect.objectContaining({ trigger: 'request_timeout' }),
    }) })]);
  });

  it('aborts when headers arrive but the very first body byte never does', async () => {
    let cancelled = false;
    const fetcher = (async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }))) as typeof fetch;
    const events = await drain(new StreamRecordingEngine(fetcher, 40), 'flv');
    expect(cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: {
      code: 'NETWORK_UNAVAILABLE', retryable: true,
      details: { trigger: 'upstream_idle' },
    } });
    expect(events.some(event => event.type === 'completed')).toBe(false);
  });

  it.each(['flv', 'hls'] as const)('%s releases the response body on an HTTP error', async format => {
    let cancelled = false;
    const fetcher = (async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { status: 503 })) as typeof fetch;
    const events = await drain(new StreamRecordingEngine(fetcher), format);
    expect(cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { retryable: true } });
  });

  it('stopping during connection startup cancels promptly without reporting a failure', async () => {
    const fetcher = (async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), { once: true });
    })) as typeof fetch;
    const engine = new StreamRecordingEngine(fetcher, 40);
    const pending = drain(engine, 'flv');
    await engine.stop();
    expect(await pending).toEqual([]);
  });
});
