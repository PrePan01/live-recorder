<h1 align="center">
  <div>直播录制助手（Live Recorder）</div>
  <br>
  <img src="frontend/public/icon1.png" alt="Live Recorder" width="128" />
</h1>
<h4 align="center">直播录制工具（macOS / Windows）。支持 B站 / 抖音直播间。</h4>


## 简介

直播录制助手是一款常驻本机的直播录制服务

支持开播自动录制、手动开始录制、直播实时预览、录制历史回放、后处理管线、自动上传、通知提醒等等完整功能

## 功能

### 录制与监控
- B站 / 抖音直播间检测与自动录制，手动录制 / 停止，支持保存为 FLV、MP4 到本地或直传网盘（依赖[OpenList](https://github.com/OpenListTeam/OpenList)）
- 监控总览：卡片 / 列表视图、收藏置顶、当前录制时长、直播预览、开播预测、实时状态
- 多路直播墙（2×2 / 3×3，最多 4 路）
- 磁盘空间守卫、断流续录、录制完整性校验、并发上限与去重

### 房间管理
- 直播间管理：搜索 / 筛选 / 分页、批量添加、标签分组、单独自动录制开关、定时录制计划
- 全局搜索
- 录制统计

### 录制历史与回放
- 历史列表：筛选 / 分页 / 回放（FLV / MP4）、重命名 / 删除、CSV 导出 / 批量删除
- 上传状态、失败原因与重试

### 后处理与分发
- 后处理管线：校验 → 封面帧 → 切片合并 → 压缩转封装 → 归档，失败保留源文件、定向重试
- 录制命名规则自定义
- [OpenList](https://github.com/OpenListTeam/OpenList)（WebDAV）自动上传：进度 / 重试 / 取消
- 邮件通知（SMTP 预设，失败提醒去重）

### 桌面客户端
- macOS / Windows 桌面端（Tauri）

## 安装

### 使用发布包

- macOS：下载 `Live Recorder_x.y.z_aarch64.dmg` 安装
- Windows：下载 `.msi` 安装包安装

### 从源码运行

环境要求：Node.js ≥ 22（安装包内置运行时，无需用户另行安装）。

```bash
npm run setup
npm run dev
```

## 开发

### 三步开始开发

1. 安装依赖：`npm run setup`
2. 启动项目：`npm run dev`（Web端）或 `npm run dev:tarui`（客户端）
3. 开始开发

### 目录结构

- `backend/`：本地常驻服务（Fastify + SQLite，端口 43120；REST / SSE / WS 预览）
- `frontend/`：Web 管理控制台与桌面客户端（React + Vite + Ant Design，端口 5173；Tauri 壳在 `frontend/src-tauri`）
- `reports/`：测试计划与验收报告
- `release/`：打包产物

### 常用命令

```bash
# 前端（frontend/）
npm run dev        # 开发服务器
npm run build      # 构建（tsc + vite build）
npm run lint       # 代码检查
npm run icons:generate # 更新桌面图标：macOS 应用白底，其余透明底

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

### 发布
 `release` 分支更新将触发发布流程，GitHub Actions 会并行构建 Apple Silicon DMG 与 Windows x64 MSI，并创建 `v<版本号>` Release；同版本不会重复发布

**禁止直接推送至 `release` 分支**，仅可通过PR向 `release` 提交合并请求


## 贡献

欢迎提交 Issue 与 Pull Request：

1. Fork 本仓库，从 `main` 拉取特性分支（`feat/<主题>`）
2. 保持代码风格与现有约定一致，补齐对应测试
3. 提交信息使用约定式前缀（`feat:` / `fix:` / `docs:` / `test:` 等）
4. 合入前请确保：lint / typecheck / 全量测试通过，并由 QA 完成回归

## 截图
![监控总览](http://qn.bspartner.top/images/PixPin_2026-09-08_19-19-35-2026-09-08-nJJtCB2M.png)
![直播间管理](http://qn.bspartner.top/images/PixPin_2026-09-08_19-19-58-2026-09-08-STkZ75BL.png)
![录制历史](http://qn.bspartner.top/images/Pasted%20image%2020260908193103-2026-09-08-vhUF39wF.png)
![直播墙](http://qn.bspartner.top/images/PixPin_2026-09-08_19-20-52-2026-09-08-cJoI4FSR.png)
