# localhost 录制服务 API 契约（v2.2 · 2026-08-29）

相对 v2.1 的变更（V5 Phase 0 契约先行，task #93）：
- `Room` 新增 `tags`（标签分组，`Tag[]`）、`uploadEnabled`（上传开关，`null`=继承全局）、`titleSource`/`titleUpdatedAt`/`titleFallbackUsed`（标题识别元数据）。
- 新增 `Tag` 资源与标签端点；`PUT /rooms/:id/tags` 覆盖式设置房间标签。
- `Recording.state` 新增 `processing`；`Recording` 新增 `pipelineStatus`、`metadata`、`coverPath`（后处理管线字段）。
- 新增 `GET /search` 全局搜索（参数化 LIKE、分页上限、查询超时）、`GET /stats/recordings` 统计聚合（服务端聚合+短缓存）、`GET/PUT /settings/pipeline` 管线配置契约。
- 新增诊断接口：`GET /diagnostics`、`GET /diagnostics/:id`、`POST /diagnostics/:id/actions/:action`（幂等键）。
- 新增错误码：`TAG_INVALID`、`SEARCH_QUERY_INVALID`、`SEARCH_TIMEOUT`、`DIAGNOSTIC_ACTION_INVALID`、`DIAGNOSTIC_CONFLICT`、`PIPELINE_CONFIG_INVALID`。

相对 v2.0 的变更：`Recording` 新增 `roomName`（创建录播时快照的房间显示名，删房间后历史页仍可展示房间名）；`DELETE /rooms/:id` 不再级联删除该房间的录制历史（仅移除监控配置，录制记录与文件保留，历史页仍可按 roomId 查看）。

相对 v1.9 的变更：`Room` 新增 `lastLiveStatus`（最近检测直播状态 live/offline/restricted，SSE room:updated 输出，供监控开播标识）；新增 `POST /rooms/:id/start-recording`（手动强制开始录制，绕过 autoRecord，未开播/已录制→409 RECORDING_NOT_AVAILABLE）。

Base URL：`http://127.0.0.1:43120/api/v1`。所有响应均为 JSON；失败响应统一为错误信封（见"统一错误信封"）。

状态说明：v1.1 冻结口径全部保留；v1.2 经 8a5f0b88 线程互确认；v1.3 抖音 Cookie 经 QA 确认 + PM 批准；v1.4 目录选择与配置导入导出经 QA/FE 评估 + PM 定 P0.5；v1.5 收藏与录制时长经 PM 定稿（task #35/#37/#36/#38）；v1.6 批量添加与历史页增强经评审会共识（BE #44/#45 + FE #47/#48/#49）；v1.7 完整性校验/一键自检/失败重试经评审会共识（BE #50/#51/#54 + FE #52/#53/#55）；v1.8 回放/格式/批量删除/CSV/健康度经评审会共识（BE #58/#60/#64/#67/#69/#70）。后续变更继续走版本升级并经三方互确认。

## 资源模型

### `Room`

```json
{
  "id": "room_01J...",
  "platform": "bilibili",
  "url": "https://live.bilibili.com/123",
  "displayName": "主播名",
  "enabled": true,
  "favorited": false,
  "monitorState": "idle",
  "lastCheckedAt": "2026-08-28T01:00:00.000Z",
  "lastError": null,
  "activeRecording": null,
  "tags": [],
  "uploadEnabled": null,
  "titleSource": "adapter",
  "titleUpdatedAt": "2026-08-28T01:00:00.000Z",
  "titleFallbackUsed": false,
  "createdAt": "2026-08-28T01:00:00.000Z",
  "updatedAt": "2026-08-28T01:00:00.000Z"
}
```

`tags`（v2.2，#93）：房间关联标签 `Tag[]`（`PUT /rooms/:id/tags` 覆盖式设置，单房间 ≤20 个，标签名 ≤30 字符）。

`uploadEnabled`（v2.2，#93）：房间上传开关，`null`=继承全局（openlist.enabled），`true/false`=单独覆盖；`PATCH /rooms/:id` body `{ uploadEnabled: true|false|null }` 设置/清除。

`titleSource`/`titleUpdatedAt`/`titleFallbackUsed`（v2.2，#93）：标题识别元数据——`titleSource` 为 `adapter|fallback|manual`（平台识别/回退源/手动改名），未识别为 null；`titleFallbackUsed` 标记当前显示名是否来自回退源。

