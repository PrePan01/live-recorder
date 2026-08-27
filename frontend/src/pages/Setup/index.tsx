import { useEffect, useState } from 'react';
import { App, Button, Card, Checkbox, Form, Input, InputNumber, Space, Steps, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { validateDirectory, updateSettings, testSmtp } from '../../api/settings';
import { useSettingsStore } from '../../stores/settingsStore';
import { useServiceStore } from '../../stores/serviceStore';
import { describeError } from '../../utils/errorMap';
import { ApiError } from '../../types/error';

interface DirState {
  checking: boolean;
  valid: boolean | null;
  message: string | null;
}

export default function Setup() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const settings = useSettingsStore((s) => s.settings);
  const load = useSettingsStore((s) => s.load);
  const [step, setStep] = useState(0);
  const [dir, setDir] = useState<string>(settings?.saveDirectory ?? '');
  const [dirState, setDirState] = useState<DirState>({ checking: false, valid: null, message: null });
  const [concurrency, setConcurrency] = useState<number>(settings?.maxConcurrency ?? 2);
  const [mailOn, setMailOn] = useState(false);
  const [mail, setMail] = useState({ host: '', port: 465, user: '', from: '', to: '', useTls: true, password: '' });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!settings) void load();
  }, [settings, load]);

  const validate = async () => {
    setDirState({ checking: true, valid: null, message: null });
    try {
      const res = await validateDirectory(dir.trim());
      setDirState({ checking: false, valid: res.valid && res.writable, message: res.message });
    } catch (e) {
      setDirState({
        checking: false,
        valid: false,
        message: e instanceof ApiError ? describeError(e.code, e.message) : '校验失败',
      });
    }
  };

  const finish = async () => {
    setSaving(true);
    try {
      await updateSettings({
        saveDirectory: dir.trim(),
        maxConcurrency: concurrency,
        ...(mailOn
          ? {
              mail: {
                host: mail.host,
                port: mail.port,
                user: mail.user,
                from: mail.from,
                to: mail.to,
                useTls: mail.useTls,
                password: mail.password || undefined,
              },
            }
          : {}),
      });
      await useServiceStore.getState().fetchStatus();
      message.success('设置已保存');
      navigate('/monitor', { replace: true });
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const canNext = step === 0 ? dirState.valid === true : step === 1 ? concurrency >= 1 : true;

  return (
    <Card title="首次设置" style={{ maxWidth: 720, margin: '48px auto' }}>
      <Steps
        current={step}
        items={[{ title: '保存目录' }, { title: '并发数' }, { title: '邮件通知' }, { title: '完成' }]}
        style={{ marginBottom: 32 }}
      />
      {step === 0 && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text>选择录像保存目录：</Typography.Text>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="如 /Users/you/Videos/live-recorder"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              onPressEnter={() => void validate()}
            />
            <Button type="primary" loading={dirState.checking} disabled={!dir.trim()} onClick={() => void validate()}>
              校验
            </Button>
          </Space.Compact>
          {dirState.valid === true && <Typography.Text type="success">目录可写，可以使用</Typography.Text>}
          {dirState.valid === false && <Typography.Text type="danger">{dirState.message ?? '目录不可用'}</Typography.Text>}
        </Space>
      )}
      {step === 1 && (
        <Space direction="vertical">
          <Typography.Text>最大并发录制数（默认 2）：</Typography.Text>
          <InputNumber min={1} max={8} value={concurrency} onChange={(v) => setConcurrency(v ?? 2)} />
        </Space>
      )}
      {step === 2 && (
        <Space direction="vertical" style={{ width: '100%' }}>
          <Checkbox checked={mailOn} onChange={(e) => setMailOn(e.target.checked)}>
            启用 SMTP 邮件告警（可跳过）
          </Checkbox>
          {mailOn && (
            <Form layout="vertical">
              <Space wrap>
                <Form.Item label="SMTP 服务器" style={{ marginBottom: 8 }}>
                  <Input value={mail.host} onChange={(e) => setMail({ ...mail, host: e.target.value })} placeholder="smtp.example.com" />
                </Form.Item>
                <Form.Item label="端口" style={{ marginBottom: 8 }}>
                  <InputNumber value={mail.port} onChange={(v) => setMail({ ...mail, port: v ?? 465 })} />
                </Form.Item>
                <Form.Item label="用户名" style={{ marginBottom: 8 }}>
                  <Input value={mail.user} onChange={(e) => setMail({ ...mail, user: e.target.value })} />
                </Form.Item>
                <Form.Item label="发件地址" style={{ marginBottom: 8 }}>
                  <Input value={mail.from} onChange={(e) => setMail({ ...mail, from: e.target.value })} />
                </Form.Item>
                <Form.Item label="收件地址" style={{ marginBottom: 8 }}>
                  <Input value={mail.to} onChange={(e) => setMail({ ...mail, to: e.target.value })} />
                </Form.Item>
                <Form.Item label="密码" style={{ marginBottom: 8 }}>
                  <Input.Password value={mail.password} onChange={(e) => setMail({ ...mail, password: e.target.value })} />
                </Form.Item>
              </Space>
              <Checkbox checked={mail.useTls} onChange={(e) => setMail({ ...mail, useTls: e.target.checked })}>
                使用 TLS
              </Checkbox>
              <div>
                <Button
                  disabled={!mail.host || !mail.to}
                  onClick={() =>
                    testSmtp()
                      .then(() => message.success('测试邮件已发送'))
                      .catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '发送失败'))
                  }
                >
                  测试发送
                </Button>
              </div>
            </Form>
          )}
        </Space>
      )}
      {step === 3 && (
        <Space direction="vertical">
          <Typography.Text>配置确认：</Typography.Text>
          <Typography.Paragraph>
            保存目录：<Typography.Text code>{dir}</Typography.Text>
            <br />
            并发数：{concurrency}
            <br />
            邮件通知：{mailOn ? `${mail.host} → ${mail.to}` : '未启用'}
            <br />
            清晰度：原画（默认，可在设置中修改）
          </Typography.Paragraph>
        </Space>
      )}
      <div style={{ marginTop: 32, display: 'flex', justifyContent: 'space-between' }}>
        <Button disabled={step === 0} onClick={() => setStep(step - 1)}>
          上一步
        </Button>
        {step < 3 ? (
          <Space>
            {step === 2 && <Button onClick={() => setStep(3)}>跳过</Button>}
            <Button type="primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
              下一步
            </Button>
          </Space>
        ) : (
          <Button type="primary" loading={saving} onClick={() => void finish()}>
            完成设置
          </Button>
        )}
      </div>
    </Card>
  );
}
