import { useEffect, useState } from 'react';
import { App, Button, Popconfirm, Progress, Space, Tag, Typography } from 'antd';
import { fetchUploads, retryUpload, cancelUpload, uploadRecording } from '../api/openlist';
import type { UploadJob } from '../api/openlist';
import { describeError } from '../utils/errorMap';
import { ApiError } from '../types/error';
import { formatRelative } from '../utils/format';
import { useShallow } from 'zustand/react/shallow';
import { useUploadStore } from '../stores/uploadStore';
import { describeUploadError, classifyUploadError } from '../utils/uploadError';
import { uploadPhaseLabel, uploadPhaseText } from '../utils/uploadProgress';

const STATUS_COLOR: Record<string, string> = {
  queued: 'default',
  running: 'processing',
  ok: 'green',
  failed: 'red',
  cancelled: 'default',
};

export default function UploadStatus({ recordingId }: { recordingId: string }) {
  const { message } = App.useApp();
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const [loading, setLoading] = useState(false);
  const liveJobs = useUploadStore(useShallow((s) => s.jobs.filter((j) => j.recordingId === recordingId)));

  const load = async () => {
    setLoading(true);
    try {
      const all = await fetchUploads(50);
      const mine = all.filter((u) => u.recordingId === recordingId);
      setJobs(mine);
      useUploadStore.getState().setJobs(mine);
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '上传列表加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [recordingId]);

  useEffect(() => {
    if (liveJobs.length > 0) setJobs(liveJobs);
  }, [liveJobs]);

  // 99%（云端收尾）阶段实时刷新等待时长，避免进度停在 99 看起来卡死（PrePan：上传卡 99 无状态）。
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (!loading && jobs.length === 0) {
    return (
      <Space orientation="vertical" size={8}>
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          该录制暂无上传任务。
        </Typography.Paragraph>
        <Button
          size="small"
          onClick={() =>
            uploadRecording(recordingId)
              .then(() => {
                message.success('已触发上传');
                void load();
              })
              .catch((e) => message.error(e instanceof ApiError ? describeError(e.code, e.message) : '上传失败'))
          }
        >
          手动上传
        </Button>
      </Space>
    );
  }

  return (
    <Space orientation="vertical" style={{ width: '100%' }} size={10}>
      {jobs.map((j) => (
        <div key={j.id}>
          <Space size={8} wrap>
            <Tag color={STATUS_COLOR[j.status]}>{j.status}</Tag>
            {j.status === 'running' ? <Progress percent={j.progress} size="small" style={{ width: 140 }} /> : null}
            {j.status === 'running' ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {uploadPhaseLabel(phaseOf(j.progress), j.progress)} · {uploadPhaseText(phaseOf(j.progress), j.progress, j.updatedAt)}
              </Typography.Text>
            ) : null}
            {j.status === 'ok' && j.remotePath ? (
              <Typography.Link href={j.remotePath} target="_blank" ellipsis>
                {j.remotePath}
              </Typography.Link>
            ) : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatRelative(j.updatedAt)}
            </Typography.Text>
            {j.status === 'failed' ? (
              <Space size={4}>
                <Button size="small" onClick={() => void retryUpload(j.id).then(() => void load()).catch((e) => message.error(describeError(e.code, e.message)))}>
                  重试
                </Button>
                <Popconfirm title="取消上传？本地文件不受影响" onConfirm={() => void cancelUpload(j.id).then(() => void load()).catch((e) => message.error(describeError(e.code, e.message)))}>
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
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 11 }}>
                {j.error}
              </Typography.Text>
            </div>
          ) : null}
        </div>
      ))}
    </Space>
  );
}

function phaseOf(progress: number): 'sending' | 'cloud' | 'verifying' {
  if (progress >= 99) return 'verifying';
  if (progress < 50) return 'sending';
  return 'cloud';
}