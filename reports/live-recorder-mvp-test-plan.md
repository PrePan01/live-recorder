# Live Recorder MVP 测试计划（验收基线）

> 版本：v1.1 同步稿 · 维护人：@QA · 依据：`docs/product-plan.md`、`docs/backend-technical-plan.md`、`docs/frontend-tech-plan.md`、API 契约 v1.1（评审冻结口径）

## 1. 验收标准（24 条 AC）

### 核心功能（AC#1–AC#12）
| # | 验收标准 | 用例区 |
|---|---|---|
| 1 | 可写目录通过校验，配置重启后仍存在 | TC-SETUP / TC-RESTART |
| 2 | 抖音/B站有效链接可添加；重复或失效链接被拒绝 | TC-ROOM |
| 3 | 房间可编辑、启停、删除；停用后不新建任务 | TC-ROOM |
| 4 | 未开播持续检测，不生成文件和邮件 | TC-DET |
| 5 | 开播同一场只建一条任务；确认写入成功才进录制中；**pending 30 秒超时标记 failed** | TC-DET / TC-REC |
| 6 | 正常结束记录开始/结束时间、路径、大小、状态，可打开目录 | TC-REC |
| 7 | 断流重连按退避恢复或上限后失败；**耗尽后保留已录部分且文件完整可播** | TC-REC-ABN |
| 8 | 服务重启恢复监控、不重复录同一场；**重启期间直播结束：有可读文件→completed，无文件→failed** | TC-RESTART |
| 9 | 目录不可写/空间低于阈值拒绝新任务、记录原因并告警；**存储保护取较大阈值（20GB 与 10% 孰严按孰）** | TC-GUARD |
| 10 | 仅成功开录/最终失败/空间不足发邮件；SMTP 失败不中断录制；重复事件去重（**窗口自首次成功发送起 30min**） | TC-NOTIFY |
| 11 | 超并发上限（默认 2）不启动额外任务，产生可见告警 | TC-GUARD |
| 12 | macOS/Windows 均可配置、重启恢复、打开目录、Web 管理 | TC-CROSS |

### 界面与体验（AC#13–AC#16）
| # | 验收标准 | 用例区 |
|---|---|---|
| 13 | 全局导航顶部信息（服务状态/磁盘/告警数）实时准确；**服务断开明确提示，不显示旧数据** | TC-UI |
| 14 | "立即检测"合理时间内返回，不影响后台调度周期（REST+SSE） | TC-UI |
| 15 | 告警可标记已读（单条+全部），不丢失录制历史失败原因关联 | TC-UI |
| 16 | 测试邮件失败展示可读错误原因，不默认成功 | TC-SETUP |

### 页面观看直播（AC#17–AC#21）
| # | 验收标准 | 用例区 |
|---|---|---|
| 17 | 录制中房间可"观看"页面内实时播放 | TC-PV |
| 18 | 预览延迟 <5s（高负载 2 录+2 预览容忍 ≤10s）；断流自动重连 ≤3 次 | TC-PV |
| 19 | 非录制中房间不显示"观看"按钮 | TC-PV |
| 20 | Chrome/Firefox 可正常观看；Safari 显示兼容性提示（预览不支持） | TC-PV / TC-CROSS |
| 21 | 最多 2 路同时预览，超限提示"预览数已达上限"（HTTP 409 PREVIEW_LIMIT_REACHED / WS 4003） | TC-PV |

### 关闭浏览器（AC#22–AC#23）
| # | 验收标准 | 用例区 |
|---|---|---|
| 22 | 录制中关闭浏览器，服务继续运行、文件持续写入 | TC-BROWSER |
| 23 | 重开浏览器状态与历史正确显示（SSE 重新订阅；服务断开期间崩溃则提示"服务已断开"） | TC-BROWSER |

### 清晰度（AC#24）
| # | 验收标准 | 用例区 |
|---|---|---|
| 24 | 用户可选择录制清晰度（original/1080p/720p/360p，默认 original）；指定清晰度不可用时降级次高并记 `QUALITY_DOWNGRADED`（info 告警） | TC-QUALITY |