`monitorState`：`idle | checking | recording | reconnecting | completed | failed | disabled`。停用条目的状态为 `disabled`；录制项不使用 `checking` 或 `disabled`。

`favorited`（v1.5）：手动收藏标记，`PATCH /rooms/:id/favorite` 切换，监控总览按收藏置顶。

`autoRecord`（v1.9，#75/#77）：房间级自动录制开关，`null`=继承全局 `settings.autoRecord`（默认 true），`true/false`=单独覆盖；`PATCH /rooms/:id` body `{ autoRecord: true|false|null }` 设置/清除（null 恢复继承）。统一语义（#77）：有效 autoRecord = room ?? 全局，统一决定调度器与手动 `/check`——false 时任何检测（含手动）都不自动开始录制（仅检测更新状态），true 检测即录。

`lastLiveStatus`（v2.0，#78）：最近一次检测的直播状态 `live | offline | restricted`（未检测过为 null），由调度器 checkLiveStatus 结果写入、SSE `room:updated` 输出，供监控卡片开播标识（与 autoRecord/monitorState 独立，可区分「开播但仅检测」vs「离线」）。

`activeRecording`（v1.5）：当前录制会话信息，未录制为 `null`；录制中为 `{ "recordingId": "rec_01J...", "startedAt": "2026-08-28T01:00:00.000Z" }`。`startedAt` 为该场次首次开始时间（断流重连续录不重置），前端秒级走时显示录制时长。

`lastError`（Room）与 `failureReason`（Recording）为结构化对象或 `null`：`{ "code": "...", "message": "...", "occurredAt": "...", "retryable": true|false, "recordingId?": "..." }`（v1.1 第 6 项口径：DB 存 JSON，repository 层解析后输出，全链路无转义字符串，FE 直接断言 code）。

### `Recording`

```json
{
  "id": "rec_01J...",
  "roomId": "room_01J...",
  "roomName": "主播名",
  "platform": "bilibili",
  "streamTitle": "直播标题",
  "state": "recording",
  "startedAt": "2026-08-28T01:00:00.000Z",
  "endedAt": null,
  "filePath": "/Users/me/Videos/bilibili/主播名/2026-08-28_010000.mkv",
  "fileSizeBytes": 0,
  "failureReason": null,
  "retryCount": 0,
  "streamSessionId": "sess_01J...",
  "quality": "1080p"
}
```

`state`：`pending | recording | reconnecting | processing | completed | failed`。`processing`（v2.2，#93）：录制文件生成完成后进入后处理管线（校验/切片/压缩/归档）的中间态，处理完成回到 `completed`；源录制失败才 `failed`，后处理失败保留源文件并回到 `completed + pipelineStatus=failed|partial`。`streamSessionId` 为同一场直播去重依据。`quality`（v1.6）：实际录制清晰度 `original | 1080p | 720p | 360p`，未记录时字段省略（历史页清晰度列）。`integrity`（v1.7）：录制文件完整性 `verified | failed | pending`（ffprobe 异步校验，缺 ffprobe/超时→pending，损坏/截断→failed 并发告警），未记录时字段省略。`roomName`（v2.1，#92）：创建录播时快照的房间显示名（录制开始时写入 `room.displayName`），删房间后历史页据此展示房间名而非 roomId；存量记录回填为空字符串。

`pipelineStatus`（v2.2，#93）：后处理管线状态 `not_required | queued | running | ok | partial | failed`，未参与管线时省略。`metadata`（v2.2，#93）：管线 sidecar 元数据 `{ durationMs, segmentCount, quality, size }`（真实时长/断流次数+1/清晰度/大小）。`coverPath`（v2.2，#93）：封面帧路径（可选，媒体封面占位 404）。

字段命名统一 camelCase。

## 成功响应 envelope（已冻结）

