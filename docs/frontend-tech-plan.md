# 前端技术方案

## 1. 技术选型

| 类别 | 选型 | 版本 | 说明 |
|------|------|------|------|
| 构建工具 | Vite | ^8.2 | 快速开发体验 |
| 框架 | React | ^19.2 | 成熟生态 |
| 语言 | TypeScript | ^7.0 | 类型安全 |
| UI 组件库 | Ant Design | ^6.6 | 企业级组件 |
| 路由 | React Router | ^7.0 | SPA 路由 |
| 状态管理 | Zustand | ^5.0 | 轻量状态管理 |
| HTTP 客户端 | axios | ^1.7 | REST API |
| 视频播放 | flv.js | ^1.6 | 低延迟直播流 |
| 代码规范 | ESLint + Prettier | latest | 代码质量 |

## 2. 项目结构

```
frontend/
├── src/
│   ├── api/              # API 请求封装
│   │   ├── client.ts     # axios 实例
│   │   ├── rooms.ts      # 房间相关 API
│   │   ├── recordings.ts # 录制相关 API
│   │   ├── settings.ts   # 设置相关 API
│   │   └── alerts.ts     # 告警相关 API
│   ├── components/       # 通用组件
│   │   ├── Layout/       # 布局组件
│   │   ├── RoomCard/     # 房间卡片
│   │   ├── RecordingRow/ # 录制记录行
│   │   ├── AlertList/    # 告警列表
│   │   ├── VideoPlayer/  # 视频播放器
│   │   └── StatusBar/    # 顶部状态栏
│   ├── pages/            # 页面组件
│   │   ├── Setup/        # 首次设置
│   │   ├── Rooms/        # 直播间管理
│   │   ├── Monitor/      # 监控总览
│   │   ├── History/      # 录制历史
│   │   └── Settings/     # 设置与告警
│   ├── stores/           # 状态管理
│   │   ├── roomStore.ts
│   │   ├── recordingStore.ts
│   │   ├── settingsStore.ts
│   │   └── alertStore.ts
│   ├── hooks/            # 自定义 Hooks
│   │   ├── useSSE.ts     # SSE 连接管理
│   │   ├── useServiceStatus.ts
│   │   └── useVideoPlayer.ts
│   ├── types/            # TypeScript 类型
│   │   ├── room.ts
│   │   ├── recording.ts
│   │   ├── settings.ts
│   │   └── alert.ts
│   ├── utils/            # 工具函数
│   │   ├── errorMap.ts   # 错误码映射
│   │   └── format.ts     # 格式化工具
│   ├── App.tsx           # 根组件
│   └── main.tsx          # 入口文件
├── public/
├── index.html
├── vite.config.ts
├── tsconfig.json
└── package.json
```

## 3. 路由设计

| 路径 | 页面 | 说明 |
|------|------|------|
| `/setup` | Setup | 首次设置向导 |
| `/rooms` | Rooms | 直播间管理 |
| `/monitor` | Monitor | 监控总览（默认首页） |
| `/history` | History | 录制历史 |
| `/settings` | Settings | 设置与告警 |

路由守卫：
- 首次访问检查是否完成设置，未完成则跳转 `/setup`
- 设置完成后 `/setup` 不可访问

## 4. 页面设计

### 4.1 全局布局

```
┌─────────────────────────────────────────────────────────┐
│ StatusBar: 服务状态 | 磁盘空间 | 告警数                    │
├─────────────────────────────────────────────────────────┤
│ 侧边导航  │  主内容区                                     │
│ ────────  │                                              │
│ 监控总览  │                                              │
│ 直播间    │                                              │
│ 录制历史  │                                              │
│ 设置      │                                              │
└─────────────────────────────────────────────────────────┘
```

### 4.2 首次设置（Setup）

向导式分步表单（Ant Design Steps）：
- Step 1: 选择录像保存目录（目录选择器 + 校验结果展示）
- Step 2: 设置最大并发数（数字输入，默认 2）
- Step 3: SMTP 配置（可选，含测试发送按钮）
- Step 4: 完成确认

### 4.3 直播间管理（Rooms）

- 列表展示：表格形式，列包括平台、显示名、链接、状态、操作
- 添加房间：Modal 表单，输入链接后自动解析平台和显示名
- 操作按钮：编辑、启用/停用、删除
- 状态标签：不同颜色标识不同状态

### 4.4 监控总览（Monitor）

- 卡片/表格切换视图
- 每个房间卡片包含：
  - 基本信息（平台、显示名）
  - 当前状态（带颜色标识）
  - 最近检测时间
  - 操作按钮：立即检测、观看（仅录制中显示）
- 观看功能：点击后弹出 Modal 播放视频流

### 4.5 录制历史（History）

- 表格展示，按时间倒序
- 列：房间、平台、标题、开始/结束时间、状态、大小、操作
- 操作：打开所在目录
- 支持按 session 分组查看（同一场直播多段录制）

### 4.6 设置与告警（Settings）

