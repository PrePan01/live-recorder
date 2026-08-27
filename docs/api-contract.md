# Live Recorder 本地服务 API 契约 v1.1

版本：v1.1（2026-08-28 定稿，评审 10 项互确认 + PrePan 审核通过）
维护：PM 牵头；实现蓝本随首个后端提交入 `docs/`。变更一律走版本升级（→v1.2）并经 FE/QA 互确认。

Base URL：`http://127.0.0.1:43120/api/v1`。响应均为 JSON，字段一律 camelCase。
服务仅绑定 `127.0.0.1`；Host/Origin 白名单校验（dev 追加 `http://localhost:5173`，可配置）。

## 1. 资源模型

### Room

```json
{
  "id": "room_01J...",
  "platform": "bilibili",
  "url": "https://live.bilibili.com/123",
  "displayName": "主播名",
  "enabled": true,
  "monitorState": "idle",
  "lastCheckedAt": "2026-08-28T01:00:00.000Z",
  "lastError": null,
  "createdAt": "2026-08-28T01:00:00.000Z",
  "updatedAt": "2026-08-28T01:00:00.000Z"
}
```

- `monitorState`：`idle | checking | recording | reconnecting | completed | failed | disabled`
- `lastError`：结构化对象 `ErrorObject | null`（不返回转义字符串）

### Recording

```json
{
  "id": "rec_01J...",
  "roomId": "room_01J...",
  "platform": "bilibili",
  "streamSessionId": "sess_123",
  "streamTitle": "直播标题",
  "state": "recording",
  "startedAt": "2026-08-28T01:00:00.000Z",
  "endedAt": null,
  "filePath": "/Users/me/Movies/LiveRecordings/bilibili/主播名/2026-08-28_010000.mkv",
  "fileSizeBytes": 0,
  "failureReason": null,
  "retryCount": 0,
  "createdAt": "2026-08-28T01:00:00.000Z"
}
```

- `state`：`pending | recording | reconnecting | completed | failed`
- `failureReason`：`ErrorObject | null`
- `quality`、`schema_version`、告警 `resolved` 内部字段暂不暴露（需暴露走 v1.2）

## 2. REST 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 服务状态与版本 |
| GET | `/rooms` | `{ rooms }` |
| POST | `/rooms` | 201 + `{ room }`；无效链接 `422 ROOM_LINK_INVALID`；重复 `409 ROOM_LINK_DUPLICATE` |
| PATCH | `/rooms/:id` | `{ room }` |
| PATCH | `/rooms/:id/enable` | body `{ enabled: boolean }` → `{ room }` |
| DELETE | `/rooms/:id` | 204 无 body |
| POST | `/rooms/:id/check` | 立即检测 → `{ ok: true }` |
| POST | `/rooms/:id/stop-recording` | 手动停止 → `{ ok: true }` |
| GET | `/recordings` | `{ items, total, page, pageSize }`；参数 `page/pageSize/roomId/state/sessionId/groupBy`，默认 `startedAt` 倒序，pageSize 默认 20 上限 100 |
| POST | `/recordings/:id/open` | 打开所在目录（仅接受表内 id）→ `{ ok: true }` |
| GET | `/settings` | `{ settings }`（`SettingsView`，含 `passwordSet`） |
| PUT | `/settings` | `{ settings }` |
| POST | `/settings/validate-directory` | `{ ok: true }` 或 `422 DIRECTORY_NOT_WRITABLE` |
| POST | `/settings/test-smtp` | `{ ok: true }` 或 `502 SMTP_SEND_FAILED` |
| GET | `/alerts` | `{ alerts }` |
| PATCH | `/alerts/:id` | 标记已读 → `{ alert }` |
| POST | `/alerts/read-all` | `{ ok: true }` |
| GET | `/service/status` | `{ serviceStatus }`：state、磁盘、活跃录制数、`setupCompleted` |

### Settings 结构（v1.1）

