import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  App,
  Button,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Tooltip,
} from "antd";
import { fetchPipelineConfig, updatePipelineConfig } from "../api/pipeline";
import { validateDirectory } from "../api/settings";
import { describeError } from "../utils/errorMap";
import { ApiError } from "../types/error";
import DirectoryPicker from "./DirectoryPicker";
import {
  FIRST_ENABLE_CRF,
  FIRST_ENABLE_SEGMENT_SECONDS,
  buildPipelinePayload,
  derivePipelineSwitches,
} from "./pipelineConfigForm";

/** 每个步骤共享左侧总线；启用时从卡片左侧进出，关闭时由总线直通。 */
function StepCard({
  num,
  label,
  tip,
  desc,
  on,
  switchNode,
  children,
}: {
  num: string;
  label: string;
  tip: string;
  desc: string;
  on: boolean;
  switchNode: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      className={`lr-pipeline-row${on ? " is-on" : " is-bypass"}`}
      data-step={num}
    >
      <svg
        className="lr-pipeline-bypass"
        width="48"
        height="100%"
        aria-hidden="true"
      >
        <line
          className="lr-pipeline-route__wall"
          x1="24"
          y1="0"
          x2="24"
          y2="100%"
        />
        <line
          className="lr-pipeline-route__core"
          x1="24"
          y1="0"
          x2="24"
          y2="100%"
        />
        <line
          className="lr-pipeline-route__flow"
          x1="24"
          y1="0"
          x2="24"
          y2="100%"
        />
      </svg>
      {(["in", "out"] as const).map((port) => {
        const path = port === "in" ? "M24 0 V40 H48" : "M48 0 H24 V40";
        return (
          <svg
            key={port}
            className={`lr-pipeline-route lr-pipeline-route--${port}`}
            width="54"
            height="40"
            viewBox="0 0 54 40"
            aria-hidden="true"
          >
            <path className="lr-pipeline-route__wall" d={path} />
            <path className="lr-pipeline-route__core" d={path} />
            <path className="lr-pipeline-route__flow" d={path} />
            <circle
              className="lr-pipeline-port"
              cx="48"
              cy={port === "in" ? 40 : 0}
              r="5"
            />
          </svg>
        );
      })}
      <div className="lr-pipeline-step">
        <div className="lr-pipeline-step__head">
          <span className="lr-pipeline-step__num" aria-hidden="true">
            {num.padStart(2, "0")}
          </span>
          <Tooltip title={tip}>
            <span className="lr-pipeline-step__name">{label}</span>
          </Tooltip>
          <span className="lr-pipeline-step__spacer" />
          {switchNode}
        </div>
        <div className="lr-pipeline-step__desc">{desc}</div>
        {children ? (
          <div className="lr-pipeline-step__ctrl">{children}</div>
        ) : null}
      </div>
    </div>
  );
}