- 设置表单：保存目录、并发、检测间隔、重试策略、清晰度、邮件配置
- 告警列表：级别、来源、消息、时间、操作（标记已读）
- 批量操作：全部标记已读

## 5. 状态管理

使用 Zustand 管理全局状态：

### 5.1 roomStore
- rooms: Room[]
- addRoom / updateRoom / removeRoom
- toggleRoom / checkRoomNow

### 5.2 recordingStore
- recordings: Recording[]
- fetchHistory
- openDirectory

### 5.3 settingsStore
- settings: Settings
- serviceStatus: 'online' | 'offline' | 'connecting'
- diskSpace: { free: number; total: number }
- updateSettings

### 5.4 alertStore
- alerts: Alert[]
- unreadCount: number
- markRead / markAllRead

### 5.5 SSE 状态同步
- 建立单条 SSE 连接订阅所有状态变更
- 断线自动重连（最多 3 次，指数退避）
- 服务断开时 StatusBar 显示"服务已断开"

## 6. API 契约

### 6.1 REST API

基础路径：`http://127.0.0.1:43120/api/v1`

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /rooms | 获取房间列表 |
| POST | /rooms | 添加房间 |
| PATCH | /rooms/:id | 更新房间 |
| DELETE | /rooms/:id | 删除房间 |
| POST | /rooms/:id/check | 立即检测 |
| GET | /recordings | 获取录制历史 |
| POST | /recordings/:id/open | 打开所在目录 |
| GET | /settings | 获取设置 |
| PUT | /settings | 更新设置 |
| POST | /settings/validate-directory | 校验目录 |
| POST | /settings/test-smtp | 测试邮件 |
| GET | /alerts | 获取告警列表 |
| PATCH | /alerts/:id | 标记告警已读 |
| POST | /alerts/read-all | 全部标记已读 |
| GET | /service/status | 获取服务状态 |

### 6.2 SSE 事件

端点：`/events`

事件类型：
- `room:updated` - 房间状态变更
- `recording:updated` - 录制状态变更
- `alert:created` - 新告警
- `alert:updated` - 告警更新
- `settings:updated` - 设置变更
- `service:status` - 服务状态变更
- `disk:space` - 磁盘空间变更

### 6.3 WebSocket 视频流

端点：`ws://127.0.0.1:43120/ws/preview/:roomId`

协议：FLV over WebSocket

## 7. 视频播放器

### 7.1 技术选型
- flv.js：支持 WS-FLV，延迟低（1-3 秒）
- 仅支持 Chrome/Firefox，Safari 显示兼容性提示

### 7.2 实现要点
- 使用 React Hook 封装播放器生命周期
- 组件卸载时正确销毁播放器实例
- 断流自动重连（最多 3 次）
- 最多 2 路同时预览，超过提示"预览数已达上限"

### 7.3 组件设计
```tsx
<VideoPlayer
  roomId={string}
  visible={boolean}
  onClose={() => void}
/>
```

## 8. 错误处理

### 8.1 错误码映射
前端维护错误码到用户友好提示的映射表：

```typescript
const ERROR_MAP = {
  ROOM_LINK_INVALID: '链接无效，请检查后重试',
  ROOM_LINK_DUPLICATE: '该直播间已存在',
  PLATFORM_ACCESS_RESTRICTED: '平台访问受限，请检查 Cookie 配置',
  DIRECTORY_NOT_WRITABLE: '目录不可写，请检查权限',
  DISK_SPACE_INSUFFICIENT: '磁盘空间不足',
  CONCURRENT_LIMIT_REACHED: '并发录制数已达上限',
  // ... 其他错误码
};
```

### 8.2 重试机制
- 根据 `retryable` 字段决定是否显示"重试"按钮
- 网络错误自动重试（最多 3 次）

## 9. 实现计划

### 阶段 B：可用骨架（预计 2 天）
1. 项目初始化：安装依赖、配置 ESLint/Prettier
2. 基础架构：Layout、路由、StatusBar
3. API 层：axios 封装、SSE 连接
4. 状态管理：Zustand stores
5. 页面骨架：5 个页面基础结构
6. Mock 数据：开发阶段使用 mock 数据

### 阶段 C：功能实现（预计 3 天）
1. 首次设置流程
2. 直播间管理（增删改查）
3. 监控总览（状态展示、立即检测）
4. 录制历史（列表、打开目录）
5. 设置与告警
6. 视频播放器集成

### 阶段 D：联调与验收（预计 2 天）
1. 前后端联调
2. 异常场景测试
3. 跨浏览器测试（Chrome/Firefox/Safari）
4. 性能优化

## 10. 依赖清单

```json
{
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-router-dom": "^7.0.0",
    "antd": "^6.6.0",
    "zustand": "^5.0.0",
    "axios": "^1.7.0",
    "flv.js": "^1.6.0",
    "dayjs": "^1.11.0"
  },
  "devDependencies": {
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^7.0.0",
    "vite": "^8.2.0",
    "eslint": "^9.0.0",
    "prettier": "^3.3.0"
  }
}
```