```json
{
  "recordingDirectory": "/Users/me/Movies/LiveRecordings",
  "maxConcurrentRecordings": 2,
  "checkIntervalSec": { "default": 60, "bilibili": 60, "douyin": 120 },
  "retry": { "maxAttempts": 3, "delaysSeconds": [5, 15, 45] },
  "diskGuard": { "minFreeBytes": 21474836480, "minFreePercent": 10 },
  "mail": {
    "enabled": true, "host": "smtp.example.com", "port": 465, "secure": true,
    "username": "notice@example.com", "from": "notice@example.com",
    "recipients": ["me@example.com"], "passwordSet": true
  }
}
```

- 密码只写不读（PUT 接收 → SecretStore；GET 仅 `passwordSet` 布尔）
- 邮件去重窗口 v1 固定 30 分钟，不暴露字段
- 旧字段 `pollIntervalSeconds`、`DISK_SPACE_LOW` 示例作废

## 3. SSE

`GET /api/v1/events`，标准帧：`event: <名>` 行 + `data: <JSON>` 行，data 不内嵌 type。
事件（7 个）：`room:updated`、`recording:updated`、`alert:created`、`alert:updated`、`settings:updated`、`service:status`、`disk:space`。
`data` 为对应资源模型或 `ErrorObject`。不设 `service.error` 事件。

## 4. WebSocket 预览

`ws://127.0.0.1:43120/ws/preview/:roomId`，接收 FLV 二进制帧。
服务端在正常结束/断流场景先下发 `{ "type": "stream_end", "reason": "ended" | "stream_lost" }` 文本帧，再关闭。

| 关闭码 | 含义 | stream_end 前置 | 对应错误码 |
| --- | --- | --- | --- |
| 1000 | 正常结束 | `ended` | — |
| 4002 | 房间不存在或未在录制 | — | `PREVIEW_NOT_RECORDING`（retryable=false） |
| 4003 | 预览并发超限（全局 2 路） | — | `PREVIEW_LIMIT_REACHED` |
| 4004 | 断流且重连耗尽 | `stream_lost` | `STREAM_DISCONNECTED_RECONNECT_EXHAUSTED` |
| 1011 | 服务内部错误 | — | —（FE 自动重连 ≤3 次，1/3/5s） |

重连规则：仅 1011/网络异常重连；4002/4003/4004 不重连；FE 以 `reason` 为准、关闭码兜底。

## 5. 错误契约

统一信封（HTTP 非 2xx）：

```json
{ "error": { "code": "...", "message": "...", "roomId": null, "recordingId": null, "occurredAt": "...", "retryable": false } }
```

错误码 18 个：`ROOM_LINK_INVALID`(422,false)、`ROOM_LINK_DUPLICATE`(409,false)、`PLATFORM_ACCESS_RESTRICTED`(运行时,false)、`PLATFORM_CHANGED`(运行时,false)、`DIRECTORY_NOT_WRITABLE`(422,false)、`DISK_SPACE_INSUFFICIENT`(409,false)、`CONCURRENT_LIMIT_REACHED`(409,true)、`RECORDING_START_FAILED`(运行时,true)、`STREAM_DISCONNECTED_RECONNECT_EXHAUSTED`(运行时,true)、`SMTP_SEND_FAILED`(502,true)、`SERVICE_UNAVAILABLE`(503,true)、`NETWORK_UNAVAILABLE`(运行时,true)、`RECORDING_FILE_CORRUPTED`(运行时,false)、`CONFIG_LOAD_FAILED`(500,false)、`STREAM_FORMAT_CHANGED`(运行时,—)、`PREVIEW_LIMIT_REACHED`(WS 4003,true)、`PREVIEW_NOT_RECORDING`(WS 4002,false)、`QUALITY_DOWNGRADED`(运行时,—)。

- 运行时错误三通道：`room:updated.lastError`、`recording:updated.failureReason`、`alert:created`；服务级异常 = `service:status`(offline/restarting) + `alert:created`
- info 级提示码（`STREAM_FORMAT_CHANGED`、`QUALITY_DOWNGRADED`）retryable 为 `—`，FE 不渲染重试按钮
- 邮件通知三类：`recording_started` / `recording_failed` / `disk_space_low`

## 6. Mock / 测试开关

- `RECORDING_ADAPTER=fake`：不触网、不启动真实录制，`POST /rooms/:id/check` 走可编程假适配器；fake 流输出最小可播放 FLV
- 真实平台/E2E 用例标记 `@live`，默认 CI 不执行
