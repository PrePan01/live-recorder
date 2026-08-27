# Live Recorder Backend

本地常驻录制服务：监控 B站/抖音直播间开播，自动录制到用户目录，邮件通知，Web 管理界面走 localhost API。

## 快速开始

```bash
cd backend
npm install
npm run dev        # tsx watch，监听 http://127.0.0.1:43120
npm run build      # tsc 编译到 dist/
npm test           # vitest（unit + integration）
```

## 当前状态（阶段 B 开发中）

| 任务 | 状态 |
| --- | --- |
| B-E1 项目骨架 | 已完成（Fastify 5 + TS 严格模式 + health 端点 + 配置/错误类型） |
| B-E2~B-E7 数据层/fake/全端点/SSE/WS/调度/测试 | 进行中 |

- 契约：`docs/api-contract.md`（v1.1）
- 技术方案：`docs/backend-technical-plan.md`（评审定稿版）
- 环境变量：`RECORDING_ADAPTER=fake|real`（阶段 B 默认 fake）

## 目录结构

`src/` 按 `docs/backend-technical-plan.md` §2 组织：config / db / api / core / platform / recorder / storage / mail / security / types / utils。
