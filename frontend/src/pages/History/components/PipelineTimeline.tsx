import { useEffect, useState } from "react";
import { App, Button, Popconfirm, Space, Tag, Typography, Tooltip } from "antd";
import {
  CheckOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  LoadingOutlined,
  MinusOutlined,
} from "@ant-design/icons";
import {
  fetchPipelineRun,
  openPipelineArtifact,
  retryPipeline,
  startPipeline,
} from "../../../api/pipeline";
import { usePipelineStore } from "../../../stores/pipelineStore";
import { describeError } from "../../../utils/errorMap";
import { ApiError } from "../../../types/error";
import { formatBytes, formatRelative } from "../../../utils/format";
const PIPELINE_STEP_ORDER = [
  "verify",
  "cover",
  "segment",
  "audio",
  "convert",
  "compress",
  "archive",
] as const;

import type {
  PipelineArtifact,
  PipelineRunStatus,
} from "../../../types/pipeline";

const STEP_LABEL: Record<string, string> = {
  verify: "完整性校验",
  cover: "封面",
  segment: "切片",
  // task #57/#58：管线自动导出音频（segment 后、compress 前）
  audio: "导出音频",
  convert: "格式转换",
  compress: "压缩",
  archive: "归档",
};

const STATUS_COLOR: Record<string, string> = {
  queued: "default",
  running: "processing",
  ok: "green",
  partial: "orange",
  failed: "red",
  skipped: "default",
};

const ARTIFACT_STATUS_TEXT: Record<PipelineArtifact["status"], string> = {
  queued: "排队中",
  running: "处理中",
  ok: "完成",
  failed: "失败",
  skipped: "跳过",
};

const RUN_META: Record<PipelineRunStatus, { color: string; text: string }> = {
  queued: { color: "default", text: "排队中" },
  running: { color: "processing", text: "运行中" },
  ok: { color: "green", text: "完成" },
  partial: { color: "orange", text: "部分完成" },
  failed: { color: "red", text: "失败" },
};

