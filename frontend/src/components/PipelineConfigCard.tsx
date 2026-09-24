import { useEffect, useRef, useState, type ReactNode } from "react";
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

/** 管线步骤卡：序号徽标 + 步骤名（hover 轻提示）+ 开关 + 可选参数控件；关态=旁路（线外缩进）。 */
function StepCard({
  num,
  label,
  tip,
  desc,
  on,
  bypass,
  switchNode,
  children,
}: {
  num: string;
  label: string;
  tip: string;
  desc: string;
  on: boolean;
  bypass: boolean;
  switchNode: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={`lr-pipeline-step${
        on
          ? " lr-pipeline-step--on is-on"
          : bypass
            ? " is-bypass"
            : ""
      }`}
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
        {bypass && !on ? (
          <span className="lr-pipeline-step__bypass">旁路</span>
        ) : null}
        <span className="lr-pipeline-step__spacer" />
        {switchNode}
      </div>
      {/* task #69/#70：步骤内说明文案卡内可见（不得删，功能描述口径） */}
      <div className="lr-pipeline-step__desc">{desc}</div>
      {children ? (
        <div className="lr-pipeline-step__ctrl">{children}</div>
      ) : null}
    </div>
  );
}

/**
 * 步骤间连接件（task #72 重设计）：中空管段+两端接头法兰+箭头喷口+粉色流向点。
 * live=主流流经（上/下均有开启步骤，旁路不断流）；非 live=断流灰化静默。
 */
function PipeLink({ live }: { live: boolean }) {
  return (
    <div
      className={`lr-pipeline-link${live ? " lr-pipeline-link--live" : ""}`}
      aria-hidden="true"
    >
      <span className="lr-pipeline-link__tube" />
      <span className="lr-pipeline-link__flow" />
      <span className="lr-pipeline-link__head" />
    </div>
  );
}