- 单资源：`{ "room": ... }` / `{ "recording": ... }` / `{ "alert": ... }`
- 列表：`GET /rooms` → `{ "rooms": [...] }`；`GET /recordings` → `{ "items": [...], "total": n, "page": n, "pageSize": n }`；`GET /settings` → `{ "settings": ... }`；`GET /alerts` → `{ "alerts": [...] }`；`GET /service/status` → `{ "serviceStatus": ... }`
- 操作类端点（无资源返回时）：`{ "ok": true }`（必要时附资源字段）
- `POST /rooms` 成功：`201` + `{ "room": ... }`；`DELETE /rooms/:id` 成功：`204` 无 body（v2.1，#92：仅移除监控配置，不再级联删除该房间的录制历史）
- `PATCH /rooms/:id/enable` body：`{ "enabled": true|false }` → `{ "room": ... }`
- `PATCH /rooms/:id/favorite` body：`{ "favorited": true|false }` → `{ "room": ... }`（v1.5）
- `POST /rooms/batch` body：`{ "urls": ["...", "..."] }`（≤100）→ `{ "succeeded": [Room...], "failed": [{ "url", "reason" }] }`（v1.6，部分成功，逐条去重含现库与批内）
- `PATCH /recordings/:id` body：`{ "streamTitle": "新标题" }` → `{ "recording": ... }`（v1.6，同步改名文件）
- `DELETE /recordings/:id` → `204`（v1.6，连带删除文件，文件缺失容错）

## 端点

| 组 | 方法/路径 | 用途 |
| --- | --- | --- |
| 房间 | `GET` / `POST` `/rooms` | 查询 / 新建关注直播间 |
| 房间 | `PATCH` / `DELETE` `/rooms/:id` | 编辑 / 删除直播间 |
| 房间 | `PATCH` `/rooms/:id/enable` | 启用/停用监控 |
| 房间 | `PATCH` `/rooms/:id/favorite` | 手动收藏/取消收藏（v1.5） |
| 房间 | `POST` `/rooms/:id/check` | 立即检测（供 UI 调试） |
| 房间 | `POST` `/rooms/:id/start-recording` | 手动强制开始录制（v2.0，绕过 autoRecord，未开播/已录制 409） |
| 房间 | `POST` `/rooms/:id/stop-recording` | 手动停止录制 |
| 房间 | `POST` `/rooms/batch` | 批量添加直播间（v1.6，部分成功） |
| 录制 | `GET` `/recordings` | 历史查询；参数 `page`、`pageSize`（默认 20，上限 100）、`roomId`、`state`、`sessionId`、`groupBy`、`dateFrom`/`dateTo`（v1.6，按 started_at 范围）；默认 `startedAt` 倒序 |
| 录制 | `POST` `/recordings/:id/open` | 打开录像所在目录 |
| 录制 | `PATCH` `/recordings/:id` | 重命名录制（v1.6，同步改文件名） |
| 录制 | `DELETE` `/recordings/:id` | 删除录制（v1.6，连带删文件，缺失容错） |
| 录制 | `GET` `/recordings/:id/file` | 历史回放（v1.8，FLV 静态服务，仅 completed 且有文件） |
| 录制 | `POST` `/recordings/batch-delete` | 批量删除（v1.8，body `{ids[]}`≤100 → `{deleted[], failed[]}`） |
| 录制 | `GET` `/recordings/export` | CSV 导出（v1.8，UTF-8 BOM，按现筛选条件+时长统计） |
| 房间 | `GET` `/rooms/:id/stats` | 房间健康度（v1.8，`?days=N` 近 N 天次数/大小/成功率+byDay） |
| 标签 | `GET` / `POST` `/tags` | 标签列表 / 新建（v2.2，body `{ name, color }`，name ≤30 唯一，color `#RRGGBB`） |
| 标签 | `PATCH` / `DELETE` `/tags/:id` | 编辑 / 删除标签（v2.2，删除只删关联，不影响房间与录制） |
| 标签 | `PUT` `/rooms/:id/tags` | 覆盖式设置房间标签（v2.2，body `{ tagIds[] }` ≤20，不存在→404） |
| 搜索 | `GET` `/search?q&type&tagId&from&to&page&pageSize` | 全局搜索（v2.2，type=room/recording/alert，参数化+分页+超时） |
| 统计 | `GET` `/stats/recordings?from&to&platform&tagId&roomId` | 统计看板（v2.2，服务端聚合+短缓存，跨度 ≤365 天） |
| 诊断 | `GET` `/diagnostics` | 诊断列表（v2.2，`?status&severity&roomId&page&pageSize`） |
| 诊断 | `GET` `/diagnostics/:id` | 诊断详情（v2.2，含动作审计） |
| 诊断 | `POST` `/diagnostics/:id/actions/:action` | 自愈动作（v2.2，body `{ idempotencyKey }` 幂等） |
| 管线 | `GET` / `PUT` `/settings/pipeline` | 后处理管线配置（v2.2，默认关闭/N=2） |
| 设置 | `GET` / `PUT` `/settings` | 读取 / 更新全局设置 |
| 设置 | `POST` `/settings/validate-directory` | 校验录像目录 |
| 设置 | `POST` `/settings/test-smtp` | SMTP 连通性测试 |
| 告警 | `GET` `/alerts` | 告警列表（v1.7 起含 `roomId`/`errorCode` 结构化字段） |
| 告警 | `PATCH` `/alerts/:id` | 单条标记已读 |
| 告警 | `POST` `/alerts/read-all` | 全部标记已读 |
| 服务 | `GET` `/service/status` | `{ serviceStatus }`：状态、磁盘、活跃录制数、`setupCompleted` |
| 服务 | `GET` `/service/self-check` | 一键自检（v1.7）：`{ items: [{ key, label, status: ok|fail|warn, detail, fixHint }] }`，逐项=后端/SMTP(dry-run)/平台Cookie/磁盘/目录可写，每项 3s 超时 |

