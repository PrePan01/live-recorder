import { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Col, Form, Input, InputNumber, List, Row, Select, Space, Switch, Tag, Typography } from 'antd';
import { DownloadOutlined, UploadOutlined, CheckCircleOutlined, SyncOutlined } from '@ant-design/icons';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAlertStore } from '../../stores/alertStore';
import { validateDirectory, testSmtp } from '../../api/settings';
import { exportConfig, importConfig } from '../../api/config';
import { fetchSelfCheck, type SelfCheckItem, type SelfCheckStatus } from '../../api/service';
import DirectoryPicker from '../../components/DirectoryPicker';
import { describeError } from '../../utils/errorMap';
import { ApiError } from '../../types/error';
import { formatTime } from '../../utils/format';
import type { SettingsInput } from '../../types/settings';

const LEVEL_COLOR: Record<string, string> = { info: 'blue', warning: 'orange', error: 'red' };
const CHECK_COLOR: Record<SelfCheckStatus, string> = { ok: 'success', fail: 'error', warn: 'warning', pending: 'default' };
const CHECK_TEXT: Record<SelfCheckStatus, string> = { ok: '正常', fail: '异常', warn: '警告', pending: '检测中' };

export default function SettingsPage() {
  const { message } = App.useApp();
  const { settings, load, save } = useSettingsStore();
  const { alerts, fetchAlerts, markRead, markAllRead, retryFailure, retryingId } = useAlertStore();
  const [form] = Form.useForm();
  const [dirMsg, setDirMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [clearCookie, setClearCookie] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [checks, setChecks] = useState<SelfCheckItem[] | null>(null);
  const [checking, setChecking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void load();
    void fetchAlerts();
  }, [load, fetchAlerts]);

  useEffect(() => {
    if (settings) {
      form.setFieldsValue({
        recordingDirectory: settings.recordingDirectory,
        maxConcurrentRecordings: settings.maxConcurrentRecordings,
        checkIntervalSec: { ...settings.checkIntervalSec },
        quality: settings.quality,
        douyinCookie: '',
        mail: { ...settings.mail, recipients: settings.mail.recipients.join(', '), password: '' },
      });
    }
  }, [settings, form]);

  const checkDir = async () => {
    const dir = form.getFieldValue('recordingDirectory') as string;
    if (!dir) return;
    try {
      await validateDirectory(dir);
      setDirMsg({ ok: true, text: '目录可写' });
    } catch (e) {
      setDirMsg({ ok: false, text: e instanceof ApiError ? describeError(e.code, e.message) : '校验失败' });
    }
  };

  const runSelfCheck = async () => {
    setChecking(true);
    setChecks(null);
    try {
      setChecks(await fetchSelfCheck());
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '自检失败');
    } finally {
      setChecking(false);
    }
  };

  const persist = async (values: SettingsInput) => {
    const { mail, douyinCookie, ...rest } = values as SettingsInput & {
      mail?: Record<string, unknown> & { recipients?: string; password?: string };
      douyinCookie?: string;
    };
    try {
      await save({
        ...rest,
        ...(clearCookie
          ? { douyinCookie: '' }
          : typeof douyinCookie === 'string' && douyinCookie.length > 0
            ? { douyinCookie }
            : {}),
        mail: mail
          ? {
              ...mail,
              recipients: String(mail.recipients ?? '')
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean),
              password: mail.password || undefined,
            }
          : undefined,
      });
      setClearCookie(false);
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '保存失败');
    }
  };

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onValuesChange = (_changed: unknown, all: SettingsInput) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void persist(all), 500);
  };

  const onExport = async () => {
    setExporting(true);
    try {
      const config = await exportConfig();
      const blob = new Blob([JSON.stringify({ config }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `live-recorder-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('配置已导出（密码/Cookie 不含值，导入后需重配）');
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const onImportFile = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { config?: unknown };
      if (!parsed.config) throw new Error('bad format');
      const result = await importConfig(parsed.config as never);
      message.success(
        `导入完成：设置${result.appliedSettings ? '已应用' : '未变更'}，房间新增 ${result.importedRooms} 个、跳过 ${result.skippedRooms} 个，告警 ${result.importedAlerts} 条`,
      );
      await load();
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '导入失败：文件格式或内容非法');
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Row gutter={16}>
      <Col xs={24} lg={14}>
        <Card
          title="服务设置"
          extra={
            <Space>
              <Button size="small" icon={<DownloadOutlined />} loading={exporting} onClick={() => void onExport()}>
                导出配置
              </Button>
              <Button size="small" icon={<UploadOutlined />} loading={importing} onClick={() => fileRef.current?.click()}>
                导入配置
              </Button>
            </Space>
          }
        >
          <Form form={form} layout="vertical" onValuesChange={onValuesChange} disabled={!settings}>
            <Form.Item label="保存目录">
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item name="recordingDirectory" noStyle rules={[{ required: true, message: '必填' }]}>
                  <Input />
                </Form.Item>
                <Button onClick={() => setPickerOpen(true)}>浏览…</Button>
                <Button onClick={() => void checkDir()}>校验</Button>
              </Space.Compact>
            </Form.Item>
            {dirMsg && (
              <Typography.Paragraph type={dirMsg.ok ? 'success' : 'danger'}>{dirMsg.text}</Typography.Paragraph>
            )}
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item label="最大并发" name="maxConcurrentRecordings" rules={[{ required: true }]}>
                  <InputNumber min={1} max={8} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="默认清晰度" name="quality">
                  <Select
                    options={[
                      { value: 'original', label: '原画' },
                      { value: '1080p', label: '1080p' },
                      { value: '720p', label: '720p' },
                      { value: '360p', label: '360p' },
                    ]}
                  />
                </Form.Item>
              </Col>
            </Row>
            <Typography.Title level={5}>检测间隔（秒，按平台）</Typography.Title>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item label="全局默认" name={['checkIntervalSec', 'default']} rules={[{ required: true }]}>
                  <InputNumber min={10} max={3600} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="B站" name={['checkIntervalSec', 'bilibili']} rules={[{ required: true }]}>
                  <InputNumber min={10} max={3600} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="抖音" name={['checkIntervalSec', 'douyin']} rules={[{ required: true }]}>
                  <InputNumber min={10} max={3600} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            </Row>
            <Typography.Title level={5}>断线重连策略</Typography.Title>
            <Typography.Paragraph type="secondary">退避间隔 5s / 15s / 45s，共 3 次（服务端固定，不可配）</Typography.Paragraph>
            <Typography.Title level={5}>抖音 Cookie</Typography.Title>
            <Typography.Paragraph type="secondary">
              部分抖音直播间需登录 Cookie 才能取流。需要 douyin.com 的完整 Cookie 字符串（分号分隔，含
              sessionid/ttwid/__ac_signature 等全部字段）。获取方式（已登录抖音时）：F12 打开开发者工具 →
              Console 控制台 → 输入 <Typography.Text code>copy(document.cookie)</Typography.Text> 回车 → 已自动复制到剪贴板
              → 粘贴到下方输入框。也可在 Network 面板任意 douyin.com 请求的 Request Headers 中复制 Cookie
              整段。Cookie 仅存本机钥匙串，不会显示或上传。
            </Typography.Paragraph>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item
                  label="抖音 Cookie"
                  name="douyinCookie"
                  extra={settings?.douyinCookie.hasCookie ? '已保存，留空则不修改' : undefined}
                >
                  <Input.Password
                    placeholder={settings?.douyinCookie.hasCookie ? '••••••' : '输入抖音 Cookie（可选）'}
                    autoComplete="new-password"
                  />
                </Form.Item>
              </Col>
              <Col span={12} style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 24 }}>
                <Button
                  disabled={!settings?.douyinCookie.hasCookie}
                  onClick={() => {
                    form.setFieldValue('douyinCookie', '');
                    setClearCookie(true);
                  }}
                >
                  清除已存 Cookie
                </Button>
              </Col>
            </Row>
            <Typography.Title level={5}>SMTP 邮件告警</Typography.Title>
            <Row gutter={16}>
              <Col span={12}>
                <Form.Item label="服务器" name={['mail', 'host']}>
                  <Input placeholder="smtp.example.com" />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item label="端口" name={['mail', 'port']}>
                  <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item label="TLS" name={['mail', 'secure']} valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="用户名" name={['mail', 'username']}>
                  <Input />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="发件地址" name={['mail', 'from']}>
                  <Input />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="收件地址（逗号分隔）" name={['mail', 'recipients']}>
                  <Input />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="密码"
                  name={['mail', 'password']}
                  extra={settings?.mail.passwordSet ? '已保存，留空则不修改' : undefined}
                >
                  <Input.Password
                    placeholder={settings?.mail.passwordSet ? '••••••' : '输入 SMTP 密码'}
                    autoComplete="new-password"
                  />
                </Form.Item>
              </Col>
              <Col span={12} style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 24 }}>
                <Button
                  onClick={() =>
                    testSmtp()
                      .then(() => message.success('测试邮件已发送'))
                      .catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '发送失败'))
                  }
                >
                  测试发送
                </Button>
              </Col>
            </Row>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              设置改动自动保存（500ms 防抖），无需手动保存。
            </Typography.Paragraph>
          </Form>
          <DirectoryPicker
            open={pickerOpen}
            initialPath={settings?.recordingDirectory}
            onClose={() => setPickerOpen(false)}
            onPick={(dir) => {
              form.setFieldValue('recordingDirectory', dir);
              message.success('目录已选择，点击保存生效');
            }}
          />
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onImportFile(f);
            }}
          />
        </Card>
      </Col>
      <Col xs={24} lg={10}>
        <Card
          title="一键自检"
          extra={
            <Button size="small" icon={<SyncOutlined />} loading={checking} onClick={() => void runSelfCheck()}>
              {checks ? '重新检测' : '开始检测'}
            </Button>
          }
        >
          {checks === null ? (
            <Typography.Paragraph type="secondary">
              检测环境健康：后端可达、平台 Cookie、SMTP、磁盘空间、目录可写。
            </Typography.Paragraph>
          ) : (
            <List
              size="small"
              dataSource={checks}
              locale={{ emptyText: '无检测项' }}
              renderItem={(c) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space>
                        {c.status === 'ok' ? (
                          <CheckCircleOutlined style={{ color: '#52c41a' }} />
                        ) : (
                          <Tag color={CHECK_COLOR[c.status]}>{CHECK_TEXT[c.status]}</Tag>
                        )}
                        <Typography.Text strong>{c.label}</Typography.Text>
                      </Space>
                    }
                    description={
                      <>
                        {c.detail ? <Typography.Text type="secondary">{c.detail}</Typography.Text> : null}
                        {c.fixHint ? (
                          <Typography.Text type="warning" style={{ display: 'block' }}>
                            修复：{c.fixHint}
                          </Typography.Text>
                        ) : null}
                      </>
                    }
                  />
                </List.Item>
              )}
            />
          )}
        </Card>
        <Card
          title="告警"
          extra={
            <Button size="small" onClick={() => void markAllRead()}>
              全部已读
            </Button>
          }
        >
          <List
            dataSource={alerts}
            locale={{ emptyText: '暂无告警' }}
            renderItem={(a) => (
              <List.Item
                actions={
                  a.resolved
                    ? [<Tag key="done">已读</Tag>]
                    : [
                        a.roomId && a.failureReason ? (
                          <Button
                            key="retry"
                            size="small"
                            type="link"
                            loading={retryingId === a.id}
                            onClick={() =>
                              void retryFailure(a)
                                .then(() => message.success('已触发重新检测'))
                                .catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '重试失败'))
                            }
                          >
                            重试
                          </Button>
                        ) : null,
                        <Button key="read" size="small" type="link" onClick={() => void markRead(a.id)}>
                          标记已读
                        </Button>,
                      ]
                }
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Tag color={LEVEL_COLOR[a.level]}>{a.level}</Tag>
                      <Typography.Text>{a.message}</Typography.Text>
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={0}>
                      <Typography.Text type="secondary">
                        {a.source} · {formatTime(a.occurredAt)}
                      </Typography.Text>
                      {a.failureReason ? (
                        <Typography.Text type="danger">
                          [{a.failureReason.code}] {a.failureReason.message}
                        </Typography.Text>
                      ) : null}
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        </Card>
      </Col>
    </Row>
  );
}
