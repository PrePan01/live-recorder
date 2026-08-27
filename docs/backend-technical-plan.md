# Live Recorder 后端技术方案

## 1. 技术栈

| 层面 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | Node.js >= 20 LTS | 跨平台，生态成熟 |
| 语言 | TypeScript 7.0 | 严格模式，全量类型覆盖 |
| HTTP 框架 | Fastify | 高性能，原生 TypeScript 支持，Schema 校验 |
| 数据库 | better-sqlite3 | 同步 API，单文件，适合本地服务 |
| WebSocket | ws | 轻量，用于流转发 |
| SSE | fastify-sse-v2 | 状态推送 |
| 日志 | pino | Fastify 默认日志库，结构化输出 |
| 密钥存储 | keytar | 操作系统 keychain（macOS Keychain / Windows Credential Manager） |
| 流处理 | Node.js 原生 stream | 录制流复制与转发 |
| 测试 | vitest | 快速，兼容 Jest API |
| 构建 | tsx（开发）/ tsc（生产） | 开发热重载，生产编译 |

## 2. 项目结构

```
backend/
├── src/
│   ├── index.ts                  # 入口，启动服务
│   ├── config/
│   │   ├── defaults.ts           # 默认配置
│   │   └── schema.ts             # 配置 Schema 校验
│   ├── db/
│   │   ├── connection.ts         # SQLite 连接管理
│   │   ├── migrations/           # 数据库迁移脚本
│   │   └── repositories/         # 数据访问层
│   │       ├── room.repo.ts
│   │       ├── recording.repo.ts
│   │       ├── settings.repo.ts
│   │       └── alert.repo.ts
│   ├── api/
│   │   ├── routes/               # REST 路由
│   │   │   ├── rooms.ts
│   │   │   ├── recordings.ts
│   │   │   ├── settings.ts
│   │   │   ├── alerts.ts
│   │   │   └── health.ts
│   │   ├── sse.ts                # SSE 推送管理
│   │   └── websocket.ts          # WebSocket 流转发
│   ├── core/
│   │   ├── scheduler.ts          # 调度器
│   │   ├── recorder.ts           # 录制管理器
│   │   ├── preview-manager.ts    # 预览管理器
│   │   └── notifier.ts           # 通知管理器
│   ├── platform/
│   │   ├── adapter.ts            # 平台适配器接口
│   │   ├── factory.ts            # 适配器工厂
│   │   ├── bilibili.ts           # B站适配器
│   │   └── douyin.ts             # 抖音适配器
│   ├── recorder/
│   │   ├── engine.ts             # 录制引擎接口
│   │   ├── stream-recorder.ts    # 流录制实现
│   │   └── fake-recorder.ts      # 测试用假录制器
│   ├── storage/
│   │   ├── disk-guard.ts         # 磁盘空间检查
│   │   └── file-organizer.ts     # 文件路径组织
│   ├── mail/
│   │   ├── smtp.ts               # SMTP 发送
│   │   └── dedup.ts              # 通知去重
│   ├── security/
│   │   ├── secret-store.ts       # SecretStore 接口（get/set/delete）
│   │   ├── keychain-store.ts     # keytar 实现（macOS/Windows keychain）
│   │   └── memory-store.ts       # 内存 fake（测试与 CI 无 GUI 环境）
│   ├── types/                    # 共享类型定义
│   │   ├── room.ts
│   │   ├── recording.ts
│   │   ├── settings.ts
│   │   ├── alert.ts
│   │   └── error.ts
│   └── utils/
│       ├── url-parser.ts         # 链接规范化
│       └── logger.ts             # 日志工具
├── test/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## 3. 核心模块设计

### 3.1 平台适配器接口

```typescript
interface PlatformAdapter {
  readonly platform: 'bilibili' | 'douyin';

  checkLiveStatus(roomUrl: string, cookie?: string): Promise<LiveStatusResult>;
  getStreamUrl(roomUrl: string, quality: Quality, cookie?: string): Promise<StreamUrlResult>;
  normalizeUrl(rawUrl: string): string;
  validateUrl(rawUrl: string): boolean;
}

interface LiveStatusResult {
  status: 'offline' | 'live' | 'restricted' | 'error';
  streamSessionId?: string;
  streamTitle?: string;
  displayName?: string;
  availableQualities?: Quality[];
  error?: AppError;
}

interface StreamUrlResult {
  url: string;
  format: 'flv' | 'hls';
  actualQuality: Quality;
  headers?: Record<string, string>;
}

