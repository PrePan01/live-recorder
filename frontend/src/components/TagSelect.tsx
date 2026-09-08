import { useEffect, useState } from 'react';
import { App, Button, Form, Input, Popover, Select, Space, Tag as AntTag, Typography } from 'antd';
import { PlusOutlined, SettingOutlined } from '@ant-design/icons';
import { useTagStore } from '../stores/tagStore';
import { describeError } from '../utils/errorMap';
import { ApiError } from '../types/error';

const PRESET_COLORS = ['#1677ff', '#52c41a', '#faad14', '#eb2f96', '#722ed1', '#13c2c2', '#fa541c', '#8c8c8c'];

interface TagSelectProps {
  value: string[];
  onChange: (tagIds: string[]) => void;
  disabled?: boolean;
}

export default function TagSelect({ value, onChange, disabled }: TagSelectProps) {
  const { message } = App.useApp();
  const { tags, load, create, remove } = useTagStore();
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm<{ name: string; color: string }>();

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const selected = tags.filter((t) => value.includes(t.id));

  const onCreate = async () => {
    // `validateFields` rejects for ordinary field errors.  Handle that local
    // UI outcome before the asynchronous create flow so it cannot reach the
    // global unhandled-rejection fatal-error handler.
    let values: { name: string; color: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setCreating(true);
    try {
      const tag = await create({ name: values.name.trim(), color: values.color });
      onChange([...value, tag.id]);
      form.resetFields();
      message.success('标签已创建');
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const managerContent = (
    <div style={{ width: 260 }}>
      <Form form={form} layout="vertical" size="small">
        <Space.Compact style={{ width: '100%' }}>
          <Form.Item name="name" noStyle rules={[{ required: true, whitespace: true, message: '必填' }, { max: 30, message: '≤30 字符' }]}>
            <Input placeholder="新标签名" />
          </Form.Item>
          <Form.Item name="color" initialValue={PRESET_COLORS[0]} noStyle>
            <Select style={{ width: 100 }} options={PRESET_COLORS.map((c) => ({ value: c, label: <AntTag color={c}>{c}</AntTag> }))} />
          </Form.Item>
          <Button icon={<PlusOutlined />} loading={creating} onClick={() => void onCreate()} />
        </Space.Compact>
      </Form>
      <div style={{ maxHeight: 220, overflow: 'auto', marginTop: 8 }}>
        {tags.length === 0 ? (
          <Typography.Text type="secondary">暂无标签</Typography.Text>
        ) : (
          tags.map((t) => {
            const isSelected = value.includes(t.id);
            const addExisting = () => {
              if (!isSelected) onChange([...value, t.id]);
            };
            return (
            <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, marginBottom: 4 }}>
              <AntTag
                color={t.color}
                role="button"
                tabIndex={isSelected ? -1 : 0}
                aria-label={isSelected ? `${t.name} 已添加` : `添加标签 ${t.name}`}
                style={{ cursor: isSelected ? 'default' : 'pointer', marginInlineEnd: 0, opacity: isSelected ? 0.6 : 1 }}
                onClick={addExisting}
                onKeyDown={(event) => {
                  if (!isSelected && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    addExisting();
                  }
                }}
              >
                {t.name}
              </AntTag>
              <span style={{ color: 'var(--lr-text-secondary)', fontSize: 12, flex: 1 }}>
                {isSelected ? '已添加' : '点击添加'}
              </span>
              <Button
                type="text"
                size="small"
                danger
                onClick={() =>
                  void remove(t.id)
                    .then(() => {
                      onChange(value.filter((id) => id !== t.id));
                      message.success('标签已删除');
                    })
                    .catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '删除失败'))
                }
              >
                删除
              </Button>
            </div>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <Space wrap size={[4, 4]}>
      {selected.map((t) => (
        <AntTag key={t.id} color={t.color} closable={!disabled} onClose={() => onChange(value.filter((id) => id !== t.id))}>
          {t.name}
        </AntTag>
      ))}
      {!disabled ? (
        <Popover content={managerContent} title="管理标签" trigger="click" placement="bottomLeft">
          <Button size="small" icon={<SettingOutlined />}>
            标签
          </Button>
        </Popover>
      ) : null}
    </Space>
  );
}
