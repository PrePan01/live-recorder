import axios, { AxiosError } from 'axios';
import { ApiError } from '../types/error';
import type { ApiErrorEnvelope } from '../types/error';
import { EndpointResolver } from './endpoint';

export const API_BASE: string = EndpointResolver.base;

function httpOrigin(): string {
  if (/^https?:\/\//i.test(EndpointResolver.base)) return new URL(EndpointResolver.base).origin;
  return window.location.origin;
}

export function previewWsUrl(roomId: string): string {
  const origin = httpOrigin();
  const wsBase = origin.startsWith('https') ? `wss://${origin.slice(8)}` : `ws://${origin.slice(7)}`;
  return `${wsBase}/ws/preview/${roomId}`;
}

export function recordingFileUrl(recordingId: string): string {
  return `${EndpointResolver.base}/recordings/${recordingId}/file`;
}

export const http = axios.create({ baseURL: API_BASE, timeout: 10000 });

http.interceptors.request.use((config) => {
  config.baseURL = EndpointResolver.base;
  return config;
});

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

export function baseUrl(): string {
  return EndpointResolver.base;
}