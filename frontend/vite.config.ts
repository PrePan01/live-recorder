import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 单一开关：RECORDING_ADAPTER=real 时前端强制直连真实后端（关闭 mock），
// 未设或非 real 时走 .env.development 的 mock 默认。前后端只需控制这一个变量。
if (process.env.RECORDING_ADAPTER === 'real') {
  process.env.VITE_USE_MOCK = '0'
}

export default defineConfig({
  // Tauri WebView 用 tauri://localhost 加载，绝对路径 /assets 无法解析，
  // 需用相对路径（#138 QA 定位白屏根因）。
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // dev 后端端口可通过 LIVE_RECORDER_PORT 覆盖（开发隔离默认 43140，正式默认 43120）。
      '/api': { target: `http://127.0.0.1:${process.env.LIVE_RECORDER_PORT ?? '43120'}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${process.env.LIVE_RECORDER_PORT ?? '43120'}`, ws: true, changeOrigin: true },
    },
  },
})