type Quality = 'original' | '1080p' | '720p' | '360p';
```

### 3.2 录制引擎接口

```typescript
interface RecordingEngine {
  start(input: StreamInput, outputPath: string): AsyncIterable<RecordingEvent>;
  stop(): Promise<void>;
}

interface StreamInput {
  url: string;
  format: 'flv' | 'hls';
  headers?: Record<string, string>;
}

type RecordingEvent =
  | { type: 'file_created'; filePath: string }
  | { type: 'data'; chunk: Buffer }
  | { type: 'completed'; fileSize: number }
  | { type: 'error'; error: AppError }
  | { type: 'stream_format_changed' };
```

### 3.3 调度器

```typescript
class Scheduler {
  constructor(
    private adapters: Map<string, PlatformAdapter>,
    private recorder: RecorderManager,
    private rooms: RoomRepository,
    private sse: SSEManager,
  ) {}

  start(): void;
  stop(): void;
  triggerImmediateCheck(roomId: string): Promise<void>;
}
```

调度器使用 `setInterval` 按配置间隔轮询。每个房间按平台类型选择对应适配器。检测结果通过 SSE 推送给前端。

### 3.4 录制管理器

```typescript
class RecorderManager {
  private activeRecordings: Map<string, RecordingSession>;
  private previewManager: PreviewManager;

  async startRecording(room: Room, streamInfo: StreamUrlResult): Promise<void>;
  async stopRecording(roomId: string): Promise<void>;
  async handleStreamDisconnect(roomId: string): Promise<void>;
  getActivePreviewCount(): number;
  async startPreview(roomId: string, ws: WebSocket): Promise<void>;
}
```

录制管理器负责：
- 管理活跃录制会话
- 断流重连逻辑（5/15/45 秒退避）
- 流数据复制：同时写入文件 + 转发给预览 WebSocket
- 同一场直播去重（streamSessionId）
- pending 超时检测（30 秒）

### 3.5 预览管理器

```typescript
class PreviewManager {
  private maxPreviews = 2;
  private activePreviews: Map<string, Set<WebSocket>>;

  canStartPreview(): boolean;
  addPreview(roomId: string, ws: WebSocket): void;
  removePreview(roomId: string, ws: WebSocket): void;
  broadcastData(roomId: string, chunk: Buffer): void;
  notifyDisconnect(roomId: string): void;
}
```

### 3.6 通知管理器

```typescript
class Notifier {
  private dedupMap: Map<string, number>;
  private dedupWindowMs = 30 * 60 * 1000;

  async sendNotification(
    roomId: string,
    event: 'recording_started' | 'recording_failed' | 'disk_space_low',
    context: Record<string, unknown>,
  ): Promise<void>;
}
```

## 4. API 设计

### 4.1 REST API

#### 房间管理
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/rooms` | 获取所有房间 |
| POST | `/api/v1/rooms` | 添加房间 |
| PATCH | `/api/v1/rooms/:id` | 编辑房间 |
| DELETE | `/api/v1/rooms/:id` | 删除房间 |
| PATCH | `/api/v1/rooms/:id/enable` | 启用/停用房间 |
| POST | `/api/v1/rooms/:id/check` | 立即检测 |
| POST | `/api/v1/rooms/:id/stop-recording` | 停止当前录制 |

#### 录制历史
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/recordings` | 获取录制历史（支持分页、按 sessionId 分组） |
| POST | `/api/v1/recordings/:id/open` | 打开文件所在目录 |

#### 设置
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/settings` | 获取设置（密码不回显） |
| PUT | `/api/v1/settings` | 更新设置 |
| POST | `/api/v1/settings/validate-directory` | 校验目录 |
| POST | `/api/v1/settings/test-smtp` | 测试 SMTP |

#### 告警
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/alerts` | 获取告警列表 |
| PATCH | `/api/v1/alerts/:id` | 标记单条已读 |
| POST | `/api/v1/alerts/read-all` | 全部标记已读 |

#### 服务状态
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/service/status` | 服务状态、磁盘空间、活跃录制数、setupCompleted |

### 4.2 SSE 事件

端点：`GET /api/v1/events`

事件类型：
- `room:updated` — 房间状态变更
- `recording:updated` — 录制状态变更
- `alert:created` — 新告警
- `alert:updated` — 告警更新
- `settings:updated` — 设置变更
- `service:status` — 服务状态变更
- `disk:space` — 磁盘空间变更

