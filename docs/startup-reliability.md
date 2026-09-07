# 启动可靠性排查与验证

## 已复现的根因

2026-09-07 本机安装客户端的后台 Node 多次原生崩溃。系统报告中的进程为
`Live Recorder.app/Contents/Resources/node`，栈包含 `Statement::~Statement()` →
`node::RemoveEnvironmentCleanupHook` → assertion failure，进程以 SIGABRT 退出。
安装包使用 Node 24.20.0、better-sqlite3 11.10.0。构造真实数据库服务并编译
Fastify 路由即可复现；仅 require 模块或 select 1 的简单探测无法捕获这个问题。

`backend/scripts/check-runtime.mjs` 在旧安装包后端上复现退出码 134，换成
better-sqlite3 13.0.3 后，在同一 Node 24.20.0 上完成 5 轮迁移、查询、路由编译、
健康请求和 GC。13.x 使用稳定 Node-API，脱离旧 V8 ObjectWrap 生命周期接口。
参考：https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0

此前后端 stdout/stderr 都丢弃，诊断又把原始错误覆盖成通用“安全重试”，
因此原生崩溃被误表现为健康检查超时。旧的 Windows HOME 依赖是另一独立问题。

## 启动管理

- 安装包使用自己的 backend/Node 资源；开发目录只作为 debug 回退。
- start/restart/stop 共用生命周期互斥；重试连接不停止仍在运行的进程。
- 轮询同时检查真实进程退出与健康身份，早退立即输出退出码/信号和日志。
- 仅确认进程退出后自动恢复一次；观察超时不触发杀进程或创建第二实例。
- 状态目录日志为 backend.log（轮转 backend.previous.log），错误原文保留到诊断页。
- Windows 使用真实进程存活查询；残留锁 PID 还需验证可执行文件归属才能终止。
- ready 文件需与 health 的 instanceId、port、apiVersion、startedAt 一致。
- 状态、健康及 WebSocket 使用实际动态端口；HTTP 健康检查不使用系统代理或重定向。
- SQLite OS 租约互斥取代 JSON 的先读后写锁；进程崩溃后锁自动释放，兼容旧版本存活锁。
- 直接 bind 端口并处理冲突，最后使用 port 0 获取系统端口，ready 写入真实监听地址。
- 初始化失败关闭 DB/监听器并释放租约；重复 close 共享同一退出 Promise。
- 遗留录像先释放并发槽，外接盘/网络盘文件核对在后台执行；磁盘检查异步限时。
- 前端显示真实阶段，慢启动提示继续等待；真实失败提供“重试连接”和“重启服务”。
- 第二次打开应用仅唤醒主窗口；事件连接在实例就绪后建立，旧端口响应不能覆盖新实例状态。

## 验证门禁

- `npm --prefix backend test`：服务接口、录制、迁移、恢复、端口、实例互斥。
- `npm --prefix frontend test`：断网状态保留、慢启动不重复创建进程、迟到结果、诊断保留。
- `cargo test --manifest-path frontend/src-tauri/Cargo.toml --lib`：真实 Node 子进程启动、
  并发启动复用、重启更换 PID、早退错误、过期身份拒绝、进程归属和目录解析。
- `node --expose-gc backend/scripts/check-runtime.mjs`：原生依赖与真实路由编译压力。
- `node backend/scripts/check-startup.mjs`：真实 sidecar 在中文/空格路径中，经过
  端口冲突、不可用代理、强杀后恢复、再次启动；每次请求 health/status 25 次。
- `node scripts/check-installation.mjs`：macOS .app 资源与 Windows MSI 行政解包后的
  实际 Node/backend 重跑以上检查，防止源码通过而安装包仍含旧/不兼容模块。

CI 在 macOS 和 Windows 上执行门禁后才上传安装包。构建 Node 固定为已验证的
24.20.0，变更运行时必须重新经过原生压力和安装包门禁。

权限不足、文件被删除、系统资源耗尽或用户数据损坏时，不能承诺进程必定成功启动；
这些情况必须及时报告具体路径/错误，不通过删除用户数据、误杀其他进程或无限重试掩盖。
