import { useState } from "react";
import { App, Button, Popover, Space, Typography } from "antd";
import { openRecordingDirectory } from "../api/recordings";
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
  const { message } = App.useApp();
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
    ? "健康状态待同步"
    : health?.recovering
      ? "正在恢复录制"
      : streamHealthText(health ?? { recordingId: "", state: "unknown" });
  const action =
    health?.issue === "write_error"
      ? "检查保存目录、剩余空间和磁盘权限。"
      : health?.issue === "no_data"
        ? "检查网络和主播直播状态；中断明细会在恢复后保留。"
        : health?.issue === "low_bitrate"
          ? "直播码率持续降低；已收到的数据仍在保存。"
          : health?.issue === "media_stalled"
            ? "媒体时间暂未推进，请检查直播源。"
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
              连接中断或状态过期，正在等待同步。
            </Typography.Text>
          ) : (
            <>
              {health?.reason ? <span>{health.reason}</span> : null}
              {health?.recovering ? <span>正在自动恢复录制</span> : null}
              {health?.state === "good" &&
              !health.recovering &&
              (health.missingMs ?? 0) > 0 ? (
                <span>已恢复数据接收</span>
              ) : null}
              {(health?.state === "degraded" || health?.state === "empty") &&
              (health?.silenceMs ?? 0) >= 6000 ? (
                <span>
                  连续约 {Math.floor(health!.silenceMs! / 1000)} 秒未收到数据
                </span>
              ) : null}
              {(health?.missingMs ?? 0) > 0 ? (
                <span>
                  本次录制累计缺失 {Math.ceil(health!.missingMs! / 1000)} 秒
                </span>
              ) : null}
              {action ? (
                <Typography.Text type="secondary">{action}</Typography.Text>
              ) : null}
            </>
          )}
          {health?.qualityFallback ? (
            <span>清晰度已回退，仍按实际清晰度录制</span>
          ) : null}
          <Space>
            <Button
              size="small"
              onClick={() =>
                void refreshStreamHealth().catch(() =>
                  message.error("健康状态同步失败"),
                )
              }
            >
              刷新状态
            </Button>
            {health?.recordingId ? (
              <Button
                size="small"
                onClick={() =>
                  void openRecordingDirectory(health.recordingId).catch(() =>
                    message.error("无法打开保存目录"),
                  )
                }
              >
                保存目录
              </Button>
            ) : null}
          </Space>
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
          <span className="lr-quality-light__fallback">清晰度回退</span>
        ) : null}
      </button>
    </Popover>
  );
}

export function RoomQualityLight({ recordingId }: { recordingId?: string }) {
  const health = useStreamHealth(recordingId);
  return recordingId ? <QualityLight health={health} compact /> : null;
}
