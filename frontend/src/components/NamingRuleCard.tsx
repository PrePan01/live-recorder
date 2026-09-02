import { useEffect, useState } from 'react';
import { App, Button, Input, Select, Space, Typography } from 'antd';
import { fetchNamingRule, updateNamingRule, previewNamingRule, NAMING_PRESETS, NAMING_VARS } from '../api/naming';
import { describeError } from '../utils/errorMap';
import { ApiError } from '../types/error';

export default function NamingRuleCard() {
  const { message } = App.useApp();
  const [rule, setRule] = useState<string | null>(null);
  const [example, setExample] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchNamingRule()
      .then(async (r) => {
        setRule(r);
        setExample(await previewNamingRule(r));
      })
      .catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '命名规则加载失败'));
  }, [message]);

  const save = (value: string) => {
    setBusy(true);
    void updateNamingRule(value)
      .then(async (r) => {
        setRule(r);
        setExample(await previewNamingRule(r));
        message.success('命名规则已保存');
      })
      .catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '保存失败'))
      .finally(() => setBusy(false));
  };

  const onPreview = async (value: string) => {
    if (value.length === 0) return;
    try {
      setExample(await previewNamingRule(value));
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '预览失败');
    }
  };

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={12}>
      <Space wrap>
        <span>预设：</span>
        <Select
          style={{ width: 240 }}
          placeholder="选择预设模板"
          options={NAMING_PRESETS}
          value={rule ?? undefined}
          onChange={save}
        />
      </Space>
      <Space.Compact style={{ width: '100%' }}>
        <Input
          style={{ width: 'calc(100% - 100px)' }}
          value={rule ?? ''}
          placeholder="{room}_{date}_{time}"
          maxLength={200}
          disabled={busy}
          onChange={(e) => {
            setRule(e.target.value);
            void onPreview(e.target.value);
          }}
          onBlur={(e) => {
            if (e.target.value !== rule) save(e.target.value);
          }}
        />
        <Button loading={busy} onClick={() => rule && save(rule)}>
          保存
        </Button>
      </Space.Compact>
      <Space wrap size={[4, 4]}>
        <Typography.Text type="secondary">可用变量：</Typography.Text>
        {NAMING_VARS.map((v) => (
          <Typography.Text key={v} code style={{ cursor: 'pointer' }} onClick={() => rule && save(`${rule}{${v}}`)}>
            {'{' + v + '}'}
          </Typography.Text>
        ))}
      </Space>
      {example ? (
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          示例：<Typography.Text code>{example}</Typography.Text>
        </Typography.Paragraph>
      ) : null}
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        非法字符自动过滤、超长截断、同名自动加序号；修改只影响新录制，不追溯历史文件。
      </Typography.Paragraph>
    </Space>
  );
}