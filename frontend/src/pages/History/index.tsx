import { useEffect, useMemo, useState } from 'react';
import { App, Button, Collapse, Select, Space, Switch, Table, Typography } from 'antd';
import { FolderOpenOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useRecordingStore } from '../../stores/recordingStore';
import { useRoomStore } from '../../stores/roomStore';
import { PlatformTag, RecordingStateTag } from '../../components/StatusTags';
import { formatBytes, formatDuration, formatTime } from '../../utils/format';
import { ApiError } from '../../types/error';
import { describeError } from '../../utils/errorMap';
import type { Recording } from '../../types/recording';

export default function History() {
  const { message } = App.useApp();
  const { items, total, page, pageSize, loading, fetchHistory, openDirectory } = useRecordingStore();
  const rooms = useRoomStore((s) => s.rooms);
  const fetchRooms = useRoomStore((s) => s.fetchRooms);
  const [grouped, setGrouped] = useState(false);
  const [roomId, setRoomId] = useState<string | undefined>();

  useEffect(() => {
    void fetchHistory({ page: 1, roomId });
    if (rooms.length === 0) void fetchRooms();
  }, [fetchHistory, roomId]);

  const roomName = useMemo(() => new Map(rooms.map((r) => [r.id, r.displayName])), [rooms]);

  const columns: ColumnsType<Recording> = useMemo(
    () => [
      { title: '房间', dataIndex: 'roomId', width: 140, ellipsis: true, render: (id: string) => roomName.get(id) ?? id },
      { title: '平台', dataIndex: 'platform', width: 90, render: (p) => <PlatformTag platform={p} /> },
      { title: '标题', dataIndex: 'streamTitle', ellipsis: true },
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
        width: 115,
        render: (_, r) => (
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
            打开目录
          </Button>
        ),
      },
    ],
    [roomName, openDirectory, message],
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
                  {dayjs(recs[0].startedAt).format('MM-DD HH:mm')} · {recs.length} 段 · {roomName.get(recs[0].roomId) ?? recs[0].roomId}
                </Typography.Text>
              </Space>
            ),
            children: <Table rowKey="id" size="small" columns={columns} dataSource={recs} pagination={false} />,
          }))}
        />
      ) : (
        <Table
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            onChange: (p, ps) => void fetchHistory({ page: p, pageSize: ps, roomId }),
          }}
        />
      )}
    </div>
  );
}
