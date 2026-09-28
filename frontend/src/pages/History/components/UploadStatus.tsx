import { useEffect, useState } from "react";
import {
  App,
  Button,
  Popconfirm,
  Progress,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  fetchUploads,
  retryUpload,
  cancelUpload,
  uploadRecording,
} from "../../../api/openlist";
import type { UploadJob } from "../../../api/openlist";
import { describeError } from "../../../utils/errorMap";
import { ApiError } from "../../../types/error";
import { formatRelative } from "../../../utils/format";
import { useShallow } from "zustand/react/shallow";
import { useUploadStore } from "../../../stores/uploadStore";
import {
  describeUploadError,
  classifyUploadError,
} from "../../../utils/uploadError";
import {
  uploadPhaseLabel,
  uploadPhaseText,
} from "../../../utils/uploadProgress";
import { bridge } from "../../../stores/bootStore";

const STATUS_COLOR: Record<string, string> = {
  queued: "default",
  running: "processing",
  ok: "green",
  failed: "red",
  cancelled: "default",
};

const STATUS_TEXT: Record<UploadJob["status"], string> = {
  queued: "等待上传",
  running: "上传中",
  ok: "已上传",
  failed: "上传失败",
  cancelled: "已取消",
};

export default function UploadStatus({ recordingId }: { recordingId: string }) {
  const { message } = App.useApp();
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [loading, setLoading] = useState(false);
  const liveJobs = useUploadStore(
    useShallow((s) => s.jobs.filter((j) => j.recordingId === recordingId)),
  );
  const upsertUpload = useUploadStore((s) => s.upsert);
  const requestTwoFactorPrompt = useUploadStore(
    (s) => s.requestTwoFactorPrompt,
  );

  const load = async () => {
    setLoading(true);
    try {
      const all = await fetchUploads(50);
      const mine = all.filter((u) => u.recordingId === recordingId);
      setJobs(mine);
      // 逐条合并进全局，不再整表覆写：覆写会让同屏其他行的任务瞬间丢失
      const store = useUploadStore.getState();
      mine.forEach((j) => store.upsert(j));
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "上传列表加载失败",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [recordingId]);

  useEffect(() => {
    if (liveJobs.length > 0) {
      // 内容一致时返回旧引用，不触发重渲染，避免同步回写引发更新循环
      setJobs((prev) =>
        prev.length === liveJobs.length &&
        prev.every((p, i) => p === liveJobs[i])
          ? prev
          : liveJobs,
      );
    }
  }, [liveJobs]);

  // 99%（云端收尾）阶段实时刷新等待时长，避免进度停在 99 看起来卡死（PrePan：上传卡 99 无状态）。
  const [, setTick] = useState(0);
  useEffect(() => {
    if (loading || jobs.length === 0) return;
    const timer = setInterval(() => {
      // 仅在有在役任务且前台时滴答（进度文案无人看时不必每秒重渲）。
      if (document.visibilityState !== "visible") return;
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [loading, jobs.length]);

  if (!loading && jobs.length === 0) {
    return (
      <Space orientation="vertical" size={8} className="pipeline-upload-empty">
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          该录制暂无上传任务。
        </Typography.Paragraph>
        <Button
          size="small"
          type="primary"
          className="pipeline-upload-action"
          onClick={() =>
            uploadRecording(recordingId)
              .then(() => {
                message.success("已触发上传");
                void load();
              })
              .catch((e) =>
                message.error(
                  e instanceof ApiError
                    ? describeError(e.code, e.message)
                    : "上传失败",
                ),
              )
          }
        >
          手动上传
        </Button>
      </Space>
    );
  }

  return (
    <Space orientation="vertical" className="pipeline-upload-list" size={10}>
      {jobs.map((j) => (
        <div key={j.id} className={`pipeline-upload-job pipeline-upload-${j.status}`}>
          <Space size={8} wrap className="pipeline-upload-topline">
            <Tag color={STATUS_COLOR[j.status]}>{STATUS_TEXT[j.status]}</Tag>
            {j.status === "running" ? (
              <Progress
                percent={j.progress}
                size="small"
                style={{ width: 140 }}
              />
            ) : null}
            {j.status === "running" ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {uploadPhaseLabel(phaseOf(j.progress), j.progress)} ·{" "}
                {uploadPhaseText(phaseOf(j.progress), j.progress, j.updatedAt)}
              </Typography.Text>
            ) : null}
            {j.status === "ok" && j.remotePath ? (
              <Typography.Link
                href={j.remotePath}
                target="_blank"
                rel="noopener noreferrer"
                ellipsis
                onClick={(e) => {
                  // Tauri webview 内 <a target=_blank> 不会打开外部浏览器，改由原生 shell 打开。
                  e.preventDefault();
                  const url = j.remotePath;
                  if (!url) return;
                  void bridge.openPath(url).catch(() => {
                    window.open(url, "_blank", "noopener,noreferrer");
                  });
                }}
              >
                {j.remotePath}
              </Typography.Link>
            ) : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatRelative(j.updatedAt)}
            </Typography.Text>
            {j.status === "failed" ? (
              <Space size={4}>
                <Button
                  size="small"
                  onClick={() =>
                    void retryUpload(j.id)
                      .then((updated) => {
                        upsertUpload(updated);
                        if (
                          (updated.error ?? "").includes(
                            "OpenList 需要 2FA 验证",
                          )
                        )
                          requestTwoFactorPrompt();
                        return load();
                      })
                      .catch((e) =>
                        message.error(describeError(e.code, e.message)),
                      )
                  }
                >
                  重试
                </Button>
                <Popconfirm
                  title="取消上传？本地文件不受影响"
                  onConfirm={() =>
                    void cancelUpload(j.id)
                      .then(() => void load())
                      .catch((e) =>
                        message.error(describeError(e.code, e.message)),
                      )
                  }
                >
                  <Button size="small" danger>
                    取消
                  </Button>
                </Popconfirm>
              </Space>
            ) : null}
          </Space>
          {j.error ? (
            <div>
              <Space size={6} style={{ marginBottom: 2 }}>
                <Tag color="red">{classifyUploadError(j.error).code}</Tag>
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  {describeUploadError(j.error) ?? j.error}
                </Typography.Text>
              </Space>
              <Typography.Text
                type="secondary"
                style={{ display: "block", fontSize: 11 }}
              >
                {j.error}
              </Typography.Text>
            </div>
          ) : null}
        </div>
      ))}
    </Space>
  );
}

function phaseOf(progress: number): "sending" | "cloud" | "verifying" {
  if (progress >= 99) return "verifying";
  if (progress < 50) return "sending";
  return "cloud";
}