export default function PipelineTimeline({
  recordingId,
}: {
  recordingId: string;
}) {
  const { message } = App.useApp();
  const [retrying, setRetrying] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [starting, setStarting] = useState(false);
  const run = usePipelineStore((state) => state.runs[recordingId] ?? null);
  const setSnapshot = usePipelineStore((state) => state.setSnapshot);

  const load = async () => {
    try {
      setSnapshot(recordingId, await fetchPipelineRun(recordingId));
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "管线详情加载失败",
      );
    }
  };

  useEffect(() => {
    void load();
  }, [recordingId]);

  useEffect(() => {
    if (run?.run?.status !== "running") return;
    // SSE 是主通道；运行期间做低频校验，覆盖服务端在单步收尾时尚未广播
    // pipeline:updated 的窗口，避免详情抽屉停在旧快照。
    const timer = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 2_000);
    return () => clearInterval(timer);
  }, [run?.run?.status]);

  const doRetry = async () => {
    setRetrying(true);
    try {
      const detail = await retryPipeline(recordingId);
      if (detail.run) {
        setSnapshot(recordingId, detail);
        message.success("已重新执行管线");
      } else {
        message.success("已加入管线队列");
        await load();
      }
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "重试失败",
      );
    } finally {
      setRetrying(false);
    }
  };

  const doStart = async () => {
    setStarting(true);
    try {
      const detail = await startPipeline(recordingId);
      if (detail.run) {
        setSnapshot(recordingId, detail);
        message.success("已启动管线");
      } else {
        message.success("已加入管线队列");
        await load();
      }
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : e instanceof Error && e.message
            ? e.message
            : "启动失败",
      );
    } finally {
      setStarting(false);
    }
  };

  if (!run || !run.run) {
    return (
      <Space orientation="vertical" size={8}>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          该录制未参与后处理管线。
        </Typography.Paragraph>
        <Button
          size="small"
          type="primary"
          loading={starting}
          onClick={() => void doStart()}
        >
          启动管线
        </Button>
      </Space>
    );
  }

  const meta = RUN_META[run.run.status];
  const canRetry = run.run.status === "failed" || run.run.status === "partial";

  // task #58：开关关闭时也要展示「音频 · 未启用」节点（run 快照 exportAudio === false
  // 且 BE 未产出 audio artifact 时合成一个展示节点；老 run 无该键不显示）。
  const artifacts = [...run.artifacts];
  const hasAudio = artifacts.some((a) => a.step === "audio");
  const configSnapshot = run.run.configSnapshot as {
    exportAudio?: boolean;
    segmentSeconds?: number;
    archiveDirectory?: string;
  } | null;
  // exportAudio 是后来新增的配置；旧 run 快照缺字段时沿用历史默认值 false。
  const audioOff = configSnapshot?.exportAudio !== true;
  if (!hasAudio && audioOff) {
    const virtualAudio: PipelineArtifact = {
      id: "audio-disabled",
      runId: run.run.id,
      step: "audio",
      status: "skipped",
      path: null,
      sizeBytes: null,
      error: null,
      startedAt: null,
      endedAt: null,
    };
    const segIdx = artifacts.map((a) => a.step).lastIndexOf("segment");
    const cmpIdx = artifacts.findIndex(
      (a) => a.step === "convert" || a.step === "compress",
    );
    const insertAt =
      segIdx >= 0 ? segIdx + 1 : cmpIdx >= 0 ? cmpIdx : artifacts.length;
    artifacts.splice(insertAt, 0, virtualAudio);
  }
  // segment/archive 在关闭时后端不会创建 artifact；为与设置页的完整流程对齐，
  // 仅在该次运行的配置快照明确关闭时补一个“跳过”节点。
  const virtualSkippedStep = (step: "segment" | "archive") => {
    if (artifacts.some((artifact) => artifact.step === step)) return;
    const disabled =
      step === "segment"
        ? (configSnapshot?.segmentSeconds ?? 0) <= 0
        : !configSnapshot?.archiveDirectory;
    if (!disabled) return;
    artifacts.push({
      id: `${step}-disabled`,
      runId: run.run!.id,
      step,
      status: "skipped",
      path: null,
      sizeBytes: null,
      error: null,
      startedAt: null,
      endedAt: null,
    });
  };
  virtualSkippedStep("segment");
  virtualSkippedStep("archive");
  // sidecar 是系统内部写入录制信息的实现细节，不是设置页的可配置步骤。
  // 详情页仅展示设置中的七个流程，避免用户看到两套不一致的管线定义。
  const visibleArtifacts = artifacts
    .filter(
      (
        artifact,
      ): artifact is PipelineArtifact & {
        step: (typeof PIPELINE_STEP_ORDER)[number];
      } => artifact.step !== "sidecar",
    )
    .sort(
      (a, b) =>
        PIPELINE_STEP_ORDER.indexOf(a.step) -
        PIPELINE_STEP_ORDER.indexOf(b.step),
    );
  const failedSteps = visibleArtifacts.filter((a) => a.status === "failed");

  const completedCount = visibleArtifacts.filter(
    (a) => a.status === "ok",
  ).length;
  // 后端进度还包含隐藏的 sidecar 内部步骤；详情页按可见的设置流程重算，
  // 保证进度条与七个展示节点一致。
  const progress = Math.round(
    (completedCount / Math.max(visibleArtifacts.length, 1)) * 100,
  );

  return (
    <section className="pipeline-section pipeline-run-section">
      <div className="pipeline-run-summary">
        <div className="pipeline-section-heading">
          <Typography.Title level={5}>处理进度</Typography.Title>
        </div>
        <div className="pipeline-status-row">
          <Tag color={meta.color} className="pipeline-status-tag">
            {meta.text}
          </Tag>
          <Typography.Text type="secondary" className="pipeline-summary-meta">
            {run.run.status === "running"
              ? `第 ${completedCount + 1}/${PIPELINE_STEP_ORDER.length} 步`
              : `${completedCount}/${visibleArtifacts.length} 个步骤完成`}
          </Typography.Text>
          {run.run.startedAt ? (
            <Typography.Text type="secondary" className="pipeline-summary-meta">
              开始于 {formatRelative(run.run.startedAt)}
            </Typography.Text>
          ) : null}
        </div>
        {run.run.status === "running" ? (
          <div className="pipeline-progress-row">
            <div
              className="pipeline-progress-track"
              aria-label={`管线进度 ${progress}%`}
            >
              <span style={{ width: `${progress}%` }} />
            </div>
            <Typography.Text className="pipeline-progress-percent">
              {progress}%
            </Typography.Text>
          </div>
        ) : null}
        {run.run.status === "running" ? (
          <Typography.Text className="pipeline-progress-copy">
            {run.run.progressStep
              ? run.run.progressStep === "sidecar"
                ? "正在准备下一步骤"
                : `正在${STEP_LABEL[run.run.progressStep] ?? run.run.progressStep}`
              : "正在准备任务"}
            {run.run.etaSeconds
              ? `，预计还需 ${Math.ceil(run.run.etaSeconds / 60)} 分钟`
              : ""}
          </Typography.Text>
        ) : null}
        {run.run.status === "running" &&
        run.run.heartbeatAt &&
        now - new Date(run.run.heartbeatAt).getTime() > 30_000 ? (
          <Tooltip title={`${formatRelative(run.run.heartbeatAt)}`}>
            <Tag color="warning" className="pipeline-stalled-tag">
              进度暂未更新
            </Tag>
          </Tooltip>
        ) : null}
      </div>

      {canRetry ? (
        <div className="pipeline-retry-callout">
          <div>
            <Typography.Text strong>需要重新处理</Typography.Text>
            <Typography.Paragraph type="secondary">
              将执行：
              {visibleArtifacts
                .filter((a) => !(a.status === "ok" && a.path))
                .map((a) => STEP_LABEL[a.step] ?? a.step)
                .filter((v, i, arr) => arr.indexOf(v) === i)
                .join("、") || "（产物齐全，无需重跑）"}
            </Typography.Paragraph>
          </div>
          <Popconfirm
            title="重新执行管线？将基于当前配置生成新任务"
            onConfirm={() => void doRetry()}
          >
            <Button size="small" loading={retrying}>
              重试{failedSteps.length > 0 ? `（${failedSteps.length}）` : ""}
            </Button>
          </Popconfirm>
        </div>
      ) : null}

      <div className="pipeline-flow" aria-label="处理流水线">
        {visibleArtifacts.map((artifact) => (
          <ArtifactItem
            key={artifact.id}
            artifact={artifact}
            recordingId={recordingId}
            stepProgress={stepProgressFor(artifact.step, run.run)}
          />
        ))}
      </div>
    </section>
  );
}

