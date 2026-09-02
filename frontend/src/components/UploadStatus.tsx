import { useEffect, useState } from 'react';
import { App, Button, Popconfirm, Progress, Space, Tag, Typography } from 'antd';
import { fetchUploads, retryUpload, cancelUpload, uploadRecording } from '../api/openlist';
import type { UploadJob } from '../api/openlist';
import { describeError } from '../utils/errorMap';
import { ApiError } from '../types/error';
import { formatRelative } from '../utils/format';
import { useUploadStore } from '../stores/uploadStore';

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
  const liveJobs = useUploadStore((s) => s.jobs.filter((j) => j.recordingId === recordingId));

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
                {j.progress >= 99
                  ? '正在写入云端存储…（OpenList 云端驱动收尾中）'
                  : j.progress < 50
                    ? '正在上传至 OpenList…'
                    : '正在写入云端存储…'}
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
            <Typography.Text type="danger" style={{ display: 'block', fontSize: 12 }}>
              {j.error}
            </Typography.Text>
          ) : null}
        </div>
      ))}
    </Space>
  );
}