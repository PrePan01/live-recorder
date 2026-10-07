import type { Dispatch, SetStateAction } from "react";
import type { ReactNode } from "react";
import {
  Button,
  Popconfirm,
  Popover,
  Progress,
  Space,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  CommentOutlined,
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { ApiError } from "../types/error";
import { playRecording } from "../api/recordings";
import { failurePrimaryText } from "./failureReason";
import { describeError } from "./errorMap";
import { formatBytes, formatDurationMs, formatTime } from "./format";
import {
  IntegrityTag,
  RecordingStateTag,
} from "../components/StatusTags";
import { PlatformLogoTag } from "../components/PlatformLogo";
import {
  describeEndReason,
  isInterruptedEnd,
} from "./recordingEndReason";
import {
  uploadPhaseLabel,
  uploadPhaseText,
} from "./uploadProgress";
import {
  describeUploadError,
  classifyUploadError,
} from "./uploadError";
import type { Recording } from "../types/recording";
import GapDetail from "../pages/History/components/GapDetail";
import EditableRecordingTitle from "../pages/History/components/EditableRecordingTitle";
import { QUALITY_LABEL, phaseOfUpload, openExternalUrl } from "./historyUtils";

type MessageApi = ReturnType<typeof import("antd").App.useApp>["message"];

export interface RecordingColumnsDeps {
  roomLabel: (r: Recording) => ReactNode;
  openDirectory: (id: string) => Promise<unknown>;
  removeRecording: (id: string) => Promise<unknown>;
  renameRecording: (id: string, title: string) => Promise<void>;
  message: MessageApi;
  handleManualUpload: (id: string) => Promise<unknown>;
  handleUploadErrorDetail: (recording: Recording) => void;
  setRenaming: Dispatch<SetStateAction<Recording | null>>;
  setRenameValue: Dispatch<SetStateAction<string>>;
  setPipelineRec: Dispatch<SetStateAction<Recording | null>>;
  retryUploadFor: (recordingId: string) => Promise<void>;
  openDanmakuPlayer: (r: Recording) => void;
}

export function buildRecordingColumns(
  deps: RecordingColumnsDeps,
): ColumnsType<Recording> {
  const {
    roomLabel,
    openDirectory,
    removeRecording,
    renameRecording,
    message,
    handleManualUpload,
    handleUploadErrorDetail,
    setRenaming,
    setRenameValue,
    setPipelineRec,
    retryUploadFor,
  } = deps;
  return [
    {
      title: "直播间",
      dataIndex: "roomId",
      width: 200,
      ellipsis: true,
      render: (_id: string, r) => (
        <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
          <PlatformLogoTag platform={r.platform} />
          <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }}>
            {roomLabel(r)}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: "标题",
      dataIndex: "streamTitle",
      width: 320,
      ellipsis: true,
      render: (t: string, r) => (
        <div className="lr-history-title-cell">
          <EditableRecordingTitle
            id={r.id}
            title={t}
            onSave={renameRecording}
          />
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            onClick={() => {
              setRenaming(r);
              setRenameValue(r.streamTitle);
            }}
          />
        </div>
      ),
    },
    { title: "开始", dataIndex: "startedAt", width: 120, render: formatTime },
    { title: "结束", dataIndex: "endedAt", width: 120, render: formatTime },
    {
      title: "时长",
      width: 85,
      render: (_, r) =>
        // 可播真值优先：墙钟跨度含无数据时段会虚高；老数据无 metadata 时标注占位，不回退墙钟。
        r.metadata?.durationMs != null ? formatDurationMs(r.metadata.durationMs) : "—",
    },
    {
      title: "清晰度",
      dataIndex: "quality",
      width: 70,
      render: (q: string | null, r: Recording) => {
        if (!q) return "-";
        const label = QUALITY_LABEL[q] ?? q;
        const expected = r.expectedQuality;
        if (!expected || expected === q) return label;
        const hint = `设置默认清晰度为 ${QUALITY_LABEL[expected] ?? expected}，本次实际录制画质为 ${label}（该直播间未提供该档位，或当前账号未取得该清晰度权限）`;
        return (
          <Tooltip title={hint}>
            <span style={{ cursor: "help" }}>
              {label}{" "}
              <InfoCircleOutlined style={{ color: "#faad14", fontSize: 12 }} />
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: "完整性",
      dataIndex: "integrity",
      width: 80,
      render: (v: Recording["integrity"], r) => (
        <Space size={4}>
          <IntegrityTag
            integrity={v}
            integrityState={r.integrityState}
            verifyQueuePosition={r.verifyQueuePosition}
            integrityError={r.integrityError}
          />
          {v === "failed" && r.failureReason ? (
            <Tooltip title={`${r.failureReason.message}`}>
              <WarningOutlined style={{ color: "#ff4d4f" }} />
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: "状态",
      dataIndex: "state",
      width: 130,
      render: (s, r) => {
        const reason = describeEndReason(r.endReason);
        const exporting = s === "processing" && r.progressPercent != null;
        return (
          <Space direction="vertical" size={0}>
            <RecordingStateTag state={s} />
            {exporting ? (
              <div
                className="pipeline-step-progress"
                aria-label={`片段导出进度 ${r.progressPercent}%`}
              >
                <div className="pipeline-step-progress-track">
                  <span style={{ width: `${r.progressPercent}%` }} />
                </div>
                <Typography.Text className="pipeline-step-progress-percent">
                  导出中 {r.progressPercent}%
                </Typography.Text>
              </div>
            ) : null}
            {reason ? (
              <Typography.Text
                type={isInterruptedEnd(r.endReason) ? "warning" : "secondary"}
                style={{ fontSize: 12 }}
              >
                {reason}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: "大小",
      dataIndex: "fileSizeBytes",
      width: 95,
      render: (v: number) => formatBytes(v),
    },
    {
      title: "上传状态",
      dataIndex: "upload",
      width: 150,
      render: (u: Recording["upload"], r: Recording) => {
        if (!u) {
          const canUpload = r.state === "completed" && !!r.filePath;
          return (
            <Tooltip
              title={
                canUpload
                  ? "点击上传到 OpenList"
                  : "录制未完成或文件不存在，无法上传"
              }
            >
              <span>
                <Button
                  size="small"
                  type="link"
                  disabled={!canUpload}
                  onClick={() => void handleManualUpload(r.id)}
                >
                  上传
                </Button>
              </span>
            </Tooltip>
          );
        }
        const info = classifyUploadError(u.error);
        const detail =
          (u.status === "failed" && u.error
            ? info.action
            : describeUploadError(u.error)) ??
          (u.status === "running" && u.progress >= 99
            ? uploadPhaseText(
                "verifying",
                u.progress,
                u.updatedAt ?? r.endedAt ?? r.startedAt,
              )
            : u.remotePath);
        const node =
          u.status === "running" ? (
            <Space size={4}>
              <Tag color="processing">
                {uploadPhaseLabel(phaseOfUpload(u.progress), u.progress)}
              </Tag>
              <Progress
                percent={u.progress}
                size="small"
                style={{ width: 56 }}
              />
            </Space>
          ) : u.status === "failed" ? (
            u.error?.includes("源文件已删除") ? (
              <Tag color="red">源文件已删除</Tag>
            ) : (
              <Space size={4}>
                <Tag color="red">失败</Tag>
                <Button
                  size="small"
                  type="link"
                  onClick={() => void retryUploadFor(r.id)}
                >
                  重试
                </Button>
                <Button
                  size="small"
                  type="link"
                  onClick={() => handleUploadErrorDetail(r)}
                >
                  查看
                </Button>
              </Space>
            )
          ) : (
            <Tag
              color={
                u.status === "ok"
                  ? "green"
                  : u.status === "cancelled"
                    ? "default"
                    : "default"
              }
            >
              {u.status === "ok"
                ? "成功"
                : u.status === "cancelled"
                  ? "已取消"
                  : u.error
                    ? "等待重试"
                    : "排队"}
            </Tag>
          );
        if (u.status === "ok" && u.remotePath) {
          return (
            <Popover
              trigger="hover"
              content={
                <Typography.Link
                  href={u.remotePath}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => {
                    e.preventDefault();
                    if (u.remotePath) openExternalUrl(u.remotePath);
                  }}
                >
                  {u.remotePath}
                </Typography.Link>
              }
            >
              <span style={{ cursor: "pointer" }}>{node}</span>
            </Popover>
          );
        }
        return detail ? (
          <Tooltip title={detail}>
            <span style={{ cursor: "help" }}>{node}</span>
          </Tooltip>
        ) : (
          node
        );
      },
    },
    {
      title: "录制异常",
      dataIndex: "failureReason",
      width: 180,
      render: (f: Recording["failureReason"], r: Recording) => {
        const missingSeconds =
          r.missingMs && r.missingMs >= 1000
            ? Math.round(r.missingMs / 1000)
            : 0;
        if (!f && missingSeconds === 0 && !r.systemSleepInterrupted) return "-";
        return (
          <Space direction="vertical" size={0}>
            {f ? (
              <Typography.Text type="danger">
                {failurePrimaryText(f)}
              </Typography.Text>
            ) : null}
            {r.systemSleepInterrupted && f?.code !== "SYSTEM_SLEEP_INTERRUPTED" ? (
              <Typography.Text type="warning">系统休眠，录制中断</Typography.Text>
            ) : null}
            {missingSeconds > 0 ? (
              <GapDetail
                recordingId={r.id}
                recordingStartedAt={r.startedAt}
                missingMs={r.missingMs ?? 0}
                gapCount={r.gapCount}
              />
            ) : null}
          </Space>
        );
      },
    },
    {
      title: "操作",
      width: 180,
      fixed: "right",
      render: (_, r) => (
        <Space size={0} wrap>
          <Button
            size="small"
            type="link"
            icon={<PlayCircleOutlined />}
            disabled={r.state !== "completed" || !r.filePath}
            onClick={async () => {
              try {
                await playRecording(r.id);
              } catch (e) {
                message.error(
                  e instanceof ApiError && e.status === 404
                    ? e.code === "RESOURCE_NOT_FOUND" ? "录像文件已删除或不可访问" : "播放接口不可用，请更新或重启本地服务"
                    : e instanceof ApiError
                      ? describeError(e.code, e.message)
                      : "无法打开系统默认播放器，请检查文件关联",
                );
              }
            }}
          >
            播放
          </Button>
          <Tooltip title={r.hasDanmaku ? "弹幕回看" : "该录像没有弹幕数据"}>
            <Button
              size="small"
              type="link"
              icon={<CommentOutlined />}
              disabled={r.state !== "completed" || !r.filePath || !r.hasDanmaku}
              onClick={() => deps.openDanmakuPlayer(r)}
            >
              弹幕
            </Button>
          </Tooltip>
          <Button
            size="small"
            type="link"
            icon={<ExperimentOutlined />}
            disabled={
              !r.filePath ||
              r.state === "recording" ||
              r.state === "reconnecting"
            }
            onClick={() => setPipelineRec(r)}
          >
            {r.pipelineStatus === "failed"
              ? "继续处理"
              : (r.pipelineStatus == null ||
                    r.pipelineStatus === "not_required") &&
                  (r.endReason === "interrupted" ||
                    r.endReason === "service_restart")
                ? "处理已录部分"
                : "管线"}
          </Button>
          <Button
            size="small"
            type="link"
            icon={<FolderOpenOutlined />}
            disabled={!r.filePath}
            onClick={() =>
              void openDirectory(r.id).catch((e) =>
                message.error(
                  e instanceof ApiError
                    ? describeError(e.code, e.message)
                    : "无法打开目录",
                ),
              )
            }
          >
            目录
          </Button>
          <Popconfirm
            title="删除将连带删除录制文件，且不可恢复。确定？"
            onConfirm={() =>
              void removeRecording(r.id).catch((e) =>
                message.error(
                  e instanceof ApiError
                    ? describeError(e.code, e.message)
                    : "删除失败",
                ),
              )
            }
          >
            <Button
              size="small"
              type="link"
              danger
              icon={<DeleteOutlined />}
              disabled={
                !r.filePath ||
                r.state === "recording" ||
                r.state === "reconnecting"
              }
            >
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
}
