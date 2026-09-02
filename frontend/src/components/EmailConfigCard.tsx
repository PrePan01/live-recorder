import { useEffect, useState } from 'react';
import { App, Button, Col, Form, Input, InputNumber, Row, Select, Space, Switch, Typography } from 'antd';
import { fetchEmail, fetchEmailPresets, updateEmail, testEmail } from '../api/email';
import { describeError } from '../utils/errorMap';
import { ApiError } from '../types/error';
import type { SmtpPreset } from '../api/email';

export default function EmailConfigCard() {
  const { message } = App.useApp();
  const [email, setEmail] = useState<Awaited<ReturnType<typeof fetchEmail>> | null>(null);
  const [presets, setPresets] = useState<SmtpPreset[]>([]);
  const [form] = Form.useForm();
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void Promise.all([fetchEmail(), fetchEmailPresets()])
      .then(([e, p]) => {
        setEmail(e);
        setPresets(p);
        form.setFieldsValue({
          enabled: e.enabled,
          host: e.host,
          port: e.port,
          secure: e.secure,
          username: e.username,
          from: e.from,
          recipients: (e.recipients ?? []).join(', '),
          password: '',
        });
      })
      .catch((err) => message.error(err instanceof ApiError ? describeError(err.code, err.message) : '邮件配置加载失败'));
  }, [form, message]);

  const onPreset = (presetId: string) => {
    const preset = presets.find((p) => p.id === presetId);
    if (!preset) return;
    form.setFieldsValue({ host: preset.host, port: preset.port, secure: preset.secure });
    void save(form.getFieldsValue());
  };

  const save = (values: Record<string, unknown>) => {
    const { password, recipients, ...rest } = values;
    void updateEmail({
      ...(rest as object),
      ...(typeof recipients === 'string' ? { recipients: recipients.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
      ...(typeof password === 'string' && password.length > 0 ? { password } : {}),
    })
      .then((e) => setEmail(e))
      .catch((err) => message.error(err instanceof ApiError ? describeError(err.code, err.message) : '保存失败'));
  };

  const onTest = async () => {
    setTesting(true);
    try {
      await testEmail();
      message.success('测试邮件已发送');
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '发送失败');
    } finally {
      setTesting(false);
    }
  };

  return (
    <Form form={form} layout="vertical" size="small" onValuesChange={(_, all) => save(all)}>
      <Form.Item label="启用邮件通知" name="enabled" valuePropName="checked">
        <Switch />
      </Form.Item>
      <Form.Item label="服务商预设">
        <Select
          placeholder="选择服务商自动填充"
          onChange={onPreset}
          options={presets.map((p) => ({ value: p.id, label: p.name }))}
        />
      </Form.Item>
      <Row gutter={12}>
        <Col xs={24} sm={14}>
          <Form.Item label="服务器" name="host">
            <Input placeholder="smtp.example.com" />
          </Form.Item>
        </Col>
        <Col xs={12} sm={5}>
          <Form.Item label="端口" name="port">
            <InputNumber min={1} max={65535} style={{ width: '100%' }} />
          </Form.Item>
        </Col>
        <Col xs={12} sm={5}>
          <Form.Item label="TLS" name="secure" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item label="用户名" name="username">
        <Input autoComplete="username" />
      </Form.Item>
      <Form.Item label="发件地址" name="from">
        <Input placeholder="sender@example.com" />
      </Form.Item>
      <Form.Item
        label="收件地址（逗号分隔）"
        name="recipients"
        rules={[
          {
            validator: (_, v: string) =>
              !v || v.split(',').every((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.trim()))
                ? Promise.resolve()
                : Promise.reject(new Error('存在非法邮箱地址')),
          },
        ]}
      >
        <Input placeholder="a@example.com, b@example.com" />
      </Form.Item>
      <Form.Item label="密码" name="password" extra={email?.passwordSet ? '已保存，留空则不修改' : undefined}>
        <Input.Password placeholder={email?.passwordSet ? '••••••' : '输入 SMTP 密码'} autoComplete="new-password" />
      </Form.Item>
      <Space>
        <Button size="small" loading={testing} onClick={() => void onTest()}>
          测试发送
        </Button>
        <Typography.Text type="secondary">同类事件 30 分钟去重；密码仅存本机。</Typography.Text>
      </Space>
    </Form>
  );
}
