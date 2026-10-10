import { expect, it } from 'vitest';
import { buildApp } from '../../src/api/server.js';
import { buildServices } from '../../src/core/services.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';

it('rejects invalid pipeline through whole settings, config import and dedicated pipeline API without saving it', async () => {
  const services = buildServices({ dbPath: ':memory:' });
  services.settings.save({ ...structuredClone(DEFAULT_SETTINGS), recordingDirectory: '/tmp' });
  const { app } = buildApp(services);
  const before = services.settings.load();
  try {
    for (const maxConcurrency of [0, 1.5, 3, '2']) {
      for (const request of [
        { method: 'PUT' as const, url: '/api/v1/settings', payload: { pipeline: { maxConcurrency } } },
        { method: 'PUT' as const, url: '/api/v1/settings/pipeline', payload: { maxConcurrency } },
        { method: 'POST' as const, url: '/api/v1/config/import', payload: { config: { settings: { pipeline: { maxConcurrency } } } } },
      ]) {
        const response = await app.inject({ ...request, headers: { host: '127.0.0.1:43120' } });
        expect(response.statusCode).toBe(422);
        expect(response.json().error.code).toBe('PIPELINE_CONFIG_INVALID');
        expect(services.settings.load()).toEqual(before);
      }
    }
  } finally { await app.close(); }
});