### `ServiceStatus` 结构（v1.1 定稿细化）

```json
{
  "state": "running",
  "version": "0.1.0",
  "uptimeSeconds": 123,
  "disk": { "freeBytes": 123, "totalBytes": 456 },
  "activeRecordings": 1,
  "setupCompleted": true
}
```

`state`：`running | restarting`。offline 不入枚举：由 FE 连接失败自判（fetch/EventSource 断且退避重连耗尽 → "服务已断开"）；收到 `state=restarting` 或 503 → "服务重启中"并按退避重连。SSE `service:status` 的 `data` 即本结构；`uptimeSeconds` 可选。

`disk:space` 的 `data`：`{ directory, freeBytes, totalBytes, low }`（FE 消费 freeBytes/totalBytes，directory/low 附加可忽略）。
| 事件 | `GET` `/events` | SSE 状态/录制/告警推送 |
| 预览 | `WS` `/ws/preview/:roomId` | FLV 预览流转发 |

## SSE（已冻结）

标准帧格式：`event: <名称>` 行 + `data: <JSON>` 行；`data` 不内嵌 `type` 字段，FE 按事件名 `addEventListener`。

事件名（冒号分隔）：`room:updated` / `recording:updated` / `alert:created` / `alert:updated` / `settings:updated` / `service:status` / `disk:space` / `diagnostic:updated`（v2.2，诊断状态流转 open→processing→resolved/expired）；`data` 为相应资源模型或统一错误对象。

## WebSocket 预览（已冻结）

`ws://127.0.0.1:43120/ws/preview/:roomId`，连接后接收 FLV 二进制帧。服务端断开前先发 `{ "type": "stream_end", "reason": "ended|stream_lost" }`（仅 1000/4004 前置），`stream_end` 帧保证先于关闭帧写入（服务端单写队列）。

关闭码 ↔ 错误码映射：

| 关闭码 | 含义 | 错误码 | stream_end 前置 | FE 文案 | 重连 |
| --- | --- | --- | --- | --- | --- |
| `1000` | 正常结束（下播 / stop-recording） | — | `reason=ended` | "本场录制已结束" | 否 |
| `4002` | 握手时 roomId 不存在或 `monitorState ∉ {recording, reconnecting}`，拒绝并关闭 | `PREVIEW_NOT_RECORDING`（retryable=false） | 无 | "当前未在录制，无法预览" | 否 |
| `4003` | 全局预览数已达 2 | `PREVIEW_LIMIT_REACHED`（文案与 HTTP 同源） | 无 | "预览数已达上限（2 路）" | 否 |
| `4004` | 断流重连 3 次（5/15/45s）耗尽，录制标记 failed | `STREAM_DISCONNECTED_RECONNECT_EXHAUSTED` | `reason=stream_lost` | "直播流中断" | 否 |
| `1011` | 服务内部错误（标准码，不占业务码） | — | 无 | 重连失败提示"预览连接异常" | 是 |

FE 规则：以 `stream_end.reason` 为准展示、关闭码仅兜底；仅 1011/网络异常自动重连 ≤3 次（1/3/5s）。~~4005~~ 作废；~~4004=未在录制~~ 作废。

## 统一错误信封（HTTP 非 2xx）

