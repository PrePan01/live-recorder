# 直播录制助手

本地直播录制服务（macOS / Windows）：关注直播间开播自动录制，提供 Web 管理控制台。

## 快速开始

在仓库根目录，一条命令同起后端与前端：

```bash
npm run dev        # 开发模式：后端 fake 适配器 + 前端 mock 数据
npm run dev:real   # 真实模式：后端真实平台适配器（B站/抖音）+ 前端直连真实后端
```

打开 http://localhost:5173 使用。

## 模式说明

- `fake`（默认）：平台适配器返回模拟数据、录制引擎输出最小可播放 FLV，不触网，用于联调与开发。
- `real`：走真实 B站/抖音接口。抖音受限房间需在「设置」页配置 Cookie（存本机 keychain，不落盘）。

单一开关：`npm run dev` / `npm run dev:real` 内部自动映射前后端（后端 `RECORDING_ADAPTER`、前端 `VITE_USE_MOCK`），无需分别控制。

如需单独启动：

```bash
cd backend && RECORDING_ADAPTER=real npm run dev   # 后端（macOS/Linux）
# Windows: set RECORDING_ADAPTER=real && npm run dev
cd frontend && npm run dev                          # 前端（real 模式下自动关 mock）
```

## 结构

- `backend/`：localhost 常驻服务（Fastify + SQLite，REST/SSE/WS），端口 43120
- `frontend/`：React + AntD Web 管理控制台，端口 5173
- `docs/`：API 契约（v1.3）、后端/前端技术方案
- `reports/`：测试计划与验收报告