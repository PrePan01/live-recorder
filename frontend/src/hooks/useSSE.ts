import { useEffect } from 'react';
import { API_BASE } from '../api/client';
import { SSE_EVENT_NAMES } from '../types/events';
import type { ServerEvent } from '../types/events';
import { applyServerEvent } from '../stores/applyEvent';
import { useServiceStore } from '../stores/serviceStore';

const RECONNECT_DELAYS_MS = [5_000, 15_000, 45_000];

/** 契约 v1.3：SSE 标准帧（event: 名称 + data: JSON），data 不内嵌 type。 */
export function useSSE() {
  useEffect(() => {
    let disposed = false;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const setConnected = (v: boolean) => useServiceStore.getState().setSseConnected(v);

    const handle = (type: ServerEvent['type'], raw: string) => {
      try {
        const payload = JSON.parse(raw) as Record<string, unknown>;
        applyServerEvent({ type, ...payload } as unknown as ServerEvent);
      } catch {
        /* 忽略坏帧 */
      }
    };

    const connect = () => {
      if (disposed) return;
      es?.close();
      es = new EventSource(`${API_BASE}/events`);
      es.onopen = () => {
        attempt = 0;
        setConnected(true);
      };
      for (const name of SSE_EVENT_NAMES) {
        es.addEventListener(name, (msg) => handle(name, (msg as MessageEvent<string>).data));
      }
      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        if (disposed) return;
        if (attempt < RECONNECT_DELAYS_MS.length) {
          timer = setTimeout(connect, RECONNECT_DELAYS_MS[attempt]);
          attempt += 1;
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      es?.close();
      setConnected(false);
    };
  }, []);
}
