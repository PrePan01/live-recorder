import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Collapse, DatePicker, Drawer, Input, Modal, Popconfirm, Progress, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import { DeleteOutlined, FolderOpenOutlined, EditOutlined, PlayCircleOutlined, WarningOutlined, ExperimentOutlined, ExportOutlined, InfoCircleOutlined, CopyOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useRecordingStore } from '../../stores/recordingStore';
import { useRoomStore } from '../../stores/roomStore';
import { useResizableColumns } from '../../hooks/useResizableColumns';
import { RecordingStateTag, IntegrityTag } from '../../components/StatusTags';
import { PlatformLogoTag } from '../../components/PlatformLogo';
import FilePlayer from '../../components/FilePlayer';
import { recordingFileUrl } from '../../api/client';
import { formatBytes, formatDuration, formatTime } from '../../utils/format';
import { ApiError } from '../../types/error';
import { describeError } from '../../utils/errorMap';
import PipelineTimeline from '../../components/PipelineTimeline';
import UploadStatus from '../../components/UploadStatus';
import { createExport, cancelExport, fetchExports } from '../../api/export';
import { fetchUploads, retryUpload, uploadRecording } from '../../api/openlist';
import { uploadPhaseLabel, uploadPhaseText } from '../../utils/uploadProgress';
import { describeUploadError, classifyUploadError } from '../../utils/uploadError';
import type { ExportJob } from '../../types/export';
import type { Recording } from '../../types/recording';

const QUALITY_LABEL: Record<string, string> = { original: '原画', '1080p': '1080p', '720p': '720p', '360p': '360p' };
function phaseOfUpload(progress: number): 'sending' | 'cloud' | 'verifying' {
  if (progress >= 99) return 'verifying';
  if (progress < 50) return 'sending';
  return 'cloud';
}
const EXPORT_STATUS_COLOR: Record<string, string> = {
  queued: 'default',
  running: 'processing',
  ok: 'green',
  partial: 'orange',
  failed: 'red',
  cancelled: 'default',
};