export default function PipelineConfigCard() {
  const { message } = App.useApp();
  const [config, setConfig] = useState<Awaited<
    ReturnType<typeof fetchPipelineConfig>
  > | null>(null);
  const [form] = Form.useForm();
  const flowRef = useRef<HTMLDivElement>(null);
  const [archivePickerOpen, setArchivePickerOpen] = useState(false);
  useEffect(() => {
    fetchPipelineConfig()
      .then((c) => {
        setConfig(c);
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
  const archiveDirectory = Form.useWatch("archiveDirectory", form);

  const enabled = Form.useWatch("enabled", form) === true;

  useLayoutEffect(() => {
    const root = flowRef.current;
    if (!root) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let segments: { element: SVGGeometryElement; distance: number }[] = [];
    let frame = 0;
    const paint = (time: number) => {
      const travel = reducedMotion.matches ? 0 : time * 0.02;
      for (const { element, distance } of segments) {
        element.style.strokeDashoffset = String((distance - travel) % 18);
      }
    };
    const measure = () => {
      let distance = 0;
      segments = [];
      const pipelineRow = root.querySelectorAll(".lr-pipeline-row");
      pipelineRow.forEach((row) => {
        const selector = row.classList.contains("is-on")
          ? ".lr-pipeline-route .lr-pipeline-route__flow"
          : ".lr-pipeline-bypass .lr-pipeline-route__flow";
        row
          .querySelectorAll<SVGGeometryElement>(selector)
          .forEach((element) => {
            segments.push({ element, distance });
            distance += element.getTotalLength();
          });
      });
      paint(performance.now());
    };
    const tick = (time: number) => {
      paint(time);
      frame = requestAnimationFrame(tick);
    };
    const updateMotion = () => {
      cancelAnimationFrame(frame);
      paint(performance.now());
      if (!reducedMotion.matches) frame = requestAnimationFrame(tick);
    };
    const observer = new ResizeObserver(measure);
    root
      .querySelectorAll(".lr-pipeline-row")
      .forEach((row) => observer.observe(row));
    measure();
    updateMotion();
    reducedMotion.addEventListener("change", updateMotion);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      reducedMotion.removeEventListener("change", updateMotion);
    };
  }, [enabled, verifyOn, coverOn, segOn, audioOn, crfOn, archiveOn]);

  return (
    <Form
      form={form}
      layout="vertical"
      size="small"
      className="lr-pipeline-config"
      onValuesChange={onValuesChange}
    >
      <Form.Item label="启用后处理管线" name="enabled" valuePropName="checked">
        <Switch aria-label="启用后处理管线" />
      </Form.Item>
      {enabled ? (
        <>
          <Form.Item label="管线并发" name="maxConcurrency" extra="固定上限 2">
            <Select disabled options={[{ value: 2, label: "2" }]} />
          </Form.Item>
          <div ref={flowRef} className="lr-pipeline-flow">
            <div className="lr-pipeline-terminal">
              <i />
              录制完成
            </div>
            <StepCard
              num="1"
              label="完整性校验"
              tip="校验录制文件完整性，源文件损坏时终止管线并保留源文件"
              desc="完整性校验"
              on={verifyOn}
              switchNode={
                <Form.Item name="verify" valuePropName="checked" noStyle>
                  <Switch aria-label="完整性校验" />
                </Form.Item>
              }
            />
            <StepCard
              num="2"
              label="封面"
              tip="导出封面用于历史列表展示；默认开"
              desc="录制完成后导出封面"
              on={coverOn}
              switchNode={
                <Form.Item name="exportCover" valuePropName="checked" noStyle>
                  <Switch aria-label="封面" />
                </Form.Item>
              }
            />
            <StepCard
              num="3"
              label="切片"
              tip="按秒切分录制文件；默认 10 秒"
              desc={
                segOn && segVal > 0
                  ? `每 ${segVal} 秒切分录制文件`
                  : "按秒切分录制文件"
              }
              on={segOn}
              switchNode={
                <Form.Item
                  name="segmentEnabled"
                  valuePropName="checked"
                  noStyle
                >
                  <Switch aria-label="切片" />
                </Form.Item>
              }
            >
              {segOn ? (
                <Form.Item label="切片秒数" name="segmentSeconds">
                  <InputNumber min={1} max={86400} style={{ width: "100%" }} />
                </Form.Item>
              ) : null}
            </StepCard>
            <StepCard
              num="4"
              label="导出音频"
              tip="录制完成后自动导出 MP3）"
              desc="录制完成后自动导出 MP3"
              on={audioOn}
              switchNode={
                <Form.Item name="exportAudio" valuePropName="checked" noStyle>
                  <Switch aria-label="导出音频" />
                </Form.Item>
              }
            />
            <StepCard
              num="5"
              label="压缩"
              tip="转封装/压缩为 MP4；压缩档位越低质量越高"
              desc={
                crfOn && crfVal != null
                  ? `压缩档位 ${crfVal}，越低质量越高（0-51）`
                  : "视频文件压缩"
              }
              on={crfOn}
              switchNode={
                <Form.Item name="crfEnabled" valuePropName="checked" noStyle>
                  <Switch aria-label="压缩" />
                </Form.Item>
              }
            >
              {crfOn ? (
                <Form.Item label="压缩档位 CRF" name="crf">
                  <InputNumber min={0} max={51} style={{ width: "100%" }} />
                </Form.Item>
              ) : null}
            </StepCard>
            <StepCard
              num="6"
              label="归档"
              tip="复制视频到归档目录；未填路径时运行中跳过该步"
              desc="复制视频至归档目录，保留原文件；未填目录时跳过"
              on={archiveOn}
              switchNode={
                <Form.Item
                  name="archiveEnabled"
                  valuePropName="checked"
                  noStyle
                >
                  <Switch aria-label="归档" />
                </Form.Item>
              }
            >
              {archiveOn ? (
                <Form.Item label="归档目录">
                  <Space.Compact style={{ width: "100%" }}>
                    <Form.Item
                      name="archiveDirectory"
                      noStyle
                      validateTrigger="onBlur"
                      rules={[
                        {
                          validator: async (_, value?: string) => {
                            const directory = value?.trim();
                            if (!directory) return;
                            try {
                              await validateDirectory(directory);
                            } catch (error) {
                              throw new Error(
                                error instanceof ApiError
                                  ? describeError(error.code, error.message)
                                  : "目录不可用",
                              );
                            }
                          },
                        },
                      ]}
                    >
                      <Input placeholder="输入归档路径，或点击浏览选择目录" />
                    </Form.Item>
                    <Button onClick={() => setArchivePickerOpen(true)}>
                      浏览…
                    </Button>
                  </Space.Compact>
                </Form.Item>
              ) : null}
            </StepCard>
            <div className="lr-pipeline-terminal lr-pipeline-terminal--end">
              <i />
              处理完成
            </div>
          </div>
          <DirectoryPicker
            open={archivePickerOpen}
            initialPath={archiveDirectory?.trim() || undefined}
            onClose={() => setArchivePickerOpen(false)}
            onPick={(directory) => {
              form.setFieldValue("archiveDirectory", directory);
              save({ ...form.getFieldsValue(), archiveDirectory: directory });
            }}
          />
        </>
      ) : null}
    </Form>
  );
}