```json
{
  "error": {
    "code": "DISK_SPACE_INSUFFICIENT",
    "message": "录像目录可用空间低于安全阈值",
    "roomId": "room_01J...",
    "recordingId": null,
    "occurredAt": "2026-08-28T01:00:00.000Z",
    "retryable": false,
    "details": { "freeBytes": 123, "thresholdBytes": 456 }
  }
}
```

错误对象始终包含 `code`、`message`、`roomId`、`recordingId`（无关联时 `null`）、`occurredAt`、`retryable`；`retryable` 即 FE"重试"按钮依据。

### 错误码全集（25 码，v2.2）

| 码 | 触发面 | HTTP | retryable | 告警级别 |
| --- | --- | --- | --- | --- |
| `ROOM_LINK_INVALID` | 添加/编辑房间 | 422 | false | — |
| `ROOM_LINK_DUPLICATE` | 添加房间 | 409 | false | — |
| `DIRECTORY_NOT_WRITABLE` | validate-directory / PUT settings | 422 | false | error |
| `DISK_SPACE_INSUFFICIENT` | 调度/手动检测 | 409 | false | error（含邮件） |
| `CONCURRENT_LIMIT_REACHED` | 手动检测；自动调度仅 SSE | 409 | true（下轮重排） | warning |
| `SMTP_SEND_FAILED` | test-smtp；后台通知仅告警 | 502 | true | warning |
| `SERVICE_UNAVAILABLE` | 启停窗口期请求 | 503 | true | — |
| `CONFIG_LOAD_FAILED` | 启动配置加载失败 | 500 | false | error |
| `PLATFORM_ACCESS_RESTRICTED` | 登录/Cookie/私密受限 | — | false | warning |
| `PLATFORM_CHANGED` | 平台接口/反爬变更 | — | false | error |
| `NETWORK_UNAVAILABLE` | 平台请求超时/失败 | — | true | warning |
| `RECORDING_START_FAILED` | 录制器启动失败 | — | true | error（含邮件） |
| `STREAM_DISCONNECTED_RECONNECT_EXHAUSTED` | 重连耗尽；WS 4004 | — | true（指下场直播） | error（含邮件） |
| `RECORDING_FILE_CORRUPTED` | 完成校验失败 | — | false | error |
| `STREAM_FORMAT_CHANGED` | 自动切换格式（服务端自动续录） | — | —（v1.1 勘误：info 级提示码不设重试） | info |
| `QUALITY_DOWNGRADED` | 清晰度降级 | — | — | info |
| `PREVIEW_LIMIT_REACHED` | WS 4003 | — | true（预览释放后可重连） | — |
| `PREVIEW_NOT_RECORDING` | WS 4002 | — | false（不弹重试） | — |
| `RESOURCE_NOT_FOUND`（v1.2 新增） | 按 id 寻址的 HTTP 端点资源不存在（rooms/:id 的 PATCH/DELETE/enable/check/stop-recording、recordings/:id/open、alerts/:id、tags/:id、diagnostics/:id） | 404 | false | — |
| `TAG_INVALID`（v2.2 新增） | 标签创建/编辑/设置非法（重名、超长、颜色非法、超量） | 422 | false | — |
| `SEARCH_QUERY_INVALID`（v2.2 新增） | 搜索参数非法（空查询、超长、非法 type、非法分页） | 422 | false | — |
| `SEARCH_TIMEOUT`（v2.2 新增） | 搜索执行超时 | 504 | true | — |
| `DIAGNOSTIC_ACTION_INVALID`（v2.2 新增） | 诊断动作不支持/缺幂等键 | 422 | false | — |
| `DIAGNOSTIC_CONFLICT`（v2.2 新增） | 诊断项已过期无法执行动作 | 409 | false | — |
| `PIPELINE_CONFIG_INVALID`（v2.2 新增） | 管线配置非法（enabled/verify/segmentSeconds/crf/archiveDirectory/maxConcurrency） | 422 | false | — |

边界（v1.2 明确）：WS 预览握手"房间不存在/未在录制"仍走 4002/`PREVIEW_NOT_RECORDING`（冻结表），HTTP 资源不存在走 `RESOURCE_NOT_FOUND`，两套不混用。`RESOURCE_NOT_FOUND` 的 `details.resource` 放资源类型，message 由服务端给出、FE 直接渲染（兜底文案"资源不存在或已被删除"）。

