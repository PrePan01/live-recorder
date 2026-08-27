import { buildApp } from './api/server.js';
import { buildServices } from './core/services.js';
import { SERVICE_HOST, SERVICE_PORT } from './config/defaults.js';

const extraOrigins = (process.env.LR_EXTRA_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean);

const services = buildServices();
const { app } = buildApp(services, { extraOrigins });

async function main(): Promise<void> {
  await app.listen({ host: SERVICE_HOST, port: SERVICE_PORT });
  console.log(`live-recorder backend (${services.mode}) listening on http://${SERVICE_HOST}:${SERVICE_PORT}`);
}

main().catch((err) => {
  console.error('failed to start backend', err);
  process.exit(1);
});
