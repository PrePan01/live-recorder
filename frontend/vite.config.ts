import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 单一开关：RECORDING_ADAPTER=real 时前端强制直连真实后端（关闭 mock），
// 未设或非 real 时走 .env.development 的 mock 默认。前后端只需控制这一个变量。
if (process.env.RECORDING_ADAPTER === 'real') {
  process.env.VITE_USE_MOCK = '0'
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:43120', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:43120', ws: true, changeOrigin: true },
    },
  },
})