文案要点：`PLATFORM_CHANGED`＝"平台有变动，等待适配更新"（提示类，不弹重试）；`PREVIEW_NOT_RECORDING`＝"当前未在录制，无法预览"。`DISK_SPACE_LOW` 作废，统一 `DISK_SPACE_INSUFFICIENT`。

错误通道（三通道，同一码全局唯一定义；不设 `service.error` 事件）：请求错误走 HTTP 信封；房间级 → `room:updated.lastError`；会话级 → `recording:updated.failureReason`；服务级异常 → `service:status`（restarting）/ 客户端连接失败自判 offline + `alert:created`。邮件通知仅三类（recording_started / recording_failed / disk 空间不足）；提示类只进告警 `level=info`。

写请求全部经 JSON Schema（Fastify）校验，非法字段直接 `400`。

## 设置（PUT /settings 示例，v1 口径）

```json
{
  "recordingDirectory": "/Users/me/Movies/LiveRecordings",
  "maxConcurrentRecordings": 2,
  "checkIntervalSec": { "default": 60, "bilibili": 60, "douyin": 120 },
  "quality": "original",
  "retry": { "maxAttempts": 3, "delaysSeconds": [5, 15, 45] },
  "diskGuard": { "minFreeBytes": 21474836480, "minFreePercent": 10 },
  "mail": {
    "enabled": true,
    "host": "smtp.example.com",
    "port": 465,
    "secure": true,
    "username": "notice@example.com",
    "password": "***",
    "from": "notice@example.com",
    "recipients": ["me@example.com"]
  }
}
```

- `checkIntervalSec` 为按平台对象 + 全局默认兜底（废弃 `pollIntervalSeconds`）；同平台房间串行检测
- `quality`（original/1080p/720p/360p，默认 original）用户可配，真实降级逻辑阶段 C 生效；recordings 表内部列记实际清晰度，API 不输出（v1.1 勘误补正，commit b90ec4d）
- 通知去重窗口 v1 服务端固定 30 分钟，不暴露到 `/settings`；契约预留可选字段 `dedupeWindowMinutes`（前端不渲染）
- SMTP 密码不回显，`GET /settings` 仅返回 `passwordSet: true|false`（废弃 `passwordConfigured`）；密码经 `SecretStore`（keytar / CI 用 FakeSecretStore）存本机 keychain
- `douyinCookie`（v1.3）：POST/PUT `/settings` 可写（字符串，空串表示清除），经 `SecretStore` 存本机 keychain 不落盘；`GET /settings` 仅返回 `douyinCookie: { hasCookie: true|false }`，永不回显值；抖音房间受限/反爬时按 `PLATFORM_ACCESS_RESTRICTED` 提示，FE 引导去设置页填写

### v1.4 目录选择与配置导入导出

- `GET /settings/browse-directories?path=<绝对路径>` → `{ ok, path, parent, directories: [{ name, path }] }`：目录树浏览（默认用户主目录）；仅接受绝对路径（否则 422 `DIRECTORY_NOT_WRITABLE`）、路径 resolve 归一化防穿越；目录不存在 → 404 `RESOURCE_NOT_FOUND`（`details.resource='directory'`）、无权限 → 422 `DIRECTORY_NOT_WRITABLE`；选择结果复用 `validate-directory` 校验
- `POST /settings/pick-directory` → `{ ok, directory }`：弹出系统原生目录选择器（macOS 访达 osascript / Windows 资源管理器 PowerShell / Linux zenity），取消返回 `directory: null`
- `GET /config/export` → `{ config: { version, exportedAt, settings, rooms, alerts } }`：settings 为视图（`passwordSet`/`hasCookie` 标记，不含任何密钥或 Cookie 值）；rooms/alerts 全量
- `POST /config/import` body `{ config: { settings?, rooms?, alerts? } }` → `{ ok, appliedSettings, importedRooms, skippedRooms, importedAlerts }`：settings 过 `validateSettings`（非法 → 422/500 对应错误码）；rooms 按 `UNIQUE(platform,url)` 去重跳过已存在；alerts 仅导入未解决条目；密码/Cookie 值不导入，导入后提示重新配置

## Mock 约定

前端可用上述样例作为固定 Mock。开发模式 `RECORDING_ADAPTER=fake` 时，`POST /rooms/:id/check` 按可注入假适配器（FakePlatformAdapter / fake-recorder / FakeSecretStore / fake clock）返回状态，不访问平台、不启动外部录制器。

