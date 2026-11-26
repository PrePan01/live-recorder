import WebSocket from 'ws';
import { sameSiteHeaders } from '../chinese-live/adapter.js';
import { readTars, tarsBytes, tarsInt, tarsString } from './tars.js';

export function huyaCookieStatus(cookie: string): Promise<'valid' | 'invalid' | 'unknown'> {
  const uid = /(?:^|;\s*)yyuid=([1-9]\d{0,18})(?:;|$)/.exec(cookie)?.[1];
  if (!uid) return Promise.resolve('invalid');
  return new Promise(resolve => {
    const socket = new WebSocket('wss://wsapi.huya.com/', {
      headers: sameSiteHeaders('huya', ''),
      handshakeTimeout: 7_000,
      maxPayload: 128 * 1024,
    });
    let completed = false;
    const finish = (status: 'valid' | 'invalid' | 'unknown') => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(status);
    };
    const timer = setTimeout(() => finish('unknown'), 8_000);
    socket.once('open', () => {
      const payload = Buffer.concat([
        tarsInt(0, BigInt(uid)), tarsString(1, 'webh5&0.1.0&websocket'), tarsString(2, cookie),
        tarsString(3, ''), tarsInt(4, 0), tarsString(5, 'web'),
      ]);
      socket.send(Buffer.concat([tarsInt(0, 10), tarsBytes(1, payload)]));
    });
    socket.on('message', data => {
      try {
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        const command = readTars(bytes);
        if (command.get(0) !== 11) return;
        const payload = command.get(1);
        if (!Buffer.isBuffer(payload) || !payload.length) return finish('unknown');
        const result = readTars(payload).get(0);
        finish(result === 0 ? 'valid' : typeof result === 'number' ? 'invalid' : 'unknown');
      } catch {
        finish('unknown');
      }
    });
    socket.on('error', () => finish('unknown'));
    socket.once('close', () => finish('unknown'));
  });
}
