# Live Recorder Backend

本地常驻录制服务：监控 B站/抖音/小红书直播间开播，自动录制到用户目录，邮件通知，Web 管理界面走 localhost API。

## 快速开始

```bash
cd backend
npm install
npm run dev        # tsx watch，监听 http://127.0.0.1:43120
npm run build      # tsc 编译到 dist/
npm test           # vitest（unit + integration）
```

## 当前状态（阶段 B 开发中）

| 任务 | 状态 |
| --- | --- |
| B-E1 项目骨架 | 已完成（Fastify 5 + TS 严格模式 + health 端点 + 配置/错误类型） |
| B-E2~B-E7 数据层/fake/全端点/SSE/WS/调度/测试 | 进行中 |

- 契约：`docs/api-contract.md`（v1.1）
- 技术方案：`docs/backend-technical-plan.md`（评审定稿版）
- 环境变量：`RECORDING_ADAPTER=fake|real`（阶段 B 默认 fake）

## 目录结构

`src/` 按 `docs/backend-technical-plan.md` §2 组织：config / db / api / core / platform / recorder / storage / mail / security / types / utils。

## 消息通知

设置页通过统一事件表格配置八类事件的桌面、邮件与 QQ 投递渠道，连接参数与测试入口分别展示在下方；直播间开播提醒开关只控制该房间的开播订阅。
QQ 通过 [Qmsg酱](https://qmsg.zendee.cn/docs) v3 接口推送到 Key 已绑定的 QQ 单聊，首次启用前需要在控制台添加机器人并完成绑定。QQ 渠道默认关闭，事件默认全部选中。

- `GET /api/v1/settings/qmsg` 返回 `{ qmsg: { enabled, keySet } }`。
- `PUT /api/v1/settings/qmsg` 支持 `{ enabled?, key?, clearKey? }`；替换 Key 与 `clearKey: true` 不可同时提交，留空输入不修改已有凭据。Key 只存 SecretStore，配置导出不含 Key。
- `POST /api/v1/settings/qmsg/test` 使用已保存 Key；成功表示提交成功，不代表 QQ 已送达。队列忙时请稍后测试，测试不受渠道启用开关影响。
- `GET/PUT /api/v1/settings/notifications` 的 `desktop`、`email`、`qq` 分别保存事件偏好，旧版配置自动补齐缺省值。

事件与测试共用 QQ 发送队列，同一 Key 至少间隔 5 秒，请求最多等待 10 秒，队列容量 100 条。发送结果不明时不自动重试；消息中的链接、IPv4 地址与连续数字在提交前省略。开发 fake 模式只模拟提交，不发送真实 QQ 消息。
