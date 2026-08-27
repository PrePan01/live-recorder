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

调度器按平台独立间隔轮询（`checkIntervalSec`，可配置：bilibili 默认 60s、douyin 默认 120s，含全局默认值兜底），同一平台内房间串行检测；每个房间按平台类型选择对应适配器。检测结果通过 SSE 推送给前端。

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
  // endReason 存在时先下发 stream_end 帧，再按 closeCode 关闭连接
  notifyDisconnect(roomId: string, closeCode: number, endReason?: 'ended' | 'stream_lost'): void;
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

#### 响应 envelope 约定（BE/FE 联合定稿）

- 单资源：`{ room }` / `{ recording }` / `{ alert }`；`POST /rooms` 返回 `201 + { room }`；`DELETE` 返回 `204` 无 body
- 列表：`GET /rooms` → `{ rooms }`；`GET /recordings` → `{ items, total, page, pageSize }`；`GET /alerts` → `{ alerts }`
- `GET/PUT /settings` → `{ settings }`；`GET /service/status` → `{ serviceStatus }`
- 操作类端点（check / stop-recording / open / validate-directory / test-smtp / read-all）→ `{ ok: true }`，必要时附资源字段
- `PATCH /rooms/:id/enable` 请求体 `{ enabled: boolean }`，返回 `{ room }`
- 全部字段 camelCase；`GET /recordings` 查询参数 `page/pageSize/roomId/state/sessionId/groupBy`，默认 `startedAt` 倒序，pageSize 默认 20（上限 100）

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

报文格式：标准 SSE 帧，`event: <事件名>` 行 + `data: <JSON>` 行，FE 按事件名 `addEventListener` 订阅；`data` 为资源模型或统一错误对象（camelCase），不在 data 内嵌 type 字段。

### 4.3 WebSocket

端点：`ws://127.0.0.1:43120/ws/preview/:roomId`

- 连接后接收 FLV 二进制帧；服务端在流正常结束（1000）与断流（4004）场景先发送 `{ type: 'stream_end', reason: 'ended' | 'stream_lost' }`，再下发关闭帧；4002/4003/1011 直接以关闭帧结束
- 关闭码约定（BE/FE 联合定义，纳入 API 契约"错误码/关闭码"小节，前端据此映射提示文案）：

| 关闭码 | 含义 | 前置 stream_end reason | 对应错误码 |
| --- | --- | --- | --- |
| 1000 | 正常结束（直播结束 / 用户停止录制） | `ended` | — |
| 4002 | 房间不存在或当前未在录制 | — | PREVIEW_NOT_RECORDING（新增，retryable=false） |
| 4003 | 预览并发超限（全局 2 路） | — | PREVIEW_LIMIT_REACHED |
| 4004 | 服务端断流，重连耗尽 | `stream_lost` | STREAM_DISCONNECTED_RECONNECT_EXHAUSTED |
| 1011 | 服务内部错误 | — | —（FE 自动重连兜底） |

- 重连约定：仅 1011/网络错误由前端自动重连（≤3 次，1/3/5s）；4002/4003/4004 不重连；FE 以 `stream_end.reason` 为准展示，关闭码仅兜底

## 4.4 字段命名与暴露约定（第 3 项评审结论并入）

- 检测间隔统一为 `checkIntervalSec: { bilibili: 60, douyin: 120 }`（按平台对象），废弃 `pollIntervalSeconds` 命名
- SMTP 密码不回显，仅返回 `passwordSet: true/false` 标记
- `dedupeWindowMinutes` v1 不暴露到 `/settings`，服务端固定 30 分钟；契约预留可选字段，后续按需开放

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

### API 输出约定（第 6 项评审定稿）

- `room.lastError` / `recording.failureReason`：DB 存错误信封紧凑 JSON，repository 层解析后以**结构化对象**返回（`{ code, message, occurredAt, retryable, recordingId? }` 或 `null`），不返回转义字符串，FE 无需 JSON.parse
- snake_case → camelCase 映射集中在 repositories，core 层只见 camelCase
- 内部字段（`quality`、`schema_version`、`alerts.resolved` 的读接口形态）暂不入契约，需暴露时走契约变更
- ID 为带前缀 ULID（`room_` / `rec_` / `alr_`）；时间为 UTC ISO-8601 TEXT 原样输出

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
  | 'PLATFORM_CHANGED'
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
  | 'PREVIEW_NOT_RECORDING'
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

### 错误码总表（18 码 = FE 已确认 16 码 + 新增 2 码）

新增（已获 FE/QA 认可待第 5 项定稿）：`PREVIEW_NOT_RECORDING`（挂 WS 4002）、`PLATFORM_CHANGED`（平台接口/反爬变更）。

