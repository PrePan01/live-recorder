import { useEffect, useState } from "react";
import {
  App,
  Button,
  Popconfirm,
  Space,
  Tag,
  Timeline,
  Typography,
} from "antd";
import { fetchPipelineRun, retryPipeline } from "../../../api/pipeline";
import { bridge } from "../../../stores/bootStore";
import { describeError } from "../../../utils/errorMap";
import { ApiError } from "../../../types/error";
import { formatBytes, formatRelative } from "../../../utils/format";
import type {
  PipelineArtifact,
  PipelineRunStatus,
} from "../../../types/pipeline";

const STEP_LABEL: Record<string, string> = {
  verify: "完整性校验",
  sidecar: "元数据生成",
  cover: "封面提取",
  segment: "切片",
  // task #57/#58：管线自动导出音频（segment 后、compress 前）
  audio: "音频",
  compress: "压缩转封装",
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
  const [run, setRun] = useState<Awaited<
    ReturnType<typeof fetchPipelineRun>
  > | null>(null);
  const [retrying, setRetrying] = useState(false);

  const load = async () => {
    try {
      setRun(await fetchPipelineRun(recordingId));
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

  if (!run || !run.run) {
    return (
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        该录制未参与后处理管线。
      </Typography.Paragraph>
    );
  }

  const doRetry = async () => {
    setRetrying(true);
    try {
      setRun(await retryPipeline(recordingId));
      message.success("已重新执行管线");
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "重试失败",
      );
    } finally {
      setRetrying(false);
    }
  };

  const meta = RUN_META[run.run.status];
  const failedSteps = run.artifacts.filter((a) => a.status === "failed");
  const canRetry = run.run.status === "failed" || run.run.status === "partial";

  // task #58：开关关闭时也要展示「音频 · 未启用」节点（run 快照 exportAudio === false
  // 且 BE 未产出 audio artifact 时合成一个展示节点；老 run 无该键不显示）。
  const artifacts = [...run.artifacts];
  const hasAudio = artifacts.some((a) => a.step === "audio");
  const audioOff =
    (run.run.configSnapshot as { exportAudio?: boolean } | null)
      ?.exportAudio === false;
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
    const cmpIdx = artifacts.findIndex((a) => a.step === "compress");
    const insertAt =
      segIdx >= 0 ? segIdx + 1 : cmpIdx >= 0 ? cmpIdx : artifacts.length;
    artifacts.splice(insertAt, 0, virtualAudio);
  }

  return (
    <Space orientation="vertical" style={{ width: "100%" }} size={12}>
      <Space>
        <Tag color={meta.color}>{meta.text}</Tag>
        {run.run.startedAt ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            开始 {formatRelative(run.run.startedAt)}
          </Typography.Text>
        ) : null}
        {canRetry ? (
          <Popconfirm
            title="重新执行管线？将基于当前配置生成新任务"
            onConfirm={() => void doRetry()}
          >
            <Button size="small" loading={retrying}>
              重试
              {failedSteps.length > 0
                ? `失败步骤（${failedSteps.length}）`
                : ""}
            </Button>
          </Popconfirm>
        ) : null}
      </Space>
      <Timeline
        items={artifacts.map((a) => ({
          color: STATUS_COLOR[a.status],
          children: <ArtifactItem artifact={a} />,
        }))}
      />
    </Space>
  );
}

function ArtifactItem({ artifact }: { artifact: PipelineArtifact }) {
  // task #58：音频步关闭（BE 产出/合成的 skipped）显示「未启用」而非原始态名
  const statusText =
    artifact.step === "audio" && artifact.status === "skipped"
      ? "未启用"
      : artifact.status;
  return (
    <div>
      <Space size={8} wrap>
        <Typography.Text strong>
          {STEP_LABEL[artifact.step] ?? artifact.step}
        </Typography.Text>
        <Tag
          color={STATUS_COLOR[artifact.status]}
          style={{ marginInlineEnd: 0 }}
        >
          {statusText}
        </Tag>
        {artifact.sizeBytes != null ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatBytes(artifact.sizeBytes)}
          </Typography.Text>
        ) : null}
        {artifact.path ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
            {artifact.path}
          </Typography.Text>
        ) : null}
        {artifact.step === "audio" &&
        artifact.status === "ok" &&
        artifact.path ? (
          <Button
            size="small"
            type="link"
            style={{ paddingInline: 0, fontSize: 12 }}
            onClick={() => {
              // 复用现有本地文件定位通道（同 History/UploadStatus 的 bridge.openPath 口径）
              void bridge.openPath(artifact.path!).catch(() => {
                window.open(artifact.path!, "_blank", "noopener,noreferrer");
              });
            }}
          >
            定位/打开
          </Button>
        ) : null}
      </Space>
      {artifact.error ? (
        <Typography.Text
          type="danger"
          style={{ display: "block", fontSize: 12 }}
        >
          {artifact.error}
        </Typography.Text>
      ) : null}
      {artifact.endedAt ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          完成 {formatRelative(artifact.endedAt)}
        </Typography.Text>
      ) : null}
    </div>
  );
}