### 4.3 WebSocket

端点：`ws://127.0.0.1:43120/ws/preview/:roomId`

- 连接后接收 FLV 流数据
- 服务端主动断开时发送 `{ type: 'stream_end', reason: string }`
- 超过预览上限返回 4003 关闭码

## 5. 数据模型

### SQLite 表结构

```sql
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL CHECK(platform IN ('bilibili', 'douyin')),
  url TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  monitor_state TEXT NOT NULL DEFAULT 'idle',
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, url)
);

CREATE TABLE recordings (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  platform TEXT NOT NULL,
  stream_session_id TEXT,
  stream_title TEXT DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  file_path TEXT,
  file_size_bytes INTEGER DEFAULT 0,
  failure_reason TEXT,
  retry_count INTEGER DEFAULT 0,
  quality TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_recordings_room_id ON recordings(room_id);
CREATE INDEX idx_recordings_stream_session ON recordings(room_id, stream_session_id);
CREATE INDEX idx_recordings_state ON recordings(state);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK(level IN ('info', 'warning', 'error')),
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_alerts_resolved ON alerts(resolved);
```

## 6. 错误处理

```typescript
class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public roomId?: string,
    public recordingId?: string,
    public retryable: boolean = false,
  ) {
    super(message);
  }
}

type ErrorCode =
  | 'ROOM_LINK_INVALID'
  | 'ROOM_LINK_DUPLICATE'
  | 'PLATFORM_ACCESS_RESTRICTED'
  | 'DIRECTORY_NOT_WRITABLE'
  | 'DISK_SPACE_INSUFFICIENT'
  | 'CONCURRENT_LIMIT_REACHED'
  | 'RECORDING_START_FAILED'
  | 'STREAM_DISCONNECTED_RECONNECT_EXHAUSTED'
  | 'SMTP_SEND_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'NETWORK_UNAVAILABLE'
  | 'RECORDING_FILE_CORRUPTED'
  | 'CONFIG_LOAD_FAILED'
  | 'STREAM_FORMAT_CHANGED'
  | 'PREVIEW_LIMIT_REACHED'
  | 'QUALITY_DOWNGRADED';
```

所有 API 错误响应格式：
```json
{
  "error": {
    "code": "ROOM_LINK_INVALID",
    "message": "链接无效或平台不支持",
    "roomId": "xxx",
    "retryable": false
  }
}
```

## 7. 可测试性设计

所有外部依赖通过接口抽象，支持依赖注入：

```typescript
interface Services {
  platformAdapter: (platform: string) => PlatformAdapter;
  recordingEngine: () => RecordingEngine;
  diskGuard: DiskGuard;
  mailer: Mailer;
  secretStore: SecretStore;
  clock: Clock;
  scheduler: Scheduler;
}
```

阶段 B 使用 fake 实现：
- `FakePlatformAdapter` — 模拟开播/未开播/受限
- `FakeRecordingEngine` — 模拟流数据写入
- `FakeDiskGuard` — 模拟磁盘空间
- `FakeMailer` — 记录发送日志
- `FakeSecretStore`（memory-store）— 内存存储密钥，CI/无 GUI 环境不依赖 keytar

## 8. 安全设计

- 服务绑定 `127.0.0.1`，拒绝外部连接
- SMTP 密码通过 `SecretStore` 接口写入操作系统 keychain（生产为 keytar 实现；测试/CI 注入 `FakeSecretStore`，不落盘）
- API 响应中 `settings.mail.pass` 永远返回 `***`
- 日志中密码、Cookie 等字段脱敏
- WebSocket 预览连接仅接受 localhost

## 9. 阶段 B 交付物

1. 服务启动，绑定 `127.0.0.1:43120`
2. SQLite 初始化 + 迁移
3. 全部 REST API（fake 数据）
4. SSE 推送框架
5. WebSocket 预览框架
6. 调度器 + fake 适配器
7. 录制管理器 + fake 引擎
8. 配置持久化
9. 完整单元测试覆盖核心模块

## 10. 阶段 C 关键实现

1. B站适配器（公开 API + 流地址获取 + 清晰度选择）
2. 抖音适配器（内部接口 + 反爬处理 + Cookie 支持）
3. 真实录制引擎（stream 写入文件）
4. 流复制（录制 + 预览同时）
5. SMTP 邮件发送
6. keytar 集成
7. 前后端联调