| 码 | 触发面 | HTTP（请求错误时） | retryable | 告警级别 |
| --- | --- | --- | --- | --- |
| ROOM_LINK_INVALID | 添加/编辑房间 | 422 | false | — |
| ROOM_LINK_DUPLICATE | 添加房间 | 409 | false | — |
| DIRECTORY_NOT_WRITABLE | validate-directory / PUT settings | 422 | false | error |
| DISK_SPACE_INSUFFICIENT | 调度/手动检测 | 409 | false | error（含邮件） |
| CONCURRENT_LIMIT_REACHED | 手动检测；自动调度仅 SSE | 409 | true（下轮重排） | warning |
| SMTP_SEND_FAILED | test-smtp；后台通知仅告警 | 502 | true | warning |
| SERVICE_UNAVAILABLE | 启停窗口期请求 | 503 | true | — |
| CONFIG_LOAD_FAILED | 启动配置加载失败 | 500 | false | error |
| PLATFORM_ACCESS_RESTRICTED | 运行时检测（登录/Cookie/私密） | — | false | warning |
| PLATFORM_CHANGED | 运行时检测（平台接口/反爬变更） | — | false | error |
| NETWORK_UNAVAILABLE | 平台请求超时/失败 | — | true | warning |
| RECORDING_START_FAILED | 录制器启动失败 | — | true | error（含邮件） |
| STREAM_DISCONNECTED_RECONNECT_EXHAUSTED | 重连耗尽；WS 4004 | — | true（下场直播） | error（含邮件） |
| RECORDING_FILE_CORRUPTED | 完成校验失败 | — | false | error |
| STREAM_FORMAT_CHANGED | 录制引擎事件，服务端自动续录（当前段 completed + 新段） | — | —（提示类，不重试） | info |
| QUALITY_DOWNGRADED | 清晰度降级，提示类 | — | — | info |
| PREVIEW_LIMIT_REACHED | WS 握手 4003 | — | true（有预览释放后） | — |
| PREVIEW_NOT_RECORDING | WS 握手 4002 | — | false | — |

约定：请求错误走 4.4 统一信封；运行时错误经 `room:updated.lastError`、`recording:updated.failureReason`、`alert:created`（level=error/warning）三通道，不设独立 `service.error` SSE 事件（原设计稿废用，已并入告警通道），同一 code 定义唯一；提示类（QUALITY_DOWNGRADED/STREAM_FORMAT_CHANGED）只进告警 level=info，不发邮件。邮件仍限三类：recording_started / recording_failed / disk_space_low。命名统一：磁盘空间不足一律 `DISK_SPACE_INSUFFICIENT`，旧契约示例中的 `DISK_SPACE_LOW` 作废。

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
- `FakeClock` — 可跳时钟：退避 5/15/45s、按平台轮询、30min 去重窗、30s pending 超时的时序用例不真等

## 8. 安全设计

- 服务绑定 `127.0.0.1`，拒绝外部连接
- SMTP 密码通过 `SecretStore` 接口写入操作系统 keychain（生产为 keytar 实现；测试/CI 注入 `FakeSecretStore`，不落盘）
- API 不回显密码，`GET /settings` 仅返回派生标记 `passwordSet`
- 日志中密码、Cookie 等字段脱敏
- WebSocket 预览连接仅接受 localhost
- Host/Origin 校验：生产仅允许 `127.0.0.1:43120` / `localhost:43120`；dev 模式白名单追加 `http://localhost:5173`（Vite 代理），白名单可配置，不写死
- 平台 Cookie 与 SMTP 密码同存 `SecretStore`，不入库、不进日志
- 合规边界：适配器仅访问公开、允许访问的直播间，不绕过任何访问控制（受限→`PLATFORM_ACCESS_RESTRICTED` 引导自配 Cookie；接口/反爬变更→`PLATFORM_CHANGED`）；录制仅使用适配器返回的合法流地址
- 文件安全：录像仅写入用户配置目录（validate-directory 校验可写与路径包含，拒绝穿越）；`POST /recordings/:id/open` 仅接受表内 id、打开其派生路径，不接受任意路径参数
- 无遥测：出站请求仅限两平台公开接口

## 9. 阶段 B 交付物

0. Fake 输出最小可播放 FLV（header + onMetaData + 循环关键帧/静音 AAC ≈2fps），FE 可直连联调 MSE 链路

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
3. 真实录制引擎（stream 写入 MKV；断流保留已录部分。不完整 MKV 验收口径：ffprobe 可读 + VLC 可播放已写片段即通过，写入采用预写 Segment 尺寸提升容错）
4. 流复制（录制 + 预览同时，背压隔离：预览慢消费不阻塞录制写入）
5. SMTP 邮件发送
6. keytar 集成
7. 前后端联调（FE 按环境变量一键切真实服务）