## 2. 冻结口径（评审决议基线，验收以此为准）

1. **按平台轮询间隔**：`checkIntervalSec = { default: 60, bilibili: 60, douyin: 120 }`，可配置；非全局 60s。同平台房间串行。
2. **开播检测**：B站公开状态接口；抖音需 Cookie/请求头，支持用户配置 Cookie，过期时提示重新配置（`PLATFORM_ACCESS_RESTRICTED`）。检测失败→记错误→下轮再试，不触发重连。
3. **错误码全集 18 码**（契约 v1.1 为准）：原 16 码 + `PREVIEW_NOT_RECORDING`（WS 4002，retryable=false，FE 文案"当前未在录制，无法预览"）+ `PLATFORM_CHANGED`（平台接口/反爬变更，error 告警，FE 文案"平台有变动，等待适配更新"）。命名统一 `DISK_SPACE_INSUFFICIENT`（废弃 DISK_SPACE_LOW）。**v1.1 勘误**：info 级提示码 `STREAM_FORMAT_CHANGED`/`QUALITY_DOWNGRADED` retryable 统一置 `—`（服务端自动续录/降级，FE 不渲染重试按钮），retryable 断言用例按此口径。**v1.2 提案（B-E5 线程 4699d478，待 PM 并入）**：新增 `RESOURCE_NOT_FOUND`（HTTP 404，retryable=false，details.resource=资源类型，FE 直接渲染 message），适用端点 7 个：PATCH /rooms/:id、PATCH /rooms/:id/enable、DELETE /rooms/:id、POST /rooms/:id/check、POST /rooms/:id/stop-recording、POST /recordings/:id/open、PATCH /alerts/:id；QA 每端点补 1 条 404 断言。注意边界：WS 预览握手房间不存在走 4002/PREVIEW_NOT_RECORDING，HTTP 资源不存在走 RESOURCE_NOT_FOUND，两口径在契约中分开断言。全集 18→19 码。
4. **WS 预览关闭码（冻结，4005 作废）**：1000 正常结束（stream_end reason=ended）；4002 房间不存在/未在录制→PREVIEW_NOT_RECORDING；4003 预览超限→PREVIEW_LIMIT_REACHED；4004 断流重连耗尽（reason=stream_lost）→STREAM_DISCONNECTED_RECONNECT_EXHAUSTED；1011 服务内部错误。FE 以 reason 为准、关闭码兜底；仅 1011/网络异常重连 ≤3 次（1/3/5s）。
5. **同场去重**：roomId + streamSessionId；平台无 session ID 时降级 roomId + 开播时间窗口 ±10 分钟。
6. **流格式变化**：录制器返回 `STREAM_FORMAT_CHANGED` 错误码为准；当前文件标记 completed，新建 Recording 续录，同场多条按 streamSessionId 分组展示。
7. **断流重连**：3 次退避 5/15/45s（可配）；耗尽后标记 failed、保留已录部分、发失败邮件（文件完整性必验）。
8. **通知**：仅 recording_started / recording_failed / disk_space_low 三类邮件；去重键"房间+事件"，窗口自首次成功发送起 30min 固定（v1 不暴露配置）。提示类错误码（QUALITY_DOWNGRADED、STREAM_FORMAT_CHANGED）只进 info 告警。
9. **敏感信息**：SMTP 密码走 SecretStore 接口（keytar 生产实现 / FakeSecretStore 测试与 CI 注入）；GET /settings 不回显密码，仅 `passwordSet` 标记；日志不落敏感信息；服务仅绑定 127.0.0.1:43120。
10. **范围**：P0 无暂停录制、无进程守护/开机自启（P0.5）、无回放页/剪辑/转码；停止当前录制为独立操作（不打断已录文件，正常收尾）。
11. **Settings 断言字段名（契约 v1.1 为准）**：`retry.delaysSeconds=[5,15,45]`、`diskGuard.minFreeBytes=21474836480 / minFreePercent=10`（GB 换算按字节断言）、`mail.recipients` 为数组、`GET /settings` 无 password 字段仅 `passwordSet`；Room 录制完成后 `monitorState` 回 `idle`（`completed` 仅为 Recording 终态）。

