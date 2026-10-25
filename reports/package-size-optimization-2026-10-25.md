# 安装包体积优化实施与验证

日期：2026-10-25。当前包版本 1.4.0，macOS ARM64。本轮实现未发布、上传或修改版本号。

## 产物

- DMG：178.32 → 107.94 MiB，减少 70.38 MiB（39.5%）。
- `.app` 普通文件数据总量：426.32 → 252.59 MiB，减少 40.8%。这里不把软链接目标重复计入；磁盘分配占用受文件系统块大小影响。
- 本地产物：`release/Live Recorder_1.4.0_aarch64.dmg` 和 `release/Live Recorder.app`。

## 实现

- 在 `frontend/src-tauri/.bundle/backend` 建立独立副本，离线 prune 生产依赖，不执行依赖安装脚本。构建不再裁剪开发目录，也不必重新 npm ci 恢复开发依赖。
- 媒体二进制只保留在 Resources/ffmpeg；依赖包中的副本移除，保留包元数据及许可证。装机验证清空 PATH，确认使用安装包自带 FFmpeg/FFprobe，且二者可以执行。
- youtubei.js 保留全部 Node 运行代码与 protobuf 数据，仅移除其他平台 bundle 和类型/源码映射文件；其他依赖只移除已知的类型、JS 映射及测试目录，保留 JS、数据、许可证。
- SQLite 保留目标平台/CPU 的预编译模块，移除其他平台模块与编译源码/中间产物。预编译模块缺失或不符合固定版本布局时使构建失败。测试覆盖 macOS/Windows ARM64 与 x64，以及 Linux glibc/musl 的目标选择逻辑。
- YouTube 下载缓存继续按原始上游 SHA256 和完整展开树校验。仅在 Tauri 生成应用之后，对应用内的 universal Mach-O 保留当前架构，再重新签名。三个重复 Python 库改为包内相对软链接，不删除功能依赖。
- 保留副本复制过程中的相对软链接，最终封印完整应用。生成独立于安装包的构建端哈希 checkpoint，装机挂载后以该 checkpoint 校验实际内容，防止仅修改安装包自带 manifest 绕过校验。
- 开发配置明确关闭发布资源映射，继续使用开发后端，避免依赖打包暂存目录。
- 所有额外依赖/哈希检查仅在构建或装机验收时运行，没有增加正常应用启动路径的校验、解压或网络请求。

## 验证