function ArtifactItem({
  artifact,
  recordingId,
  stepProgress,
}: {
  artifact: PipelineArtifact;
  recordingId: string;
  stepProgress: number | null;
}) {
  const { message } = App.useApp();
  const statusText = ARTIFACT_STATUS_TEXT[artifact.status];
  const skipReason =
    artifact.status === "skipped" && artifact.error
      ? `（${artifact.error}）`
      : "";
  return (
    <div className={`pipeline-flow-stage pipeline-step-${artifact.status}`}>
      <div className="pipeline-flow-node">{statusIcon(artifact.status)}</div>
      <div className="pipeline-step-main">
        <div className="pipeline-step-topline">
          <Typography.Text strong>
            {STEP_LABEL[artifact.step] ?? artifact.step}
          </Typography.Text>
          <Tag
            color={STATUS_COLOR[artifact.status]}
            className={
              artifact.status === "skipped" ? "pipeline-skipped-tag" : undefined
            }
          >
            {statusText}
            {skipReason}
          </Tag>
        </div>
        <div className="pipeline-step-details">
          {artifact.sizeBytes != null ? (
            <Typography.Text type="secondary">
              {formatBytes(artifact.sizeBytes)}
            </Typography.Text>
          ) : null}
          {artifact.status === "ok" && artifact.endedAt ? (
            <Typography.Text type="secondary">
              完成于 {formatRelative(artifact.endedAt)}
            </Typography.Text>
          ) : null}
        </div>
        {stepProgress != null ? (
          <div className="pipeline-step-progress">
            <div
              className="pipeline-step-progress-track"
              aria-label={`${STEP_LABEL[artifact.step] ?? artifact.step}进度 ${stepProgress}%`}
            >
              <span style={{ width: `${stepProgress}%` }} />
            </div>
            <Typography.Text className="pipeline-step-progress-percent">
              {stepProgress}%
            </Typography.Text>
          </div>
        ) : null}
        {artifact.path ? (
          <>
            <Typography.Text
              type="secondary"
              className="pipeline-path"
              ellipsis={{ tooltip: artifact.path }}
            >
              {artifact.path}
            </Typography.Text>
            <Space size={4} className="pipeline-file-actions">
              <Button
                size="small"
                onClick={() =>
                  void openPipelineArtifact(
                    recordingId,
                    artifact.id,
                    "directory",
                  ).catch((error) =>
                    message.error(
                      error instanceof ApiError
                        ? describeError(error.code, error.message)
                        : "无法打开目录",
                    ),
                  )
                }
              >
                打开目录
              </Button>
              <Button
                size="small"
                onClick={() =>
                  void openPipelineArtifact(
                    recordingId,
                    artifact.id,
                    "file",
                  ).catch((error) =>
                    message.error(
                      error instanceof ApiError
                        ? describeError(error.code, error.message)
                        : "无法打开文件",
                    ),
                  )
                }
              >
                打开文件
              </Button>
            </Space>
          </>
        ) : null}
        {artifact.error ? (
          <Typography.Text type="danger" className="pipeline-error">
            {artifact.error}
          </Typography.Text>
        ) : null}
      </div>
    </div>
  );
}

function statusIcon(status: PipelineArtifact["status"]) {
  if (status === "ok") return <CheckOutlined />;
  if (status === "running") return <LoadingOutlined />;
  if (status === "failed") return <CloseOutlined />;
  if (status === "skipped") return <MinusOutlined />;
  return <ClockCircleOutlined />;
}

function stepProgressFor(
  step: PipelineArtifact["step"],
  run: Awaited<ReturnType<typeof fetchPipelineRun>>["run"],
): number | null {
  if (
    !run ||
    run.status !== "running" ||
    run.progressStep !== step ||
    run.progressPct == null
  )
    return null;
  const rangeStart = step === "convert" ? 62 : step === "compress" ? 75 : null;
  return rangeStart == null
    ? null
    : Math.max(
        0,
        Math.min(100, Math.round(((run.progressPct - rangeStart) / 13) * 100)),
      );
}
