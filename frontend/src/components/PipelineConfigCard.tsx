import { useEffect, useState } from "react";
import { App, Form, Input, InputNumber, Select, Switch } from "antd";
import { fetchPipelineConfig, updatePipelineConfig } from "../api/pipeline";
import { describeError } from "../utils/errorMap";
import { ApiError } from "../types/error";

export default function PipelineConfigCard() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<Awaited<
    ReturnType<typeof fetchPipelineConfig>
  > | null>(null);
  const [form] = Form.useForm();

  useEffect(() => {
    fetchPipelineConfig()
      .then((c) => {
        setConfig(c);
        form.setFieldsValue(c);
      })
      .catch((e) =>
        message.error(
          e instanceof ApiError
            ? describeError(e.code, e.message)
            : "管线配置加载失败",
        ),
      );
  }, [form, message]);

  const save = (values: Record<string, unknown>) => {
    void updatePipelineConfig(
      values as Parameters<typeof updatePipelineConfig>[0],
    )
      .then((c) => setConfig(c))
      .catch((e) =>
        message.error(
          e instanceof ApiError ? describeError(e.code, e.message) : "保存失败",
        ),
      );
  };

  // 总开关刚开启时 exportAudio 字段才挂载：回填服务端值再保存，
  // 避免把 undefined 发回覆盖既有配置（task #58）。
  const onValuesChange = (
    _changed: Record<string, unknown>,
    all: Record<string, unknown>,
  ) => {
    if (all.enabled && all.exportAudio === undefined && config) {
      const v = config.exportAudio ?? false;
      form.setFieldValue("exportAudio", v);
      save({ ...all, exportAudio: v });
      return;
    }
    save(all);
  };

  return (
    <Form
      form={form}
      layout="vertical"
      size="small"
      onValuesChange={onValuesChange}
    >
      <Form.Item
        label="启用后处理管线"
        name="enabled"
        valuePropName="checked"
        extra="录制完成后执行校验/切片/压缩/归档"
      >
        <Switch />
      </Form.Item>
      {config?.enabled ? (
        <>
          <Form.Item
            label="ffprobe 完整性校验"
            name="verify"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="切片秒数（0=不切片）"
            name="segmentSeconds"
            extra={
              config.segmentSeconds > 0
                ? `每 ${config.segmentSeconds}s 切片`
                : undefined
            }
          >
            <InputNumber min={0} max={86400} style={{ width: "100%" }} />
          </Form.Item>
          {/* task #58：导出音频文件——总开关未启用时整块不展示（PrePan 修正）；
              默认关，只影响之后触发的 run（配置在 run 启动时快照） */}
          <Form.Item
            label="导出音频文件"
            name="exportAudio"
            valuePropName="checked"
            extra="录制完成后自动转换出 MP3（CBR 192k，仅留录制目录）"
          >
            <Switch />
          </Form.Item>
          <Form.Item
            label="压缩档位 CRF（0-51，空=不压缩）"
            name="crf"
            extra={
              config.crf != null
                ? `CRF ${config.crf}（越低质量越高）`
                : undefined
            }
          >
            <InputNumber min={0} max={51} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item label="归档目录（空=不归档）" name="archiveDirectory">
            <Input placeholder="/path/to/archive" />
          </Form.Item>
        </>
      ) : null}
      <Form.Item label="管线并发" name="maxConcurrency" extra="固定上限 2">
        <Select disabled options={[{ value: 2, label: "2" }]} />
      </Form.Item>
    </Form>
  );
}
