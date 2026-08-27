import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, httpStatusFor } from '../types/error.js';

export interface ServiceInfo {
  version: string;
  startedAt: number;
  setupCompleted: () => boolean;
}

export function buildServer(info: ServiceInfo): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/api/v1/health', async (_req, reply) => {
    return reply.send({
      serviceStatus: {
        state: 'running',
        version: info.version,
        uptimeSeconds: Math.round((Date.now() - info.startedAt) / 1000),
        setupCompleted: info.setupCompleted(),
      },
    });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(httpStatusFor(err.code)).send({ error: err.toObject() });
    }
    return reply.status(500).send({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: '服务内部错误',
        roomId: null,
        recordingId: null,
        occurredAt: new Date().toISOString(),
        retryable: true,
      },
    });
  });

  return app;
}
