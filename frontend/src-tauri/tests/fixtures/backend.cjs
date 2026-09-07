const fs = require('node:fs');
const http = require('node:http');
if (process.argv.includes('--crash')) {
  console.error('fixture: native dependency unavailable');
  process.exit(17);
}
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ serviceStatus: { ...instance, ready: true, version: 'test' } }));
});
let instance;
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  instance = { instanceId: `fixture-${process.pid}`, pid: process.pid, port, host: '127.0.0.1', baseUrl: `http://127.0.0.1:${port}`, apiVersion: 'v1', startedAt: new Date().toISOString() };
  fs.writeFileSync(process.env.LIVE_RECORDER_READY_FILE, JSON.stringify(instance));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