export default function PipelineConfigCard() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<Awaited<
    ReturnType<typeof fetchPipelineConfig>
  > | null>(null);
  const [form] = Form.useForm();
  // 开关切换时的接通/断开爆发动效（箭头脉冲+流速瞬时加快）。
  const [burst, setBurst] = useState(false);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetchPipelineConfig()
      .then((c) => {
        setConfig(c);
        // 旧语义反推三个步骤开关的初值（0/null/空串=关，task #65）；
        // exportCover 兼容后端热更前的缺键（缺=默认开，task #70）。
        form.setFieldsValue({
          ...c,
          exportCover: c.exportCover ?? true,
          ...derivePipelineSwitches(c),
        });
      })
      .catch((e) =>
        message.error(
          e instanceof ApiError
            ? describeError(e.code, e.message)
            : "管线配置加载失败",
        ),
      );
  }, [form, message]);

  useEffect(
    () => () => {
      if (burstTimer.current) clearTimeout(burstTimer.current);
    },
    [],
  );

  const save = (values: Record<string, unknown>) => {
    void updatePipelineConfig(buildPipelinePayload(values))
      .then((c) => setConfig(c))
      .catch((e) =>
        message.error(
          e instanceof ApiError ? describeError(e.code, e.message) : "保存失败",
        ),
      );
  };

  const triggerBurst = () => {
    if (burstTimer.current) clearTimeout(burstTimer.current);
    setBurst(true);
    burstTimer.current = setTimeout(() => setBurst(false), 700);
  };

  const onValuesChange = (
    changed: Record<string, unknown>,
    all: Record<string, unknown>,
  ) => {
    // 总开关刚开启时步骤字段才挂载：回填服务端值再保存，
    // 避免把 undefined 发回覆盖既有配置（task #58；#70 起兼回填 exportCover）。
    if (
      all.enabled &&
      config &&
      (all.exportAudio === undefined || all.exportCover === undefined)
    ) {
      const patch: Record<string, unknown> = {};
      if (all.exportAudio === undefined)
        patch.exportAudio = config.exportAudio ?? false;
      if (all.exportCover === undefined)
        patch.exportCover = config.exportCover ?? true;
      form.setFieldsValue(patch);
      save({ ...all, ...patch });
      return;
    }

    // 首开默认值：开关打开且无历史值时回填（切片 10s / 压缩 CRF 23）。
    if (changed.segmentEnabled === true && !(Number(all.segmentSeconds) > 0)) {
      form.setFieldValue("segmentSeconds", FIRST_ENABLE_SEGMENT_SECONDS);
    }
    if (changed.crfEnabled === true && (all.crf == null || all.crf === "")) {
      form.setFieldValue("crf", FIRST_ENABLE_CRF);
    }

    // task #72：步骤开关/总闸切换触发接通-断开动效（归档不再阻止开启——
    // 未填路径载荷为空、运行时由后端跳过该步，PrePan 2a6ee1c8）。
    const STEP_KEYS = [
      "enabled",
      "verify",
      "exportCover",
      "segmentEnabled",
      "exportAudio",
      "crfEnabled",
      "archiveEnabled",
    ];
    if (STEP_KEYS.some((k) => k in changed)) triggerBurst();

    save(all);
  };

  const segOn = Form.useWatch("segmentEnabled", form) === true;
  const crfOn = Form.useWatch("crfEnabled", form) === true;
  const archiveOn = Form.useWatch("archiveEnabled", form) === true;
  const verifyOn = Form.useWatch("verify", form) === true;
  const audioOn = Form.useWatch("exportAudio", form) === true;
  const coverOn = Form.useWatch("exportCover", form) === true;
  const segVal = Number(Form.useWatch("segmentSeconds", form) ?? 0);
  const crfVal = Form.useWatch("crf", form);

  // 流向规则（PrePan ff5469b9）：主流只沿开启步骤流动；连接件 live =
  // 上方存在开启步骤 且 下方存在开启步骤（旁路时主流不断）。
  const stepOn = [verifyOn, coverOn, segOn, audioOn, crfOn, archiveOn];
  const firstOn = stepOn.findIndex(Boolean);
  const flowExists = firstOn !== -1;
  const lastOn = flowExists
    ? stepOn.length - 1 - [...stepOn].reverse().findIndex(Boolean)
    : -1;
  const liveAt = (i: number) => firstOn <= i && lastOn >= i + 1;
  // 循环流动点仅在 ≥2 个开启步骤时出现（设计基线：单点无流可流）。
  const flowing = stepOn.filter(Boolean).length >= 2;

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
        extra="录制完成后执行校验/封面/切片/压缩/归档"
      >
        <Switch />
      </Form.Item>
      {config?.enabled ? (
        <div
          className={
            `lr-pipeline-flow${burst ? " lr-pipeline-flow--burst" : ""}` +
            (flowing ? " lr-pipeline-flow--flowing" : "")
          }
        >
          <StepCard
            num="1"
            label="完整性校验"
            tip="ffprobe 校验录制文件完整性；失败标记 partial 并告警"
            desc="ffprobe 完整性校验"
            on={verifyOn}
            bypass={flowExists}
            switchNode={
              <Form.Item name="verify" valuePropName="checked" noStyle>
                <Switch />
              </Form.Item>
            }
          />
          <PipeLink live={liveAt(0)} />
          {/* task #70：封面导出可选步骤（exportCover 默认开，BE #71 契约；关=step skipped）；
              task #72：元数据步仅去展示（实际流程照旧），封面升第 2 步 */}
          <StepCard
            num="2"
            label="封面"
            tip="导出封面帧用于历史列表展示；默认开"
            desc="录制完成后导出封面帧"
            on={coverOn}
            bypass={flowExists}
            switchNode={
              <Form.Item
                name="exportCover"
                valuePropName="checked"
                noStyle
              >
                <Switch />
              </Form.Item>
            }
          />
          <PipeLink live={liveAt(1)} />
          <StepCard
            num="3"
            label="切片"
            tip="按秒切分录制文件；首开默认 10 秒"
            desc={
              segOn && segVal > 0
                ? `每 ${segVal} 秒切分录制文件`
                : "按秒切分录制文件"
            }
            on={segOn}
            bypass={flowExists}
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
          <PipeLink live={liveAt(2)} />
          {/* task #58：导出音频文件——总开关未启用时整块不展示（PrePan 修正）；
              默认关，只影响之后触发的 run（配置在 run 启动时快照） */}
          <StepCard
            num="4"
            label="导出音频"
            tip="录制完成后自动转换出 MP3（192k CBR）"
            desc="录制完成后自动转换出 MP3"
            on={audioOn}
            bypass={flowExists}
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
          <PipeLink live={liveAt(3)} />
          <StepCard
            num="5"
            label="压缩"
            tip="转封装/压缩为 MP4；CRF 越低质量越高，首开默认 23"
            desc={
              crfOn && crfVal != null
                ? `CRF ${crfVal}，越低质量越高（0-51）`
                : "转封装/压缩输出 MP4"
            }
            on={crfOn}
            bypass={flowExists}
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
          <PipeLink live={liveAt(4)} />
          {/* task #72：归档反转——开开关才显示路径输入，不再先填先校验；
              未填路径载荷为空，运行时后端跳过该步 */}
          <StepCard
            num="6"
            label="归档"
            tip="完成后移动到归档目录；未填路径时运行中跳过该步"
            desc="完成后移动到归档目录"
            on={archiveOn}
            bypass={flowExists}
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
            {archiveOn ? (
              <Form.Item label="归档目录" name="archiveDirectory">
                <Input placeholder="/path/to/archive" />
              </Form.Item>
            ) : null}
          </StepCard>
        </div>
      ) : null}
      <Form.Item label="管线并发" name="maxConcurrency" extra="固定上限 2">
        <Select disabled options={[{ value: 2, label: "2" }]} />
      </Form.Item>
    </Form>
  );
}