## v5 P0-0 桌面 sidecar 启动契约（BE 先行，task #99）

**启动环境变量（Tauri 壳 spawn sidecar 时注入）**：

- `LIVE_RECORDER_HOST`：环回地址，默认 `127.0.0.1`。
- `LIVE_RECORDER_PORT`：首选端口，默认 43120；占用时依次尝试受控备用列表（43121-43125），最后 OS 分配空闲端口。
- `LIVE_RECORDER_STATE_DIR`：应用私有目录，保存单实例锁与 ready 文件。
- `LIVE_RECORDER_READY_FILE`：受控 ready 文件绝对路径（原子写入）。
- `LIVE_RECORDER_INSTANCE_ID`：本实例 ID；缺省自动生成 `inst_<ulid>`。

**单实例锁**：`<stateDir>/instance.lock` 原子保存 `{ instanceId, pid, version, startedAt }`；启动前校验 PID 存活。已有存活实例 → 启动失败并报 `another live-recorder instance is running (pid=…)`，不覆盖锁；PID 已不存在（过期残留）→ 自动清理后重取。退出时仅删除本实例持有的锁。

**ready 文件**：原子写入（临时文件 + rename）`AppInstance`：

```json
{
  "instanceId": "inst_01H...",
  "pid": 61111,
  "host": "127.0.0.1",
  "port": 43121,
  "baseUrl": "http://127.0.0.1:43121",
  "apiVersion": "v1",
  "startedAt": "2026-08-29T08:38:32.617Z"
}
```

前端/WebView 从该文件读取运行时 base URL，不写死 5173/43120 等端口。退出时删除。

**健康接口**：唯一为既有 `GET /api/v1/health`，扩展实例与端口字段（不新增 `/health` 别名）：

```json
{
  "serviceStatus": {
    "state": "running",
    "version": "0.1.0",
    "uptimeSeconds": 6,
    "setupCompleted": true,
    "ready": true,
    "instanceId": "inst_01H...",
    "apiVersion": "v1",
    "port": 43121,
    "baseUrl": "http://127.0.0.1:43121",
    "startedAt": "2026-08-29T08:38:32.617Z"
  }
}
```

**本机白名单**：Host/Origin 校验随实际端口动态放行（`127.0.0.1:<port>` / `localhost:<port>`），不固定 43120；Tauri WebView origin 与 Vite 代理（5173）兜底保留。

**优雅退出顺序**：停止接收新请求（`app.close`）→ 停止调度器/收束录制与连接（`onClose` 钩子）→ 删除 ready 文件与实例锁。SIGINT/SIGTERM 均走该顺序。

## v5 Phase 0 契约（task #93，2026-08-29 交付）

### `Tag`

```json
{
  "id": "tag_01J...",
  "name": "音乐",
  "color": "#1677ff",
  "createdAt": "2026-08-29T01:00:00.000Z",
  "updatedAt": "2026-08-29T01:00:00.000Z"
}
```

- `POST /tags` body `{ name, color }`：name 1-30 字符唯一（重复→422 `TAG_INVALID`）；color 可选 `#RRGGBB`（非法则回退默认）。201 `{ tag }`。
- `PATCH /tags/:id` body `{ name?, color? }`：部分更新；重名→422；不存在→404。
- `DELETE /tags/:id` → 204（级联删除 room_tags 关联，不影响房间与录制）。
- `PUT /rooms/:id/tags` body `{ tagIds: string[] }`（≤20，自动去重）：覆盖式设置；任一 tag 不存在→404 `RESOURCE_NOT_FOUND`。`{ room }`（含最新 tags）。

### `GET /search`

参数：`q`（必填，1-100 字符）、`type`（room/recording/alert，缺省 all）、`tagId`（逗号分隔）、`from`/`to`（ISO 时间，按资源时间过滤）、`page`/`pageSize`（默认 20，上限 50）。

```json
{
  "query": "主播",
  "type": "all",
  "tagId": null,
  "from": null,
  "to": null,
  "page": 1,
  "pageSize": 20,
  "total": 3,
  "timeout": false,
  "items": [
    { "type": "room", "id": "room_01J...", "title": "主播名", "subtitle": "https://live.bilibili.com/123", "occurredAt": "2026-08-29T01:00:00.000Z", "extra": {} }
  ]
}
```

