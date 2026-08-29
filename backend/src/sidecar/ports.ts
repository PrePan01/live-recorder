import { createServer } from 'node:net';

export const DEFAULT_PORT = 43120;
export const BACKUP_PORTS = [43121, 43122, 43123, 43124, 43125];

function probePort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

/**
 * 端口选择：优先 preferred（默认 43120）→ 受控备用列表 → OS 分配空闲端口。
 * 仅监听环回地址；端口占用只触发换端口，不影响占用者。
 */
export async function pickPort(host: string, preferred: number = DEFAULT_PORT): Promise<number> {
  const candidates = [preferred, ...BACKUP_PORTS];
  for (const port of candidates) {
    if (await probePort(host, port)) return port;
  }
  return osFreePort(host);
}

/** 让 OS 分配一个空闲端口（端口 0）。 */
export function osFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, host, () => {
      const address = srv.address();
      srv.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('failed to allocate OS free port'));
      });
    });
  });
}