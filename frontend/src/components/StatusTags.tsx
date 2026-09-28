import type { CSSProperties } from "react";
import { Tag, Tooltip } from "antd";
import type { MonitorState } from "../types/room";
import type {
  RecordingIntegrity,
  RecordingIntegrityState,
  RecordingState,
} from "../types/recording";

/**
 * 完成态标签的对比度达标配色：antd 预设 green（#389e0d/#f6ffed）仅 3.37:1，
 * 达不到孟菲斯可访问性条款的 4.5:1——深绿文字保证可读。
 */
const DONE_TAG_STYLE: CSSProperties = {
  color: "#1e7b21",
  background: "#f6ffed",
  borderColor: "#a9d98f",
};

const MONITOR_META: Record<MonitorState, { color: string; text: string }> = {
  idle: { color: "default", text: "空闲" },
  checking: { color: "processing", text: "检测中" },
  recording: { color: "red", text: "录制中" },
  reconnecting: { color: "orange", text: "重连中" },
  completed: { color: "green", text: "已完成" },
  failed: { color: "error", text: "失败" },
  disabled: { color: "default", text: "已停用" },
};

const RECORDING_META: Record<RecordingState, { color: string; text: string }> =
  {
    pending: { color: "default", text: "待启动" },
    recording: { color: "red", text: "录制中" },
    reconnecting: { color: "orange", text: "重连中" },
    awaiting_confirmation: { color: "gold", text: "待确认" },
    processing: { color: "geekblue", text: "处理中" },
    completed: { color: "green", text: "已完成" },
    failed: { color: "error", text: "失败" },
  };

const INTEGRITY_META: Record<
  RecordingIntegrity,
  { color: string; text: string }
> = {
  verified: { color: "green", text: "完整" },
  failed: { color: "error", text: "损坏" },
  pending: { color: "default", text: "校验中" },
};

export function MonitorStateTag({ state }: { state: MonitorState }) {
  const meta = MONITOR_META[state] ?? { color: "default", text: state };
  return (
    <Tag
      color={meta.color}
      style={meta.color === "green" ? DONE_TAG_STYLE : undefined}
    >
      {meta.text}
    </Tag>
  );
}

export function RecordingStateTag({ state }: { state: RecordingState }) {
  const meta = RECORDING_META[state] ?? { color: "default", text: state };
  return (
    <Tag
      color={meta.color}
      style={meta.color === "green" ? DONE_TAG_STYLE : undefined}
    >
      {meta.text}
    </Tag>
  );
}

export function IntegrityTag({
  integrity,
  integrityState,
  verifyQueuePosition,
  integrityError,
}: {
  integrity: RecordingIntegrity | null;
  /** 校验细分态：缺省时沿用旧三态显示，老数据/老后端展示不破版。 */
  integrityState?: RecordingIntegrityState;
  verifyQueuePosition?: number | null;
  integrityError?: string | null;
}) {
  if (integrityState === undefined) {
    if (!integrity) return <Tag>待校验</Tag>;
    const meta = INTEGRITY_META[integrity] ?? {
      color: "default",
      text: integrity,
    };
    return (
      <Tag
        color={meta.color}
        style={meta.color === "green" ? DONE_TAG_STYLE : undefined}
      >
        {meta.text}
      </Tag>
    );
  }
  if (integrityState === "pending") return <Tag>待校验</Tag>;
  if (integrityState === "queued")
    return (
      <Tag color="processing">
        {verifyQueuePosition ? `排队第 ${verifyQueuePosition} 位` : "排队中"}
      </Tag>
    );
  if (integrityState === "verifying")
    return <Tag color="processing">校验中</Tag>;
  if (integrityState === "unverifiable")
    return (
      <Tooltip
        title={integrityError || "环境或文件原因无法完成校验，可点校验重试"}
      >
        <Tag color="warning">无法校验</Tag>
      </Tooltip>
    );
  if (integrityState === "failed")
    return (
      <Tooltip title={integrityError || "校验失败，可点校验重试"}>
        <Tag color="error">校验失败</Tag>
      </Tooltip>
    );
  return (
    <Tag color="green" style={DONE_TAG_STYLE}>
      已校验
    </Tag>
  );
}