## 3. 测试分层与可测性要求

- **单元/集成**：vitest（前后端统一）；所有依赖可注入 fake：PlatformAdapter / RecordingEngine（fake-recorder）/ DiskGuard / Mailer / Clock / SecretStore / Scheduler。时间相关用例（pending 30s、退避、30min 去重）必须用 FakeClock，禁止真实等待。
- **API 契约测试**：18 错误码逐一触发；三通道一致性（HTTP 信封 / SSE `room:updated.lastError` / 告警表）同一码同文案；`lastError`/`failureReason` 断言按结构化对象（`{code,message,occurredAt,retryable,recordingId?}|null`，第 6 项口径），不接收转义字符串。
- **异常恢复矩阵**（阶段 D 重点）：断网、磁盘满/不可写、平台限流/Cookie 过期、录制器启动失败、流格式变化、录制中服务重启、并发/预览超限、SMTP 不可达。
- **跨平台**：macOS/Windows 各完成 AC#12、打开目录、keychain 真机集成（keytar 仅此层验证）。
- **跨浏览器**：Chrome/Firefox 全功能；Safari 预览禁用提示。
- **性能/稳定性**：2 录 + 2 预览资源占用；预览延迟；>1h 预览连接稳定性与内存；>24h 服务常驻。
- **安全（第 8 项）**：外部 Host/Origin 访问拒绝；日志 redact（password/cookie/authorization 不落盘）；validate-directory 路径穿越（`../`）拒绝；`open` 端点仅接受表内 id、拒绝任意路径。

## 4. 阶段准入/准出

| 阶段 | QA 准入条件 | QA 准出 |
|---|---|---|
| B 骨架 | API 契约 v1.1 定稿 + Mock 可注入 | 契约冒烟通过（假平台跑通全链路） |
| C 联调 | B 准出 + 真实适配器可用 | 18 错误码用例全通过；AC#1–12 主路径通过 |
| D 验收 | C 准出 + macOS/Windows 双环境 | 24 条 AC + 异常矩阵 + 跨浏览器全通过，无阻塞缺陷 |

## 5. 阶段 B 出口结果（QA 执行记录 · 2026-08-28）

- **范围**：backend commit 42da368（B-E1~E6）+ docs/api-contract.md v1.2 入库版。
- **测试**：后端全量 vitest 9 文件 49 测试全绿（BE 39 + QA 出口用例 10）。
- **QA 出口用例**（`backend/test/integration/qa-exit.test.ts`）：
  - RESOURCE_NOT_FOUND(404) 全 7 端点断言补齐：PATCH /rooms/:id、PATCH /rooms/:id/enable、DELETE /rooms/:id、POST /rooms/:id/check、POST /rooms/:id/stop-recording、POST /recordings/:id/open、PATCH /alerts/:id；均含 details.resource 与 retryable=false。
  - 错误信封六必填字段（code/message/roomId/recordingId/occurredAt/retryable）与不落敏感信息断言。
  - 安全：validate-directory 拒绝相对/穿越路径（`../`、`relative/path`）→ 422 DIRECTORY_NOT_WRITABLE；非本机 Host 与外部 Origin → 403；open 拒绝非表内 id。
  - 全链路冒烟：PUT settings → POST rooms → POST check（live）→ 录制进入 recording → 落盘 `平台/主播/时间.mkv` → completed，fileSizeBytes>13；磁盘不足阻断新录制并告警。
- **真机冒烟**：`npm run dev` 起 fake 服务，HTTP 实测 health/service-status/rooms/check/recordings 契约一致；录制文件真实写入（1642 字节）；404/403 守卫生效；冒烟后已清理临时数据与录制文件。
- **结论**：阶段 B 准出通过，可进入阶段 C。
