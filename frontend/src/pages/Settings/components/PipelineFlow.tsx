import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { InputNumber, Select, Switch, Tooltip } from "antd";
import {
  FIRST_ENABLE_CRF,
  FIRST_ENABLE_SEGMENT_SECONDS,
} from "../../../utils/pipelineConfigForm";
import { useSettingsModelContext } from "../model/SettingsContext";
import {
  OrdinaryRow,
  SaveStatus,
  SettingControl,
  SettingsRow,
} from "./SettingsPrimitives";

function StepFeedback({ id }: { id: string }) {
  return (
    <div className="lr-pipeline-feedback">
      <SaveStatus id={id} />
    </div>
  );
}
/** 每个步骤共享左侧总线；启用时从卡片左侧进出，关闭时由总线直通。 */
function StepCard({
  id,
  num,
  label,
  tip,
  desc,
  on,
  switchNode,
  children,
}: {
  id: string;
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
      id={id}
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
          <div className="lr-pipeline-step__copy">
            <Tooltip title={tip}>
              <span id={`${id}-label`} className="lr-pipeline-step__name">
                {label}
              </span>
            </Tooltip>
            <div className="lr-pipeline-step__desc">{desc}</div>
          </div>
          {switchNode}
        </div>
        {children ? (
          <div className="lr-pipeline-step__ctrl">{children}</div>
        ) : null}
        <StepFeedback id={id} />
      </div>
    </div>
  );
}

