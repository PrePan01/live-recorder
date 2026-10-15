import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string };

if (process.env.RECORDING_ADAPTER === "real") {
  process.env.VITE_USE_MOCK = "0";
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        "floating-recorder": fileURLToPath(
          new URL(
            "./src/window-entries/floating-recorder/floating-recorder.html",
            import.meta.url,
          ),
        ),
        "douyin-auth": fileURLToPath(
          new URL(
            "./src/window-entries/platform-auth/douyin-auth.html",
            import.meta.url,
          ),
        ),
        "bilibili-auth": fileURLToPath(
          new URL(
            "./src/window-entries/platform-auth/bilibili-auth.html",
            import.meta.url,
          ),
        ),
        "xiaohongshu-auth": fileURLToPath(
          new URL(
            "./src/window-entries/platform-auth/xiaohongshu-auth.html",
            import.meta.url,
          ),
        ),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.LIVE_RECORDER_PORT ?? "43120"}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://127.0.0.1:${process.env.LIVE_RECORDER_PORT ?? "43120"}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.LIVE_RECORDER_PORT ?? "43120"}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://127.0.0.1:${process.env.LIVE_RECORDER_PORT ?? "43120"}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