export default function History() {
  const { message } = App.useApp();
  const { items, total, page, pageSize, loading, fetchHistory, openDirectory, renameRecording, removeRecording, batchRemove, exportCsv } =
    useRecordingStore();
  const rooms = useRoomStore((s) => s.rooms);
  const fetchRooms = useRoomStore((s) => s.fetchRooms);
  const [grouped, setGrouped] = useState(false);
  const [roomId, setRoomId] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(null);
  const [renaming, setRenaming] = useState<Recording | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [playing, setPlaying] = useState<Recording | null>(null);
  const [pipelineRec, setPipelineRec] = useState<Recording | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportDir, setExportDir] = useState('');
  const [exportBusy, setExportBusy] = useState(false);
  const [exportDrawer, setExportDrawer] = useState(false);
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [, setTick] = useState(0);
  // #19：上传失败任务的「查看详情」弹窗（错误码 + 可执行建议 + 原始错误全文 + 复制）。
  const [uploadErrorDetail, setUploadErrorDetail] = useState<{ recordingId: string; title: string; raw: string } | null>(null);

  // 录制中记录时长本地走时：每秒重渲染一次，不再依赖后端每秒 SSE（QA 性能建议③）。
  useEffect(() => {
    const hasRecording = items.some((r) => r.state === 'recording' || r.state === 'reconnecting');
    if (!hasRecording) return;
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [items]);

  useEffect(() => {
    // 显式传全量筛选（roomId/dateFrom/dateTo 用 undefined 表示清除），
    // 覆盖 store 合并的旧 query，避免清除筛选后残留上次筛选参数。
    const q: { page: number; roomId?: string; dateFrom?: string; dateTo?: string } = {
      page: 1,
      roomId,
      dateFrom: dateRange ? dateRange[0].startOf('day').toISOString() : undefined,
      dateTo: dateRange ? dateRange[1].endOf('day').toISOString() : undefined,
    };
    void fetchHistory(q);
    if (rooms.length === 0) void fetchRooms();
  }, [fetchHistory, roomId, dateRange]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const focusId = params.get('focus');
    if (!focusId || items.length === 0) return;
    const el = document.querySelector(`[data-rec-id="${focusId}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.transition = 'background 1s ease';
      el.style.background = 'var(--lr-hover-bg)';
      setTimeout(() => {
        el.style.background = '';
      }, 2000);
    }
    window.history.replaceState({}, '', '/history');
  }, [items]);

  const roomName = useMemo(() => new Map(rooms.map((r) => [r.id, r.displayName])), [rooms]);
  const roomLabel = useCallback((r: Recording) => r.roomName || roomName.get(r.roomId) || r.roomId, [roomName]);

  const handleBatchDelete = async () => {
    setBatchBusy(true);
    try {
      const res = await batchRemove(selectedKeys.map(String));
      setSelectedKeys([]);
      message.success(`已删除 ${res.deleted.length} 条${res.failed.length > 0 ? `，失败 ${res.failed.length} 条` : ''}`);
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '批量删除失败');
    } finally {
      setBatchBusy(false);
    }
  };

  const handleExport = async () => {
    if (selectedKeys.length === 0) {
      message.warning('请先选择要导出的录制');
      return;
    }
    if (!exportDir.trim()) {
      message.warning('请输入导出目录');
      return;
    }
    setExportBusy(true);
    try {
      await createExport(selectedKeys.map(String), exportDir.trim());
      message.success('导出任务已创建');
      setExportModalOpen(false);
      setExportDrawer(true);
      void refreshExports();
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '导出失败');
    } finally {
      setExportBusy(false);
    }
  };

  const refreshExports = async () => {
    try {
      setExportJobs(await fetchExports());
    } catch {
      /* 忽略 */
    }
  };

  // #13 OpenList 2FA：上传任务失败且标记「需要 2FA 验证」时弹窗收集一次性码。
  const retryUploadFor = useCallback(
    async (recordingId: string) => {
      try {
        const jobs = await fetchUploads(50);
        const job = jobs.find((j) => j.recordingId === recordingId);
        if (!job) {
          message.warning('未找到该录制的上传任务');
          return;
        }
        await retryUpload(job.id);
        message.success('已触发重试');
      } catch (e) {
        message.error(e instanceof ApiError ? describeError(e.code, e.message) : '重试失败');
      }
    },
    [message],
  );

  // #18②：手动上传未自动上传的录制（无上传任务时 History 提供「上传」按钮）。
  const handleManualUpload = useCallback(
    async (recordingId: string) => {
      try {
        await uploadRecording(recordingId);
        message.success('已触发上传');
        void fetchHistory();
      } catch (e) {
        // 直接用后端真实 message（如「源文件已删除，无法上传」），避免 ERROR_MAP 固定文案遮蔽明确原因。
        message.error(e instanceof ApiError ? e.message : '上传失败');
      }
    },
    [message, fetchHistory],
  );

  // #19：查看失败任务错误详情（错误码 + 可执行建议 + 原始错误全文）。
  const handleUploadErrorDetail = useCallback((recording: Recording) => {
    const raw = recording.upload?.error ?? '未知错误';
    setUploadErrorDetail({
      recordingId: recording.id,
      title: recording.streamTitle || recording.id,
      raw,
    });
  }, []);

  const handleCopyErrorDetail = useCallback(async () => {
    if (!uploadErrorDetail) return;
    try {
      await navigator.clipboard.writeText(uploadErrorDetail.raw);
      message.success('错误详情已复制');
    } catch {
      message.error('复制失败，请手动复制');
    }
  }, [uploadErrorDetail, message]);

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const csv = await exportCsv();
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recordings-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      message.success('CSV 已导出');
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '导出失败');
    } finally {
      setExporting(false);
    }
  };

  const columns: ColumnsType<Recording> = useMemo(
    () => [
      { title: '房间', dataIndex: 'roomId', width: 140, ellipsis: true, render: (_id: string, r) => roomLabel(r) },
      { title: '平台', dataIndex: 'platform', width: 80, render: (p) => <PlatformLogoTag platform={p} /> },
      {
        title: '标题',
        dataIndex: 'streamTitle',
        width: 240,
        ellipsis: true,
        render: (t: string, r) => (
          <Space size={4}>
            {t || '未命名'}
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => {
                setRenaming(r);
                setRenameValue(r.streamTitle);
              }}
            />
          </Space>
        ),
      },
      {
        title: '清晰度',
        dataIndex: 'quality',
        width: 90,
        render: (q: string | null, r: Recording) => {
          if (!q) return '-';
          const label = QUALITY_LABEL[q] ?? q;
          // 仅用录制发起时的期望画质快照判断回退；无快照（迁移前旧记录）不提示，避免用当前设置误判（PrePan）。
          const expected = r.expectedQuality;
          if (!expected || expected === q) return label;
          const hint = `设置默认清晰度为 ${QUALITY_LABEL[expected] ?? expected}，该直播间未提供该画质，已按实际可用画质 ${label} 录制`;
          return (
            <Tooltip title={hint}>
              <span style={{ cursor: 'help' }}>
                {label} <InfoCircleOutlined style={{ color: '#faad14', fontSize: 12 }} />
              </span>
            </Tooltip>
          );
        },
      },
      {
        title: '完整性',
        dataIndex: 'integrity',
        width: 90,
        render: (v: Recording['integrity'], r) => (
          <Space size={4}>
            <IntegrityTag integrity={v} />
            {v === 'failed' && r.failureReason ? (
              <Tooltip title={r.failureReason.message}>
                <WarningOutlined style={{ color: '#ff4d4f' }} />
              </Tooltip>
            ) : null}
          </Space>
        ),
      },
      { title: '开始', dataIndex: 'startedAt', width: 165, render: formatTime },
      { title: '结束', dataIndex: 'endedAt', width: 165, render: formatTime },
      { title: '时长', width: 85, render: (_, r) => formatDuration(r.startedAt, r.endedAt) },
      { title: '状态', dataIndex: 'state', width: 95, render: (s) => <RecordingStateTag state={s} /> },
      { title: '大小', dataIndex: 'fileSizeBytes', width: 95, render: (v: number) => formatBytes(v) },
      {
        title: '上传状态',
        dataIndex: 'upload',
        width: 150,
        render: (u: Recording['upload'], r: Recording) => {
          // #18②：无上传任务的录制提供「上传」按钮（未开自动上传或上传被删除时）。
          if (!u) {
            const canUpload = r.state === 'completed' && !!r.filePath;
            return (
              <Tooltip title={canUpload ? '点击上传到 OpenList' : '录制未完成或文件不存在，无法上传'}>
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
            (u.status === 'failed' && u.error
              ? info.action
              : describeUploadError(u.error)) ??
            (u.status === 'running' && u.progress >= 99
              ? uploadPhaseText('verifying', u.progress, r.endedAt ?? r.startedAt)
              : u.remotePath);
          const node =
            u.status === 'running' ? (
              <Space size={4}>
                <Tag color="processing">{uploadPhaseLabel(phaseOfUpload(u.progress), u.progress)}</Tag>
                <Progress percent={u.progress} size="small" style={{ width: 56 }} />
              </Space>
            ) : u.status === 'failed' ? (
              // #18①：源文件已删除 → 明确标注且不再提供无意义的重试。
              u.error?.includes('源文件已删除') ? (
                <Space size={4}>
                  <Tag color="red">源文件已删除</Tag>
                  <Button size="small" type="link" onClick={() => handleUploadErrorDetail(r)}>
                    查看详情
                  </Button>
                </Space>
              ) : (
                <Space size={4}>
                  <Tag color="red">失败</Tag>
                  <Button size="small" type="link" onClick={() => void retryUploadFor(r.id)}>
                    重试
                  </Button>
                  <Button size="small" type="link" onClick={() => handleUploadErrorDetail(r)}>
                    查看详情
                  </Button>
                </Space>
              )
            ) : (
              <Tag
                color={u.status === 'ok' ? 'green' : u.status === 'cancelled' ? 'default' : 'default'}
              >
                {u.status === 'ok' ? '成功' : u.status === 'cancelled' ? '已取消' : u.error ? '等待重试' : '排队'}
              </Tag>
            );
          return detail ? (
            <Tooltip title={detail}>
              <span style={{ cursor: 'help' }}>{node}</span>
            </Tooltip>
          ) : (
            node
          );
        },
      },
      {
        title: '失败原因',
        dataIndex: 'failureReason',
        width: 160,
        ellipsis: true,
        render: (f: Recording['failureReason']) => (f ? <Typography.Text type="danger">{f.message}</Typography.Text> : '-'),
      },
      {
        title: '操作',
        width: 180,
        fixed: 'right',
        render: (_, r) => (
          <Space size={0} wrap>
            <Button
              size="small"
              type="link"
              icon={<PlayCircleOutlined />}
              disabled={r.state !== 'completed' || !r.filePath}
              onClick={() => setPlaying(r)}
            >
              播放
            </Button>
            <Button
              size="small"
              type="link"
              icon={<ExperimentOutlined />}
              disabled={r.pipelineStatus == null || r.pipelineStatus === 'not_required'}
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
                  message.error(e instanceof ApiError ? describeError(e.code, e.message) : '无法打开目录'),
                )
              }
            >
              目录
            </Button>
            <Popconfirm
              title="删除将连带删除录制文件，且不可恢复。确定？"
              onConfirm={() =>
                void removeRecording(r.id).catch((e) =>
                  message.error(e instanceof ApiError ? describeError(e.code, e.message) : '删除失败'),
                )
              }
            >
              <Button size="small" type="link" danger icon={<DeleteOutlined />} disabled={!r.filePath}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    [roomLabel, openDirectory, removeRecording, message, handleManualUpload, handleUploadErrorDetail],
  );

  const groups = useMemo(() => {
    const map = new Map<string, Recording[]>();
    items.forEach((r) => {
      const key = r.streamSessionId ?? r.id;
      map.set(key, [...(map.get(key) ?? []), r]);
    });
    return [...map.entries()].map(([sessionId, recs]) => ({ sessionId, recs }));
  }, [items]);

  const { columns: resizedColumns, components: resizableComponents } = useResizableColumns<Recording>(columns);

  return (
    <div className="lr-page lr-history-page">
      <Space className="lr-page-header" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          录制历史
        </Typography.Title>
        <Space className="lr-page-actions" wrap>
          <Select
            allowClear
            placeholder="按房间筛选"
            style={{ width: 200 }}
            value={roomId}
            onChange={setRoomId}
            options={rooms.map((r) => ({ value: r.id, label: r.displayName }))}
          />
          <DatePicker.RangePicker
            value={dateRange}
            onChange={(v) => setDateRange(v as [dayjs.Dayjs, dayjs.Dayjs] | null)}
          />
          <Button loading={exporting} onClick={() => void handleExportCsv()}>
            导出 CSV
          </Button>
          <Button icon={<ExportOutlined />} disabled={batchBusy || selectedKeys.length === 0} onClick={() => setExportModalOpen(true)}>
            备份导出{selectedKeys.length > 0 ? ` (${selectedKeys.length})` : ''}
          </Button>
          <Popconfirm
            title={`确定删除所选 ${selectedKeys.length} 条录制？将连带删除文件且不可恢复。`}
            onConfirm={() => void handleBatchDelete()}
            disabled={selectedKeys.length === 0}
          >
            <Button danger disabled={batchBusy || selectedKeys.length === 0}>
              批量删除{selectedKeys.length > 0 ? ` (${selectedKeys.length})` : ''}
            </Button>
          </Popconfirm>
          <Space>
            <Typography.Text type="secondary">按场次分组</Typography.Text>
            <Switch checked={grouped} onChange={setGrouped} />
          </Space>
        </Space>
      </Space>
      {grouped ? (
        <Collapse
          items={groups.map(({ sessionId, recs }) => ({
            key: sessionId,
            label: (
              <Space>
                <Typography.Text strong>{recs[0].streamTitle || '未命名场次'}</Typography.Text>
                <Typography.Text type="secondary">
                  {dayjs(recs[0].startedAt).format('MM-DD HH:mm')} · {recs.length} 段 · {roomLabel(recs[0])}
                </Typography.Text>
              </Space>
            ),
            children: <Table rowKey="id" size="small" columns={resizedColumns} components={resizableComponents} dataSource={recs} pagination={false} sticky={{ offsetScroll: 8 }} scroll={{ x: 1400 }} />,
          }))}
        />
      ) : (
        <Table
          rowKey="id"
          columns={resizedColumns}
          components={resizableComponents}
          dataSource={items}
          loading={loading}
          sticky={{ offsetScroll: 8 }}
          onRow={(r) => ({ 'data-rec-id': r.id } as React.HTMLAttributes<HTMLElement>)}
          rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
          scroll={{ x: 1400 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            onChange: (p, ps) => void fetchHistory({ page: p, pageSize: ps, roomId }),
          }}
        />
      )}
      <Modal
        title={`播放：${playing?.streamTitle || playing?.id || ''}`}
        open={playing !== null}
        footer={null}
        width={820}
        destroyOnHidden
        onCancel={() => setPlaying(null)}
      >
        {playing ? <FilePlayer url={recordingFileUrl(playing.id)} filePath={playing.filePath} /> : null}
      </Modal>
      <Drawer
        title={`管线：${pipelineRec?.streamTitle || pipelineRec?.id || ''}`}
        open={pipelineRec !== null}
        size={520}
        onClose={() => setPipelineRec(null)}
      >
        {pipelineRec ? (
          <Space orientation="vertical" style={{ width: '100%' }} size={20}>
            <PipelineTimeline recordingId={pipelineRec.id} />
            <Typography.Title level={5} style={{ marginBottom: 0 }}>
              上传
            </Typography.Title>
            <UploadStatus recordingId={pipelineRec.id} />
          </Space>
        ) : null}
      </Drawer>
      <Modal
        title="重命名录制"
        open={renaming !== null}
        onCancel={() => setRenaming(null)}
        onOk={() => {
          if (!renaming) return;
          setRenameBusy(true);
          void renameRecording(renaming.id, renameValue)
            .then(() => {
              message.success('已重命名');
              setRenaming(null);
            })
            .catch((e) =>
              message.error(e instanceof ApiError ? describeError(e.code, e.message) : '重命名失败'),
            )
            .finally(() => setRenameBusy(false));
        }}
        confirmLoading={renameBusy}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">重命名会同步修改录制文件名。</Typography.Text>
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} placeholder="新标题" />
        </Space>
      </Modal>
    <Modal
        title={`备份导出（${selectedKeys.length} 条）`}
        open={exportModalOpen}
        onCancel={() => setExportModalOpen(false)}
        onOk={() => void handleExport()}
        confirmLoading={exportBusy}
        okText="开始导出"
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            打包为目录（源文件+封面+manifest.json，不含密钥）；缺失附件标部分成功，不损坏源文件。
          </Typography.Text>
          <Input
            placeholder="导出目录（如 /Users/name/Exports）"
            value={exportDir}
            onChange={(e) => setExportDir(e.target.value)}
          />
        </Space>
      </Modal>
      <Drawer
        title="导出任务"
        open={exportDrawer}
        size={460}
        onClose={() => setExportDrawer(false)}
      >
        <Space orientation="vertical" style={{ width: '100%' }} size={12}>
          <Button size="small" onClick={() => void refreshExports()}>
            刷新
          </Button>
          {exportJobs.length === 0 ? (
            <Typography.Text type="secondary">暂无导出任务</Typography.Text>
          ) : (
            exportJobs.slice(0, 10).map((j) => (
              <div key={j.id}>
                <Space size={8} wrap>
                  <Tag color={EXPORT_STATUS_COLOR[j.status]}>{j.status}</Tag>
                  {j.status === 'running' ? <Progress percent={j.progress} size="small" style={{ width: 120 }} /> : null}
                  {j.outputPath ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                      {j.outputPath}
                    </Typography.Text>
                  ) : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatTime(j.updatedAt)}
                  </Typography.Text>
                  {(j.status === 'queued' || j.status === 'running') ? (
                    <Popconfirm title="取消导出？已生成内容保留" onConfirm={() => void cancelExport(j.id).then(() => void refreshExports()).catch((e) => message.error(describeError(e.code, e.message)))}>
                      <Button size="small" danger>
                        取消
                      </Button>
                    </Popconfirm>
                  ) : null}
                </Space>
                {j.error ? (
                  <Typography.Text type="danger" style={{ display: 'block', fontSize: 12 }}>
                    {j.error}
                  </Typography.Text>
                ) : null}
              </div>
            ))
          )}
        </Space>
      </Drawer>
      {/* #19：上传失败错误详情——分级展示（可执行建议 + 错误码 + 原始错误全文）+ 复制。 */}
      <Modal
        title={`上传错误详情${uploadErrorDetail ? `：${uploadErrorDetail.title}` : ''}`}
        open={uploadErrorDetail !== null}
        onCancel={() => setUploadErrorDetail(null)}
        footer={[
          <Button key="copy" icon={<CopyOutlined />} onClick={() => void handleCopyErrorDetail()}>
            复制错误详情
          </Button>,
          <Button key="close" type="primary" onClick={() => setUploadErrorDetail(null)}>
            关闭
          </Button>,
        ]}
        destroyOnHidden
      >
        {uploadErrorDetail ? (
          <Space orientation="vertical" style={{ width: '100%' }} size={12}>
            <div>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                错误码
              </Typography.Text>
              <Tag color="red">{classifyUploadError(uploadErrorDetail.raw).code}</Tag>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                处理建议
              </Typography.Text>
              <Typography.Text>{classifyUploadError(uploadErrorDetail.raw).action}</Typography.Text>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                详细原因（原始错误）
              </Typography.Text>
              <Typography.Paragraph
                style={{ margin: 0 }}
                copyable={{ text: uploadErrorDetail.raw }}
              >
                <Typography.Text type="danger">{uploadErrorDetail.raw}</Typography.Text>
              </Typography.Paragraph>
            </div>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
