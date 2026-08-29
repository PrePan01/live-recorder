import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Collapse, DatePicker, Drawer, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tooltip, Typography } from 'antd';
import { DeleteOutlined, FolderOpenOutlined, EditOutlined, PlayCircleOutlined, WarningOutlined, ExperimentOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useRecordingStore } from '../../stores/recordingStore';
import { useRoomStore } from '../../stores/roomStore';
import { RecordingStateTag, IntegrityTag } from '../../components/StatusTags';
import { PlatformLogoTag } from '../../components/PlatformLogo';
import FilePlayer from '../../components/FilePlayer';
import { recordingFileUrl } from '../../api/client';
import { formatBytes, formatDuration, formatTime } from '../../utils/format';
import { ApiError } from '../../types/error';
import { describeError } from '../../utils/errorMap';
import PipelineTimeline from '../../components/PipelineTimeline';
import UploadStatus from '../../components/UploadStatus';
import type { Recording } from '../../types/recording';

const QUALITY_LABEL: Record<string, string> = { origin: '原画', '4k': '4K', 'bluray': '蓝光', 'hd': '高清', 'sd': '流畅' };

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
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const q: { page: number; roomId?: string; dateFrom?: string; dateTo?: string } = { page: 1, roomId };
    if (dateRange) {
      q.dateFrom = dateRange[0].startOf('day').toISOString();
      q.dateTo = dateRange[1].endOf('day').toISOString();
    }
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
      { title: '平台', dataIndex: 'platform', width: 90, render: (p) => <PlatformLogoTag platform={p} /> },
      {
        title: '标题',
        dataIndex: 'streamTitle',
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
      { title: '清晰度', dataIndex: 'quality', width: 80, render: (q: string | null) => (q ? QUALITY_LABEL[q] ?? q : '-') },
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
    [roomLabel, openDirectory, removeRecording, message],
  );

  const groups = useMemo(() => {
    const map = new Map<string, Recording[]>();
    items.forEach((r) => {
      const key = r.streamSessionId ?? r.id;
      map.set(key, [...(map.get(key) ?? []), r]);
    });
    return [...map.entries()].map(([sessionId, recs]) => ({ sessionId, recs }));
  }, [items]);

  return (
    <div>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          录制历史
        </Typography.Title>
        <Space>
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
          <Button size="small" loading={exporting} onClick={() => void handleExportCsv()}>
            导出 CSV
          </Button>
          <Popconfirm
            title={`确定删除所选 ${selectedKeys.length} 条录制？将连带删除文件且不可恢复。`}
            onConfirm={() => void handleBatchDelete()}
            disabled={selectedKeys.length === 0}
          >
            <Button size="small" danger disabled={batchBusy || selectedKeys.length === 0}>
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
            children: <Table rowKey="id" size="small" columns={columns} dataSource={recs} pagination={false} scroll={{ x: 1400 }} />,
          }))}
        />
      ) : (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
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
        {playing ? <FilePlayer url={recordingFileUrl(playing.id)} /> : null}
      </Modal>
      <Drawer
        title={`管线：${pipelineRec?.streamTitle || pipelineRec?.id || ''}`}
        open={pipelineRec !== null}
        width={520}
        onClose={() => setPipelineRec(null)}
      >
        {pipelineRec ? (
          <Space direction="vertical" style={{ width: '100%' }} size={20}>
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
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Text type="secondary">重命名会同步修改录制文件名。</Typography.Text>
          <Input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} placeholder="新标题" />
        </Space>
      </Modal>
    </div>
  );
}
