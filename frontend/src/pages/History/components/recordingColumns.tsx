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
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  FolderOpenOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { ApiError } from "../../../types/error";
import { describeError } from "../../../utils/errorMap";
import { formatBytes, formatDuration, formatTime } from "../../../utils/format";
import {
  IntegrityTag,
  RecordingStateTag,
} from "../../../components/StatusTags";
import { PlatformLogoTag } from "../../../components/PlatformLogo";
import {
  describeEndReason,
  isInterruptedEnd,
} from "../../../utils/recordingEndReason";
import {
  uploadPhaseLabel,
  uploadPhaseText,
} from "../../../utils/uploadProgress";
import {
  describeUploadError,
  classifyUploadError,
} from "../../../utils/uploadError";
import type { Recording } from "../../../types/recording";
import { QUALITY_LABEL, phaseOfUpload, openExternalUrl } from "./historyUtils";

type MessageApi = ReturnType<typeof import("antd").App.useApp>["message"];

export interface RecordingColumnsDeps {
  roomLabel: (r: Recording) => ReactNode;
  openDirectory: (id: string) => Promise<unknown>;
  removeRecording: (id: string) => Promise<unknown>;
  message: MessageApi;
  handleManualUpload: (id: string) => Promise<unknown>;
  handleUploadErrorDetail: (recording: Recording) => void;
  setRenaming: Dispatch<SetStateAction<Recording | null>>;
  setRenameValue: Dispatch<SetStateAction<string>>;
  setPlaying: Dispatch<SetStateAction<Recording | null>>;
  setPipelineRec: Dispatch<SetStateAction<Recording | null>>;
  retryUploadFor: (recordingId: string) => Promise<void>;
}

export function buildRecordingColumns(
  deps: RecordingColumnsDeps,
): ColumnsType<Recording> {
  const {
    roomLabel,
    openDirectory,
    removeRecording,
    message,
    handleManualUpload,
    handleUploadErrorDetail,
    setRenaming,
    setRenameValue,
    setPlaying,
    setPipelineRec,
    retryUploadFor,
  } = deps;
  return [
    {
      title: "房间",
      dataIndex: "roomId",
      width: 140,
      ellipsis: true,
      render: (_id: string, r) => roomLabel(r),
    },
    {
      title: "平台",
      dataIndex: "platform",
      width: 60,
      render: (p) => <PlatformLogoTag platform={p} />,
    },
    {
      title: "标题",
      dataIndex: "streamTitle",
      width: 320,
      ellipsis: true,
      render: (t: string, r) => (
        <div className="lr-history-title-cell">
          <Typography.Text ellipsis title={t || "未命名"}>
            {t || "未命名"}
          </Typography.Text>
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
      width: 70,
      render: (v: Recording["integrity"], r) => (
        <Space size={4}>
          <IntegrityTag integrity={v} />
          {v === "failed" && r.failureReason ? (
            <Tooltip title={r.failureReason.message}>
              <WarningOutlined style={{ color: "#ff4d4f" }} />
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    { title: "开始", dataIndex: "startedAt", width: 120, render: formatTime },
    { title: "结束", dataIndex: "endedAt", width: 120, render: formatTime },
    {
      title: "时长",
      width: 85,
      render: (_, r) => formatDuration(r.startedAt, r.endedAt),
    },
    {
      title: "状态",
      dataIndex: "state",
      width: 95,
      render: (s, r) => {
        const reason = describeEndReason(r.endReason);
        if (!reason) return <RecordingStateTag state={s} />;
        return (
          <Space direction="vertical" size={0}>
            <RecordingStateTag state={s} />
            <Typography.Text
              type={isInterruptedEnd(r.endReason) ? "warning" : "secondary"}
              style={{ fontSize: 12 }}
            >
              {reason}
            </Typography.Text>
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
        // #18②：无上传任务的录制提供「上传」按钮（未开自动上传或上传被删除时）。
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
      // 这一列既放失败原因，也放中断恢复合成一个文件后的"中途缺失 N 秒"。
      title: "录制异常",
      dataIndex: "failureReason",
      width: 180,
      render: (f: Recording["failureReason"], r: Recording) => {
        const missingSeconds =
          r.missingMs && r.missingMs >= 1000
            ? Math.round(r.missingMs / 1000)
            : 0;
        if (!f && missingSeconds === 0) return "-";
        return (
          <Space direction="vertical" size={0}>
            {f ? (
              <Typography.Text type="danger">{f.message}</Typography.Text>
            ) : null}
            {missingSeconds > 0 ? (
              <Typography.Text type="warning">
                中途缺失 {missingSeconds} 秒
              </Typography.Text>
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
            onClick={() => setPlaying(r)}
          >
            播放
          </Button>
          <Button
            size="small"
            type="link"
            icon={<ExperimentOutlined />}
            disabled={
              r.pipelineStatus == null || r.pipelineStatus === "not_required"
            }
            onClick={() => setPipelineRec(r)}
          >
            管线
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
              disabled={!r.filePath}
            >
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];
}
