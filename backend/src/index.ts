import { buildServer, type ServiceInfo } from './api/server.js';
import { SERVICE_HOST, SERVICE_PORT } from './config/defaults.js';

const version = process.env.npm_package_version ?? '0.1.0';

const info: ServiceInfo = {
  version,
  startedAt: Date.now(),
  setupCompleted: () => false,
};

const app = buildServer(info);

async function main(): Promise<void> {
  await app.listen({ host: SERVICE_HOST, port: SERVICE_PORT });
  app.log.info(`live-recorder backend listening on http://${SERVICE_HOST}:${SERVICE_PORT}`);
}

main().catch((err) => {
  console.error('failed to start backend', err);
  process.exit(1);
});
