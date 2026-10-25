# YouTube 运行时去重及架构裁剪评估

日期：2026-10-25（Asia/Shanghai）。对象：当前 1.4.0 macOS ARM64 本地产物，yt-dlp 2026.08.19；Apple Silicon 主机。

## 结论

保留全部功能依赖，只删除其他 CPU 架构并合并重复 Python 库，在当前 ARM64 环境下可行。公开直播的两条应用后端流程、原生依赖、签名和 DMG 安装包检查均通过。正式接入必须同步处理软链接复制、签名和完整性校验。

## 实测大小

单位 MiB（1 MiB = 1,048,576 字节）。

| 项目 | 原始 | 优化后 | 减少 |
| --- | ---: | ---: | ---: |
| YouTube 运行时（软链接不重复计入目标文件） | 124.01 | 43.61 | 80.40 |
| DMG | 178.32 | 149.37 | 28.95 |

DMG 使用现有 release/Live Recorder.app 的临时副本，仅替换运行时并重新 ad-hoc 签名，使用 HFS+/UDZO 创建。未实施媒体去重、SQLite 或 youtubei.js 精简；测试包不是正式发布包。正式构建方法、签名和文件系统开销可能带来小幅差异。

## 实验方法

- 在隔离目录复制原始运行时，对 107 个 universal Mach-O 文件执行 lipo -thin arm64 并重新签名。
- 保留 `_internal/Python.framework/Versions/3.14/Python`，另外三个完全相同的 Python 库文件改为指向该文件的包内相对软链接。
- 最终剩余 104 个实际 Mach-O 文件，逐个检查 CPU 为 ARM64，没有 universal 二进制。未删除提取器、Python 模块、网络或加密依赖、CA 证书。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 原始/优化后 yt-dlp 版本、提取器列表、浏览器模拟目标列表对比 | 输出一致 |
| 53 个 Python 标准原生扩展导入 | 两套运行时均通过 |
| SSL 与 CA 证书、curl_cffi、Brotli、zlib、bz2、lzma | 两套运行时均通过 |
| AES 已知向量、RSA 密钥导入导出、SHA256、SQLite 内存数据库、XML | 两套运行时均通过 |
| 原始运行时解析公开直播 | 返回直播状态及 8 个格式 |
| 优化后先预览再录制 | 全链路通过，退出码 0 |
| 优化后不先预览直接录制 | 全链路通过，退出码 0 |
| 完整应用重新签名、严格深度验证 | 通过 |
| 搬移复制后签名与运行时启动 | 通过，软链接仍在包内解析 |
| 创建、只读挂载测试 DMG | 通过 |
| 挂载包签名、运行时启动及软链接解析 | 通过；测试镜像已卸载 |

公开测试链接：`https://www.youtube.com/watch?v=rFZHOHl-L8A`。

应用流程使用随包 Node 和现有 `backend/scripts/youtube-live-smoke.mjs`，创建独立临时数据库及内存密钥存储，不读取用户数据库或已保存授权凭据。覆盖头像/封面、直播预览、加载进度、原生录制、关闭预览后继续录制、重新接入预览、弹幕持久化及媒体时间戳、活动录像定位和标记、停止后恢复预览、历史回放、FFprobe/FFmpeg 解码验证。两轮分别记录 69、71 条弹幕。

这是应用后端 API/WebSocket/媒体流程测试，不是 GUI 自动化。日志中有 youtubei.js 新聊天节点的兼容提示及 TimeoutNaNWarning，但两轮最终全部验收通过；本轮未修改这些逻辑。

## 正式接入的必要调整

1. **保留可搬移的相对链接**：现有 Node `fs.cpSync(..., { recursive: true })` 实测会把相对链接改为指向源目录的绝对路径。相关应用暂存及产物复制需使用 `verbatimSymlinks: true`，并检查其他构建阶段是否解引用链接。测试使用修正后的复制选项已通过。可在 Tauri 生成应用后、最终签名前进行变换，再检查发布包内链接，不能假设 Tauri 资源复制必然保留链接。
2. **完整性校验**：原始缓存通过现有 SHA256 树校验，优化目录按原始树哈希校验则失败，这是预期行为。应继续验证固定的上游压缩包哈希及原始展开树，再加入受控架构变换和目标产物校验，不能关闭验证或无条件信任重写的 manifest。
3. **签名顺序**：裁剪后二进制重新签名，去重后封印完整应用，最终签名之后不再修改资源。
4. **按打包目标处理**：ARM64 包保留 ARM64；Intel 包保留 x86_64；通用包保留两者。Windows/Linux 不使用 macOS 的 lipo 规则。

## 验证范围限制

- 未覆盖登录 Cookie、会员限定、年龄或地区限制直播、不同账号授权。
- 未覆盖 Intel 主机、其他 macOS 版本、Developer ID 公证和 Gatekeeper 分发验证；本次采用 ad-hoc 签名。
- 未覆盖所有提取器、编码格式或长时间录制。
- 未接入正式构建，未修改生产代码和原始 release/ 产物。

## 原始证据

临时目录：`/private/tmp/lr-youtube-runtime-audit-2jgfpur_`。

包含 results.json、native-probes.json、application-smoke.log、record-first-smoke.log、packaging-probes.json、dmg-probes.json 和测试 DMG。临时目录不保证长期保留。
