import axios, { AxiosError } from 'axios';
import { ApiError } from '../types/error';
import type { ApiErrorEnvelope } from '../types/error';

export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:43120/api/v1';

function httpOrigin(): string {
  if (/^https?:\/\//i.test(API_BASE)) return new URL(API_BASE).origin;
  return window.location.origin;
}

export function previewWsUrl(roomId: string): string {
  const origin = httpOrigin();
  const wsBase = origin.startsWith('https') ? `wss://${origin.slice(8)}` : `ws://${origin.slice(7)}`;
  return `${wsBase}/ws/preview/${roomId}`;
}

export const http = axios.create({ baseURL: API_BASE, timeout: 10000 });

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<unknown>) => {
    const raw = error.response?.data as Record<string, unknown> | undefined;
    const body = (raw?.error ?? raw) as (ApiErrorEnvelope & { roomId?: string }) | undefined;
    if (body && typeof body === 'object' && typeof body.code === 'string') {
      throw new ApiError({ ...body, message: body.message ?? error.message }, error.response?.status);
    }
    if (error.response) {
      throw new ApiError(
        {
          code: 'SERVICE_UNAVAILABLE',
          message: `服务返回 ${error.response.status}`,
          occurredAt: new Date().toISOString(),
          retryable: error.response.status >= 500,
        },
        error.response.status,
      );
    }
    throw new ApiError({
      code: 'NETWORK_UNAVAILABLE',
      message: '无法连接到本地服务',
      occurredAt: new Date().toISOString(),
      retryable: true,
    });
  },
);
