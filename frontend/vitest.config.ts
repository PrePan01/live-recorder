import { defineConfig } from 'vitest/config';

// 前端单测：纯函数（uploadError/uploadProgress/format 等）用 node 环境快速验证。
// 不加载 react plugin，保持轻量；DOM 组件测试如需后续再扩展。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});