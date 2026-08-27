import type { FastifyInstance } from 'fastify';
import type { Services } from '../../core/services.js';

export function registerServiceRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/service/status', async (_req, reply) => {
    const stored = services.settings.load();
    const disk = stored && stored.recordingDirectory
      ? await services.diskGuard.inspect(stored.recordingDirectory)
      : { freeBytes: 0, totalBytes: 0 };
    return reply.send({
      serviceStatus: {
        state: 'running',
        version: '0.1.0',
        uptimeSeconds: Math.round((services.clock.now() - services.startedAt) / 1000),
        setupCompleted: Boolean(stored && stored.recordingDirectory.length > 0),
        disk,
        activeRecordings: services.recordings.activeCount(),
      },
    });
  });
}
