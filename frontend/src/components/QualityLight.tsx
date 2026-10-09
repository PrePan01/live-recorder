import { useState } from "react";
import { Popover, Space, Typography } from "antd";
import { useStreamHealth } from "../hooks/useStreamHealth";
import { useDisplayClock } from "../hooks/useDisplayClock";
import { useServiceStore } from "../stores/serviceStore";
import {
  refreshStreamHealth,
  streamHealthText,
} from "../stores/streamHealthStore";
import type { StreamHealth } from "../types/streamHealth";

const STATE_COLOR = {
  good: "#22c55e",
  degraded: "#f59e0b",
  empty: "#ef4444",
  unknown: "#9ca3af",
};

export function QualityLight({
  health,
  compact = false,
}: {
  health: StreamHealth | null;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const connected = useServiceStore((s) => s.sseConnected);
  const now = useDisplayClock(open);
  const stale =
    !connected || Boolean(health?.sampledAt && now - health.sampledAt > 45_000);
  const state = stale
    ? "unknown"
    : health?.recovering && health.state === "good"
      ? "degraded"
      : (health?.state ?? "unknown");
  const label = stale
    ? "暂时无法确认录制状态"
    : health?.recovering
      ? "正在恢复录制"
      : streamHealthText(health ?? { recordingId: "", state: "unknown" });
  const action =
    health?.issue === "write_error"
      ? "请检查保存目录的空间和写入权限"
      : health?.issue === "no_data"
        ? "请检查网络和主播的直播状态"
        : health?.issue === "low_bitrate"
          ? "请检查网络和主播的直播状态"
          : health?.issue === "media_stalled"
            ? "请检查主播的直播状态"
            : null;
  if (!health || health.active === false || state === "unknown") return null;

  return (
    <Popover
      trigger={["hover", "click"]}
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) void refreshStreamHealth().catch(() => undefined);
      }}
      content={
        <Space orientation="vertical" size={6} style={{ maxWidth: 300 }}>
          <Typography.Text strong>{label}</Typography.Text>
          {stale ? (
            <Typography.Text type="secondary">
              暂时无法确认录制状态
            </Typography.Text>
          ) : (
            <>
              {health?.reason ? <span>{health.reason}</span> : null}
              {health?.recovering ? <span>正在自动恢复录制</span> : null}
              {health?.state === "good" &&
              !health.recovering &&
              (health.missingMs ?? 0) > 0 ? (
                <span>已恢复接收直播数据</span>
              ) : null}
              {(health?.state === "degraded" || health?.state === "empty") &&
              (health?.silenceMs ?? 0) >= 6000 ? (
                <span>
                  已连续约 {Math.floor(health!.silenceMs! / 1000)}{" "}
                  秒未收到直播数据
                </span>
              ) : null}
              {(health?.missingMs ?? 0) > 0 ? (
                <span>
                  本次录制共中断约 {Math.ceil(health!.missingMs! / 1000)} 秒
                </span>
              ) : null}
              {action ? (
                <Typography.Text type="secondary">{action}</Typography.Text>
              ) : null}
            </>
          )}
          {health?.qualityFallback ? <span>当前录制清晰度低于设置</span> : null}
        </Space>
      }
    >
      <button
        type="button"
        className="lr-quality-light"
        aria-label={`录制健康：${label}`}
      >
        <i style={{ background: STATE_COLOR[state] }} aria-hidden="true" />
        {!compact && (state === "degraded" || state === "empty") ? (
          <span>{label}</span>
        ) : null}
        {!compact && health?.qualityFallback ? (
          <span className="lr-quality-light__fallback">清晰度降低</span>
        ) : null}
      </button>
    </Popover>
  );
}

export function RoomQualityLight({ recordingId }: { recordingId?: string }) {
  const health = useStreamHealth(recordingId);
  return recordingId ? <QualityLight health={health} compact /> : null;
}
