import { expect, it } from 'vitest';
import { DownloadSpeed } from '../../src/core/download-speed.js';

it('counts only data received in the last second and returns zero during silence', () => {
  const speed = new DownloadSpeed();
  expect(speed.bytesPerSecond(0)).toBe(0);
  speed.add(1024, 0);
  speed.add(2048, 0);
  speed.add(4096, 500);
  expect(speed.bytesPerSecond(999)).toBe(7168);
  expect(speed.bytesPerSecond(1000)).toBe(4096);
  expect(speed.bytesPerSecond(1500)).toBe(0);
  speed.add(512, 1600);
  expect(speed.bytesPerSecond(1600)).toBe(512);
});

it('discards samples from before a clock rollback', () => {
  const speed = new DownloadSpeed();
  speed.add(1024, 2000);
  expect(speed.bytesPerSecond(1000)).toBe(0);
});
