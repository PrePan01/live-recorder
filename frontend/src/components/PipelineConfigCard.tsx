import { useEffect, useState } from 'react';
import { App, Card, Form, Input, InputNumber, Select, Switch, Typography } from 'antd';
import { fetchPipelineConfig, updatePipelineConfig } from '../api/pipeline';
import { describeError } from '../utils/errorMap';
import { ApiError } from '../types/error';

export default function PipelineConfigCard() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<Awaited<ReturnType<typeof fetchPipelineConfig>> | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchPipelineConfig()
      .then((c) => {
        setConfig(c);
        form.setFieldsValue(c);
      })
      .catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '管线配置加载失败'));
  }, [form, message]);

  const save = (values: Record<string, unknown>) => {
    void updatePipelineConfig(values as Parameters<typeof updatePipelineConfig>[0])
      .then((c) => setConfig(c))
      .catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '保存失败'));
  };

  return (
    <Form form={form} layout="vertical" size="small" onValuesChange={(_, all) => save(all)}>
        <Form.Item label="启用后处理管线" name="enabled" valuePropName="checked" extra="录制完成后执行校验/切片/压缩/归档">
          <Switch />
        </Form.Item>
        {config?.enabled ? (
          <>
            <Form.Item label="ffprobe 完整性校验" name="verify" valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item
              label="切片秒数（0=不切片）"
              name="segmentSeconds"
              extra={config.segmentSeconds > 0 ? `每 ${config.segmentSeconds}s 切片` : undefined}
            >
              <InputNumber min={0} max={86400} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item
              label="压缩档位 CRF（0-51，空=不压缩）"
              name="crf"
              extra={config.crf != null ? `CRF ${config.crf}（越低质量越高）` : undefined}
            >
              <InputNumber min={0} max={51} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="归档目录（空=不归档）" name="archiveDirectory">
              <Input placeholder="/path/to/archive" />
            </Form.Item>
          </>
        ) : null}
        <Form.Item label="管线并发" name="maxConcurrency" extra="固定上限 2，录制主链路优先">
          <Select
            disabled
            options={[
              { value: 2, label: '2（V5 定值）' },
            ]}
          />
        </Form.Item>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          配置修改只影响新录制的管线任务，已有任务保留快照。
        </Typography.Paragraph>
      </Form>
  );
}