import { useEffect, useState, type ReactNode } from "react";
import { App, Form, Input, InputNumber, Select, Switch, Tooltip } from "antd";
import { fetchPipelineConfig, updatePipelineConfig } from "../api/pipeline";
import { describeError } from "../utils/errorMap";
import { ApiError } from "../types/error";
import {
  FIRST_ENABLE_CRF,
  FIRST_ENABLE_SEGMENT_SECONDS,
  buildPipelinePayload,
  derivePipelineSwitches,
} from "./pipelineConfigForm";

/** 管线步骤卡：序号徽标 + 步骤名（hover 轻提示）+ 开关 + 可选参数控件。 */
function StepCard({
  num,
  label,
  tip,
  on,
  switchNode,
  children,
}: {
  num: string;
  label: string;
  tip: string;
  on: boolean;
  switchNode: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={`lr-pipeline-step${on ? " lr-pipeline-step--on" : ""}`}
      data-step={num}
    >
      <div className="lr-pipeline-step__head">
        <Tooltip title={tip}>
          <span className="lr-pipeline-step__num" aria-hidden="true">
            {num}
          </span>
        </Tooltip>
        <Tooltip title={tip}>
          <span className="lr-pipeline-step__name">{label}</span>
        </Tooltip>
        <span className="lr-pipeline-step__spacer" />
        {switchNode}
      </div>
      {children ? (
        <div className="lr-pipeline-step__ctrl">{children}</div>
      ) : null}
    </div>
  );
}

/** 步骤间连接件：黑描边管段 + 流向箭头（带 chip 标注的为自动执行节点）。 */
function PipeLink({ auto }: { auto?: string }) {
  return (
    <div
      className={`lr-pipeline-link${auto ? " lr-pipeline-link--auto" : ""}`}
      aria-hidden="true"
    >
      {auto ? (
        <span className="lr-pipeline-link__chip">{auto}</span>
      ) : (
        <span className="lr-pipeline-link__dot" />
      )}
    </div>
  );
}

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
        // 旧语义反推三个步骤开关的初值（0/null/空串=关，task #65）。
        form.setFieldsValue({ ...c, ...derivePipelineSwitches(c) });
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
    void updatePipelineConfig(buildPipelinePayload(values))
      .then((c) => setConfig(c))
      .catch((e) =>
        message.error(
          e instanceof ApiError ? describeError(e.code, e.message) : "保存失败",
        ),
      );
  };

  const onValuesChange = (
    changed: Record<string, unknown>,
    all: Record<string, unknown>,
  ) => {
    // 总开关刚开启时 exportAudio 字段才挂载：回填服务端值再保存，
    // 避免把 undefined 发回覆盖既有配置（task #58）。
    if (all.enabled && all.exportAudio === undefined && config) {
      const v = config.exportAudio ?? false;
      form.setFieldValue("exportAudio", v);
      save({ ...all, exportAudio: v });
      return;
    }

    // 归档开启前目录必填：未填则回退开关并提示——
    // 避免「UI 显示开、载荷为空串=关」的状态漂移（task #65）。
    if (
      all.archiveEnabled === true &&
      !String(all.archiveDirectory ?? "").trim()
    ) {
      form.setFieldValue("archiveEnabled", false);
      message.warning("请先填写归档目录，再开启归档");
      return;
    }

    // 首开默认值：开关打开且无历史值时回填（切片 10s / 压缩 CRF 23）。
    if (changed.segmentEnabled === true && !(Number(all.segmentSeconds) > 0)) {
      form.setFieldValue("segmentSeconds", FIRST_ENABLE_SEGMENT_SECONDS);
    }
    if (changed.crfEnabled === true && (all.crf == null || all.crf === "")) {
      form.setFieldValue("crf", FIRST_ENABLE_CRF);
    }

    save(all);
  };

  const segOn = Form.useWatch("segmentEnabled", form) === true;
  const crfOn = Form.useWatch("crfEnabled", form) === true;
  const archiveOn = Form.useWatch("archiveEnabled", form) === true;
  const verifyOn = Form.useWatch("verify", form) === true;
  const audioOn = Form.useWatch("exportAudio", form) === true;

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
        <div className="lr-pipeline-flow">
          <StepCard
            num="1"
            label="完整性校验"
            tip="ffprobe 校验录制文件完整性；失败标记 partial 并告警"
            on={verifyOn}
            switchNode={
              <Form.Item name="verify" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
            }
          />
          <PipeLink auto="元数据 · 封面 · 自动执行" />
          <StepCard
            num="2"
            label="切片"
            tip="按秒切分录制文件；关=不切片（写 0），开=每 N 秒一片（首开默认 10s）"
            on={segOn}
            switchNode={
              <Form.Item
                name="segmentEnabled"
                valuePropName="checked"
                noStyle
              >
                <Switch />
              </Form.Item>
            }
          >
            {segOn ? (
              <Form.Item label="切片秒数" name="segmentSeconds">
                <InputNumber min={1} max={86400} style={{ width: "100%" }} />
              </Form.Item>
            ) : null}
          </StepCard>
          <PipeLink />
          {/* task #58：导出音频文件——总开关未启用时整块不展示（PrePan 修正）；
              默认关，只影响之后触发的 run（配置在 run 启动时快照） */}
          <StepCard
            num="3"
            label="导出音频"
            tip="录制完成后自动转换出 MP3（192k CBR）；关=不导出"
            on={audioOn}
            switchNode={
              <Form.Item
                name="exportAudio"
                valuePropName="checked"
                noStyle
              >
                <Switch />
              </Form.Item>
            }
          />
          <PipeLink />
          <StepCard
            num="4"
            label="压缩"
            tip="转封装/压缩为 MP4；CRF 越低质量越高（首开默认 23），关=保持源格式不压缩"
            on={crfOn}
            switchNode={
              <Form.Item name="crfEnabled" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
            }
          >
            {crfOn ? (
              <Form.Item label="压缩档位 CRF" name="crf">
                <InputNumber min={0} max={51} style={{ width: "100%" }} />
              </Form.Item>
            ) : null}
          </StepCard>
          <PipeLink />
          <StepCard
            num="5"
            label="归档"
            tip="完成后移动到归档目录；关=不归档（写空）"
            on={archiveOn}
            switchNode={
              <Form.Item
                name="archiveEnabled"
                valuePropName="checked"
                noStyle
              >
                <Switch />
              </Form.Item>
            }
          >
            <Form.Item
              label="归档目录"
              name="archiveDirectory"
              rules={
                archiveOn
                  ? [{ required: true, message: "请填写归档目录" }]
                  : []
              }
            >
              <Input placeholder="/path/to/archive（开启归档前必填）" />
            </Form.Item>
          </StepCard>
        </div>
      ) : null}
      <Form.Item label="管线并发" name="maxConcurrency" extra="固定上限 2">
        <Select disabled options={[{ value: 2, label: "2" }]} />
      </Form.Item>
    </Form>
  );
}
