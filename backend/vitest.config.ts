import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    testTimeout: 15000,
    // 统计看板 Q6=A（本地时区切日）新基线：固定运行时区，
    // 让 SQLite datetime('localtime') 与 JS Date 本地日断言不随跑测机时区漂移。
    env: { TZ: 'Asia/Shanghai' },
  },
});
