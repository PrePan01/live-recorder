import { useEffect } from 'react';
import { API_BASE } from '../api/client';
import { SSE_EVENT_NAMES } from '../types/events';
import type { ServerEvent } from '../types/events';
import type { Room } from '../types/room';
import type { Recording } from '../types/recording';
import type { Alert } from '../types/alert';
import type { Settings } from '../types/settings';
import type { DiskSpace, ServiceStatus } from '../types/service';
import { applyServerEvent } from '../stores/applyEvent';
import { useServiceStore } from '../stores/serviceStore';

const RECONNECT_DELAYS_MS = [5_000, 15_000, 45_000];

/**
 * SSE 契约的 data 是资源本身，而不是 `{ type, resource }` 包装对象。
 * 在此处按事件名补回 store 所需的字段，避免房间新增/删除事件将 undefined
 * 写入 Zustand 后导致页面渲染异常。
 */
function toServerEvent(type: ServerEvent['type'], payload: Record<string, unknown>): ServerEvent {
  switch (type) {
    case 'room:updated':
      return { type, room: payload as unknown as Room };
    case 'recording:updated':
      return { type, recording: payload as unknown as Recording };
    case 'alert:created':
    case 'alert:updated':
      return { type, alert: payload as unknown as Alert };
    case 'settings:updated':
      return { type, settings: payload as unknown as Settings };
    case 'service:status':
      return { type, serviceStatus: payload as unknown as ServiceStatus };
    case 'disk:space':
      return { type, disk: payload as unknown as DiskSpace };
  }
}

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
        applyServerEvent(toServerEvent(type, payload));
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