export default function PipelineFlow({
  archiveEditor,
}: {
  archiveEditor: ReactNode;
}) {
  const model = useSettingsModelContext();
  const flowRef = useRef<HTMLDivElement>(null);
  const [archiveEditing, setArchiveEditing] = useState(false);
  const [crfInput, setCrfInput] = useState<{ value: number | null }>();
  const enabled = model.value("pipeline-enabled") === true;
  const verifyOn = model.value("pipeline-verify") === true;
  const coverOn = model.value("pipeline-cover") === true;
  const audioOn = model.value("pipeline-audio") === true;
  const segRaw = model.value("pipeline-segment");
  const segVal = Number(segRaw ?? 0);
  const segOn = segRaw !== undefined && segRaw !== 0;
  const crfVal = model.value("pipeline-crf") as number | null | undefined;
  const crfOn = crfVal !== null && crfVal !== undefined;
  const outputFormat = String(model.value("pipeline-format") ?? "source");
  const deleteSourceAfterConvert = model.value("pipeline-delete") === true;
  const archiveDirectory = String(model.value("archive-directory") ?? "");
  const archiveOn = archiveEditing || archiveDirectory.length > 0;
  const disabled = !enabled || !model.models.pipeline;
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
  }, [
    enabled,
    verifyOn,
    coverOn,
    segOn,
    audioOn,
    outputFormat,
    crfOn,
    archiveOn,
  ]);

  return (
    <div className="lr-pipeline-config">
      <OrdinaryRow id="pipeline-enabled" />
      <OrdinaryRow id="encoding-mode" />
      <details
        open={enabled}
        data-settings-details
        className="lr-pipeline-details"
      >
        <summary>处理步骤</summary>
        <div className="lr-pipeline-concurrency">
          <label htmlFor="pipeline-concurrency">管线并发</label>
          <Select
            id="pipeline-concurrency"
            aria-label="管线并发"
            disabled
            value={Number(model.models.pipeline?.maxConcurrency ?? 2)}
            options={[{ value: 2, label: "2" }]}
          />
          <span>固定上限 2</span>
        </div>
        <div ref={flowRef} className="lr-pipeline-flow">
          <div className="lr-pipeline-terminal">
            <i />
            录制完成
          </div>
          <StepCard
            id="pipeline-verify"
            num="1"
            label="完整性校验"
            tip="校验录制文件完整性，源文件损坏时终止管线并保留源文件"
            desc="完整性校验"
            on={verifyOn}
            switchNode={<SettingControl id="pipeline-verify" />}
          />
          <StepCard
            id="pipeline-cover"
            num="2"
            label="封面"
            tip="导出封面用于历史列表展示；默认开"
            desc="录制完成后导出封面"
            on={coverOn}
            switchNode={<SettingControl id="pipeline-cover" />}
          />
          <StepCard
            id="pipeline-segment"
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
              <Switch
                aria-labelledby="pipeline-segment-label"
                disabled={disabled}
                checked={segOn}
                onChange={(on) =>
                  model.change(
                    "pipeline-segment",
                    on ? FIRST_ENABLE_SEGMENT_SECONDS : 0,
                  )
                }
              />
            }
          >
            {segOn && (
              <div className="lr-pipeline-field">
                <label htmlFor="pipeline-segment-control">切片秒数</label>
                <InputNumber
                  id="pipeline-segment-control"
                  aria-label="切片秒数"
                  min={1}
                  max={86400}
                  disabled={disabled}
                  value={segRaw as number | null}
                  onChange={(v) => model.change("pipeline-segment", v, 500)}
                />
              </div>
            )}
          </StepCard>
          <StepCard
            id="pipeline-audio"
            num="4"
            label="导出音频"
            tip="录制完成后自动导出 MP3"
            desc="录制完成后自动导出 MP3"
            on={audioOn}
            switchNode={<SettingControl id="pipeline-audio" />}
          />
          <StepCard
            id="pipeline-format"
            num="5"
            label="格式转换"
            tip="录制完成后可无损转为 MP4；可选择删除源文件"
            desc={
              outputFormat === "mp4"
                ? deleteSourceAfterConvert
                  ? "无损转换为 MP4，完成后删除源文件"
                  : "无损转换为 MP4，保留源文件"
                : "保留原格式"
            }
            on={outputFormat === "mp4"}
            switchNode={
              <div className="lr-pipeline-format-control">
                <SettingControl id="pipeline-format" />
              </div>
            }
          >
            {outputFormat === "mp4" && (
              <SettingsRow
                id="pipeline-delete"
                help="MP4 转换成功后删除录制源文件"
              >
                <SettingControl id="pipeline-delete" />
              </SettingsRow>
            )}
          </StepCard>
          <StepCard
            id="pipeline-crf"
            num="6"
            label="压缩"
            tip="视频文件压缩；压缩档位越低质量越高"
            desc={
              crfOn
                ? `压缩档位 ${crfVal}，越低质量越高（0-51）`
                : "视频文件压缩"
            }
            on={crfOn}
            switchNode={
              <Switch
                aria-labelledby="pipeline-crf-label"
                disabled={disabled}
                checked={crfOn}
                onChange={(on) => {
                  setCrfInput(undefined);
                  model.queue.discard("pipeline-crf");
                  model.change("pipeline-crf", on ? FIRST_ENABLE_CRF : null);
                }}
              />
            }
          >
            {crfOn && (
              <div className="lr-pipeline-field">
                <label htmlFor="pipeline-crf-control">压缩档位 CRF</label>
                <InputNumber
                  id="pipeline-crf-control"
                  aria-label="压缩档位 CRF"
                  min={0}
                  max={51}
                  disabled={disabled}
                  value={crfInput && model.states["pipeline-crf"]?.phase === "invalid" ? crfInput.value : crfVal}
                  onChange={(v) => {
                    if (v === null) {
                      setCrfInput({ value: null });
                      model.queue.stage("pipeline-crf", "请输入 0–51 范围内的整数");
                    } else {
                      setCrfInput(undefined);
                      model.change("pipeline-crf", v, 500);
                    }
                  }}
                />
              </div>
            )}
          </StepCard>
          <StepCard
            id="pipeline-archive"
            num="7"
            label="归档"
            tip="复制视频到归档目录；未填路径时运行中跳过该步"
            desc="复制视频至归档目录，保留原文件；未填目录时跳过"
            on={archiveOn}
            switchNode={
              <Switch
                aria-labelledby="pipeline-archive-label"
                disabled={disabled}
                checked={archiveOn}
                onChange={(on) => {
                  setArchiveEditing(on);
                  if (!on) {
                    model.discard("archive-directory", [
                      "archive-directory",
                    ]);
                    model.change("archive-directory", "");
                  }
                }}
              />
            }
          >
            <details
              open={archiveOn}
              className="lr-pipeline-archive-editor"
              data-settings-details
            >
              <summary>归档目录</summary>
              {archiveEditor}
            </details>
          </StepCard>
          <div className="lr-pipeline-terminal lr-pipeline-terminal--end">
            <i />
            处理完成
          </div>
        </div>
      </details>
    </div>
  );
}
