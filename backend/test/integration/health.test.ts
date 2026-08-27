import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.ts';

describe('GET /api/v1/health', () => {
  it('returns serviceStatus envelope', async () => {
    const app = buildServer({
      version: '0.1.0',
      startedAt: Date.now() - 1500,
      setupCompleted: () => false,
    });
    const res = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.serviceStatus.state).toBe('running');
    expect(body.serviceStatus.version).toBe('0.1.0');
    expect(body.serviceStatus.setupCompleted).toBe(false);
    expect(body.serviceStatus.uptimeSeconds).toBeGreaterThanOrEqual(1);
    await app.close();
  });
});