- `npm --prefix backend run build`：通过。
- `npm --prefix backend test`：115 个文件、1,259 项测试全部通过。首次沙箱运行因本地监听被禁止出现 EPERM；允许测试端口后完整重跑通过，没有调整业务代码来规避测试。
- `node --test scripts/*.test.mjs`：61 项全部通过，包括新增目标模块选择、缺失模块阻断、Mach-O 识别、外部哈希 checkpoint 和软链接搬移测试。
- `npm run package`：完整前端/Rust 构建、DMG 生成、挂载、严格深度签名、随包运行时与启动校验全部通过。
- 安装包启动测试覆盖端口冲突/OS 分配端口、异常退出恢复、重启、中文路径、不可用代理和生产模式。
- 使用最终 `.app` 自带 Node 和后端脚本、精简后的 node_modules 与 YouTube 运行时，真实运行公开直播两条路径：先预览后录制，以及不预览直接录制。预览、精彩片段缓存与导出、持续录制、预览重连、弹幕、定位和标记、停止后恢复预览、历史回放和媒体解码检查通过。两轮分别保存 77、73 条弹幕。
- 原始及最终随包运行时均通过 53 个 Python 原生扩展导入，以及 SSL/CA、curl_cffi、Brotli、zlib、bz2、lzma、AES、RSA、SHA256、SQLite、XML 检查。
- 最终应用再次执行优化入口时验证 checkpoint 后直接返回，不修改文件，确认重复执行安全。
- 原始和最终包的业务 dist/*.js 全部相同，Node 和保留的 SQLite 原生模块二进制完全相同。
- 开发目录的完整依赖仍保留；`git diff --check` 通过。

## 性能

同机、相同随包 Node。原始/优化包交错运行，每包 2 次预热后取 15 次独立进程样本。启动计时包含模块导入、内存数据库迁移、API 初始化和 health；SQLite 测量 10 万次相同参数化查询；yt-dlp 测量本地 --version，无外部网络。

| 指标 | 原包中位数 / P95 | 优化后中位数 / P95 |
| --- | ---: | ---: |
| 后端初始化到 health | 92.58 / 95.08 ms | 92.91 / 95.12 ms |
| 后端测试进程完整耗时 | 133.11 / 135.72 ms | 131.82 / 135.88 ms |
| SQLite 10 万次查询 | 13.65 / 14.90 ms | 14.31 / 14.61 ms |
| yt-dlp 启动到版本返回 | 168.22 / 172.50 ms | 167.87 / 172.46 ms |
| 后端测试进程 RSS | 93.56 / 96.50 MiB | 96.34 / 96.47 MiB |

本轮短时测量未发现明显性能退化；SQLite 中位数相差 0.66 ms、P95 略降，Node 和 SQLite 二进制未变化。这里不是断电冷启动、长时间录制或全部硬件的性能保证。原始样本见同目录 `package-size-optimization-performance-2026-10-25.json`。

## 范围与限制

- 当前真实构建和运行验收是 macOS ARM64。Windows/Intel 的目标选择逻辑有自动化测试，仍需对应平台 CI 的原生构建与装机校验。
- 未覆盖登录 Cookie、会员/年龄/地区限制直播，以及 Developer ID 公证；当前项目沿用 ad-hoc 签名。
- 直播测试使用独立临时数据库和内存密钥存储，不读取用户已保存凭据。测试日志中的 youtubei.js 新节点兼容提示没有导致验收失败；本轮未修改聊天业务逻辑。
- 旧包备份保留于构建时的隔离临时目录，原始缓存也保留；临时文件不保证长期保存。

## 构建与日志

本轮构建使用 `LR_SKIP_BACKEND_BUILD=1`（已先完成 backend build）以及 `LR_NODE_PATH` 指向旧包的同一 Node，以避免运行时版本差异干扰对比。

日志：`/tmp/lr-optimized-package.log`、`/tmp/lr-backend-tests.log`、`/tmp/lr-optimized-live-preview.log`、`/tmp/lr-optimized-live-direct.log`。日志位于临时目录。

## 二次平台兼容性复查

- 复查工作区全部代码差异，未发现破坏现有 macOS ARM64 / Windows x64 原生打包路径的问题。
- 核对 Tauri 的配置合并与资源目录映射实现：公共 backend 映射与平台资源合并，Windows 的 node.exe、WebView2Loader.dll、yt-dlp.exe、ffmpeg 映射保留，后端相对目录仍为 backend/dist 与 backend/node_modules。
- Windows 按 win32-x64 选择 SQLite；macOS 架构裁剪和 Python 软链接仅在 macOS DMG 阶段执行，不影响 NSIS。npm.cmd 使用 Windows shell 执行，依赖暂存的 cwd 通过子进程参数传递。
- 新增真实 npm prune 暂存测试，覆盖带空格/中文路径、开发依赖不被删除及重复构建。与原有针对性测试合计 13 项，在当前 macOS 全部通过。
- 将上述测试加入 macos-15 / windows-latest 原生 CI 矩阵，补足 Windows 上实际复制与 npm.cmd 行为的验证。该 CI 尚未由本地修改触发，不能表述为 Windows 原生验收已通过。
- 重新检查当前最终 macOS 包的严格深度签名、SQLite/Keytar 与精简依赖加载、清空 PATH 后的内置 FFmpeg/FFprobe，以及外部构建 checkpoint 对 YouTube 运行时的完整性验证，全部通过。
- 本次二次复查没有修改生产实现，仅补充测试和 CI；无需重打已经通过检查的本地安装包。Intel/macOS 通用包仍不在本次实际构建范围内。
