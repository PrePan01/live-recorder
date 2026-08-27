import type { FastifyInstance } from 'fastify';
import { AppError } from '../../types/error.js';
import type { Services } from '../../core/services.js';

export function registerAlertRoutes(app: FastifyInstance, services: Services): void {
  app.get('/api/v1/alerts', async (req, reply) => {
    const q = req.query as { unresolvedOnly?: string; limit?: string };
    const alerts = services.alerts.list({
      unresolvedOnly: q.unresolvedOnly === '1' || q.unresolvedOnly === 'true',
      limit: q.limit ? Math.min(200, Math.max(1, Number(q.limit))) : undefined,
    });
    return reply.send({ alerts });
  });

  app.patch('/api/v1/alerts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const alert = services.alerts.markResolved(id);
    if (!alert) throw new AppError('CONFIG_LOAD_FAILED', '告警不存在');
    return reply.send({ alert });
  });

  app.post('/api/v1/alerts/read-all', async (_req, reply) => {
    services.alerts.markAllResolved();
    return reply.send({ ok: true });
  });
}
