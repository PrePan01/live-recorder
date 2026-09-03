# 直播录制助手（Live Recorder）

直播录制工具（macOS / Windows）。支持 B站 / 抖音直播间，开播自动录制、录像存本地，并提供 Web 管理控制台与桌面客户端。当前版本 **v0.5.x**。

## 简介

直播录制助手是一款常驻本机的直播录制服务：添加关注直播间后，检测到开播即自动开始录制，录制文件直接落盘本地；同时提供 Web 管理控制台（浏览器访问）与原生桌面客户端（macOS / Windows），支持直播实时预览、录制历史回放、后处理管线、自动上传、通知提醒等完整功能。

- 本地运行、数据不出本机（凭据存系统钥匙串/keychain，不落盘、不回显）
- 双端形态：Web 控制台（`http://localhost:5173`）+ 桌面客户端（Tauri，双击启动）
- 录制主链路零阻塞：拉流直写、背压隔离、断流续录、时间戳归一化

## 功能

### 录制与监控
- B站 / 抖音直播间检测与自动录制，手动录制 / 停止
- 监控总览：卡片 / 列表视图、收藏置顶、当前录制时长走时、直播预览、开播预测、实时状态（SSE）
- 多路直播墙（2×2 / 3×3，最多 4 路并发带降级、默认静音）
- 磁盘空间守卫、断流续录、录制完整性校验、并发上限与去重

### 房间管理
- 直播间管理：搜索 / 筛选 / 分页、批量添加、标签分组、单独自动录制开关、定时录制计划
- 全局搜索（房间 / 录制 / 告警）
- 房间健康度与录制统计

### 录制历史与回放
- 历史列表：筛选 / 分页 / 回放（FLV / MP4）、重命名 / 删除（连带文件）、CSV 导出 / 批量删除
- 上传状态列、失败原因与重试

### 后处理与分发
- 后处理管线：校验 → 封面帧 → 切片合并 → 压缩转封装 → 归档，失败保留源文件、定向重试
- 录制命名规则（`{room}` `{platform}` `{date}` `{time}` `{quality}` `{roomId}`）
- OpenList（WebDAV）自动上传：进度 / 重试 / 取消，令牌不落盘
- 邮件通知（SMTP 预设，失败提醒去重）

### 桌面客户端
- macOS / Windows 桌面端（Tauri）：双击启动、托盘、单实例、端口防冲突、升级自动切换新后端
- 桌面通知、深色 / 浅色 / 跟随系统主题

## 安装

### 使用发布包

- macOS：下载 `Live Recorder_x.y.z_aarch64.dmg` 安装，或直接运行 `Live Recorder.app`（首次启动自动拉起本地服务）
- Windows：下载 `.msi` / `.exe` 安装包（需在 Windows 环境构建，见「开发 · 打包」）

### 从源码运行

环境要求：Node.js ≥ 20。

```bash
npm install
npm run dev        # 开发模式：后端 fake 适配器 + 前端 mock 数据
npm run dev:real   # 真实模式：后端真实适配器（B站/抖音）+ 前端直连真实后端
```

打开 `http://localhost:5173` 使用。

- `fake`（默认）：平台适配器返回模拟数据、录制引擎输出最小可播放 FLV，不触网，用于联调与开发
- `real`：走真实 B站 / 抖音接口。抖音受限房间需在「设置」页配置 Cookie（存本机 keychain）

> 抖音录制 / 预览 / 显示名识别建议配置 Cookie；MP4 转封装需本机可执行 `ffmpeg`。

## 开发

### 目录结构

- `backend/`：本地常驻服务（Fastify + SQLite，端口 43120；REST / SSE / WS 预览）
- `frontend/`：Web 管理控制台与桌面客户端（React + Vite + Ant Design，端口 5173；Tauri 壳在 `frontend/src-tauri`）
- `docs/`：API 契约（`api-contract.md`）、产品/前后端技术方案
- `reports/`：测试计划与验收报告
- `release/`：打包产物（.app / .dmg / .msi / .exe）

### 常用命令

```bash
# 前端（frontend/）
npm run dev        # 开发服务器
npm run build      # 构建（tsc + vite build）
npm run lint       # 代码检查

# 后端（backend/）
npm run dev        # 开发（tsx watch）
npm run build      # 构建
npm run test       # 单元 / 集成测试（vitest）
npm run typecheck  # 类型检查

# 打包（frontend/，macOS 产出 .app/.dmg 并同步 release/）
npm run tauri:build
```

### 打包

- macOS：`cd frontend && npm run tauri:build`，产物在 `release/`（.app + .dmg）
- Windows：需在 Windows 环境执行 `cd frontend && npm run tauri:build`，产物 `.msi` / `.exe`（或使用 CI 的 `windows-latest` runner）

### 分支与协作约定

- `main` 为稳定主干与 QA 冒烟基线；功能 / 缺陷一律开 `feat/<主题>` / `fix/<主题>` 分支
- 完成 → lint / typecheck + 全量测试 → QA 分支回归 → `--no-ff` 合入 `main` → main 复测
- 数据库迁移合入 `main` 后不可改写，新变更只追加新版本迁移
- 提交使用约定式前缀、原子提交

## 贡献

欢迎提交 Issue 与 Pull Request：

1. Fork 本仓库，从 `main` 拉取特性分支（`feat/<主题>`）
2. 保持代码风格与现有约定一致，补齐对应测试
3. 提交信息使用约定式前缀（`feat:` / `fix:` / `docs:` / `test:` 等）
4. 合入前请确保：lint / typecheck / 全量测试通过，并由 QA 完成回归

技术细节与接口约定见 `docs/api-contract.md`。