实现口径：参数化 LIKE + `ESCAPE '\'` 转义特殊字符（`%`/`_`）、分页上限、3s 查询超时兜底（超时置 `timeout:true` 或 504 `SEARCH_TIMEOUT`）。房间可经标签名命中；录制可按 id 精确命中。空 q/非法 type/非法分页→422 `SEARCH_QUERY_INVALID`。

### `GET /stats/recordings`

参数：`from`/`to`（ISO，缺省近 30 天）、`platform`、`tagId`（逗号分隔）、`roomId`；跨度 ≤365 天。

```json
{
  "from": "2026-07-30T01:00:00.000Z",
  "to": "2026-08-29T01:00:00.000Z",
  "totals": { "recordings": 12, "completed": 10, "failed": 2, "durationMs": 3600000, "bytes": 1048576, "successRate": 83 },
  "byDay": [{ "date": "2026-08-27", "recordings": 2, "durationMs": 600000, "bytes": 102400 }],
  "byPlatform": [{ "platform": "bilibili", "recordings": 8, "durationMs": 2400000, "bytes": 800000 }],
  "generatedAt": "2026-08-29T01:00:00.000Z"
}
```

实现口径：服务端聚合 + 5s 短缓存（同参数命中缓存，`generatedAt` 不变）；successRate=completed/(completed+failed)（无终态样本时 100）；非法时间范围/平台→错误信封。

### 诊断与自愈

`Diagnostic`：

```json
{
  "id": "diag_01J...",
  "roomId": null,
  "recordingId": "rec_01J...",
  "code": "RECORDING_START_FAILED",
  "severity": "error",
  "status": "open",
  "suggestion": "重试录制",
  "details": null,
  "occurredAt": "2026-08-29T01:00:00.000Z",
  "resolvedAt": null
}
```

- `status`：`open | processing | resolved | expired`。同一 `recordingId+code` 只允许一个活跃项（单飞）；30 天未处理自动 `expired`（查询时惰性归档）。
- `GET /diagnostics?status&severity&roomId&page&pageSize` → `{ items, total, page, pageSize }`。
- `GET /diagnostics/:id` → `{ diagnostic, actions: [{ id, diagnosticId, action, idempotencyKey, performedAt, result, detail }] }`；不存在→404。
- `POST /diagnostics/:id/actions/:action` body `{ idempotencyKey }`（必填）：动作集按诊断 code 限定（如 `RECORDING_START_FAILED`→`retry`、`PLATFORM_ACCESS_RESTRICTED`→`refresh_cookie`、`DISK_SPACE_INSUFFICIENT`→`cleanup`、`SMTP_SEND_FAILED`→`test_smtp`）。幂等：同 key 重复请求返回既有动作记录，不重复副作用。成功后诊断 `resolved`（`resolvedAt` 记录）；已过期→409 `DIAGNOSTIC_CONFLICT`；不支持动作/缺 key→422 `DIAGNOSTIC_ACTION_INVALID`。SSE `diagnostic:updated` 推送状态流转。

### 后处理管线配置

`GET /settings/pipeline` / `PUT /settings/pipeline`（v2.2，独立于 settings 主对象，部分更新合并）：

```json
{
  "pipeline": {
    "enabled": false,
    "verify": true,
    "segmentSeconds": 0,
    "crf": null,
    "archiveDirectory": "",
    "maxConcurrency": 2
  }
}
```

- `enabled`：总开关（false 时录制完成不进管线，等价 `pipelineStatus=not_required`）。
- `verify`：ffprobe 完整性校验；`segmentSeconds`：切片秒数（0=不切片）；`crf`：可选压缩（null=不压缩，0-51）；`archiveDirectory`：归档目录（空=不归档）；`maxConcurrency`：管线并发（V5 定 N=2，录制主链路优先）。
- 非法组合（enabled 非布尔、maxConcurrency ∉[1,2]、crf ∉[0,51] 等）→422 `PIPELINE_CONFIG_INVALID`。写入后 `settings:updated` SSE 推送。

### Recording processing 态

`state=processing`：录制文件生成后进入后处理管线的中间态（`recording→processing→completed`）。`pipelineStatus` 字段跟踪管线各阶段（`not_required|queued|running|ok|partial|failed`），`metadata` 携带管线写入的真实时长/片段数/清晰度/大小，`coverPath` 为封面帧路径（无封面时媒体封面端点 404 占位）。历史、统计、SSE `recording:updated` 均随 `state` 同步。
