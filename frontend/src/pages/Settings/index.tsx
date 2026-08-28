import { useEffect, useState } from 'react';
import { App, Button, Card, Col, Form, Input, InputNumber, List, Row, Select, Space, Switch, Tag, Typography } from 'antd';
import { useSettingsStore } from '../../stores/settingsStore';
import { useAlertStore } from '../../stores/alertStore';
import { validateDirectory, testSmtp } from '../../api/settings';
import { describeError } from '../../utils/errorMap';
import { ApiError } from '../../types/error';
import { formatTime } from '../../utils/format';
import type { SettingsInput } from '../../types/settings';

const LEVEL_COLOR: Record<string, string> = { info: 'blue', warning: 'orange', error: 'red' };

export default function SettingsPage() {
  const { message } = App.useApp();
  const { settings, load, save } = useSettingsStore();
  const { alerts, fetchAlerts, markRead, markAllRead } = useAlertStore();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [dirMsg, setDirMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [clearCookie, setClearCookie] = useState(false);

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

  const onFinish = async (values: SettingsInput) => {
    setSaving(true);
    try {
      const { mail, douyinCookie, ...rest } = values as SettingsInput & {
        mail?: Record<string, unknown> & { recipients?: string; password?: string };
        douyinCookie?: string;
      };
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
      message.success('设置已保存');
      setClearCookie(false);
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Row gutter={16}>
      <Col xs={24} lg={14}>
        <Card title="服务设置">
          <Form form={form} layout="vertical" onFinish={onFinish} disabled={!settings}>
            <Form.Item label="保存目录">
              <Space.Compact style={{ width: '100%' }}>
                <Form.Item name="recordingDirectory" noStyle rules={[{ required: true, message: '必填' }]}>
                  <Input />
                </Form.Item>
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
              部分抖音直播间需登录 Cookie 才能取流；Cookie 仅存本机钥匙串，不会显示或上传
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
            <Button type="primary" htmlType="submit" loading={saving}>
              保存设置
            </Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={10}>
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
                  description={`${a.source} · ${formatTime(a.occurredAt)}`}
                />
              </List.Item>
            )}
          />
        </Card>
      </Col>
    </Row>
  );
}
