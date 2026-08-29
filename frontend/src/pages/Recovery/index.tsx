import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Badge,
  Button,
  Drawer,
  List,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined } from '@ant-design/icons';
import { useDiagnosticStore } from '../../stores/diagnosticStore';
import { useRoomStore } from '../../stores/roomStore';
import { describeError } from '../../utils/errorMap';
import { ApiError } from '../../types/error';
import { formatRelative } from '../../utils/format';
import type { Diagnostic, DiagnosticStatus } from '../../types/diagnostic';

const STATUS_META: Record<DiagnosticStatus, { color: string; text: string }> = {
  open: { color: 'red', text: '未解决' },
  processing: { color: 'processing', text: '处理中' },
  resolved: { color: 'green', text: '已解决' },
  expired: { color: 'default', text: '已过期' },
};

const SEVERITY_META: Record<string, { color: string; text: string }> = {
  error: { color: 'red', text: '严重' },
  warning: { color: 'orange', text: '警告' },
  info: { color: 'blue', text: '提示' },
};

const ACTION_LABEL: Record<string, string> = {
  retry: '重试录制',
  refresh_cookie: '刷新 Cookie',
  cleanup: '清理磁盘',
  test_smtp: '测试邮件',
  restart_service: '重启服务',
};

export default function Recovery() {
  const { message } = App.useApp();
  const { items, total, loading, fetch, loadDetail, runAction, detail, detailLoading, actingId, actingAction } =
    useDiagnosticStore();
  const rooms = useRoomStore((s) => s.rooms);
  const fetchRooms = useRoomStore((s) => s.fetchRooms);
  const [status, setStatus] = useState<DiagnosticStatus | undefined>();
  const [severity, setSeverity] = useState<string | undefined>();
  const [roomId, setRoomId] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    void fetch({ status, severity, roomId, page, pageSize }).catch(() => message.error('诊断列表加载失败'));
  }, [fetch, status, severity, roomId, page, pageSize, message]);

  useEffect(() => {
    if (rooms.length === 0) void fetchRooms().catch(() => undefined);
  }, [rooms.length, fetchRooms]);

  useEffect(() => {
    if (detailId) void loadDetail(detailId).catch(() => message.error('详情加载失败'));
  }, [detailId, loadDetail, message]);

  const roomName = useMemo(() => new Map(rooms.map((r) => [r.id, r.displayName])), [rooms]);

  const openCount = items.filter((d) => d.status === 'open').length;

  const doAction = async (d: Diagnostic, action: string) => {
    try {
      const res = await runAction(d.id, action);
      message.success(res.diagnostic.status === 'resolved' ? '已解决' : '动作已执行');
    } catch (e) {
      message.error(e instanceof ApiError ? describeError(e.code, e.message) : '动作执行失败');
    }
  };

  const columns: ColumnsType<Diagnostic> = [
    {
      title: '严重度',
      dataIndex: 'severity',
      width: 90,
      render: (v: Diagnostic['severity']) => {
        const m = SEVERITY_META[v];
        return <Tag color={m.color}>{m.text}</Tag>;
      },
    },
    { title: '代码', dataIndex: 'code', width: 170, ellipsis: true },
    {
      title: '建议',
      dataIndex: 'suggestion',
      ellipsis: true,
    },
    {
      title: '房间',
      dataIndex: 'roomId',
      width: 140,
      ellipsis: true,
      render: (id: string | null) => (id ? roomName.get(id) ?? id : '-'),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: DiagnosticStatus) => {
        const m = STATUS_META[v];
        return <Tag color={m.color}>{m.text}</Tag>;
      },
    },
    { title: '发生', dataIndex: 'occurredAt', width: 110, render: formatRelative },
    {
      title: '操作',
      width: 150,
      render: (_, d) => {
        const action = actionForCode(d.code);
        return (
          <Space size={0}>
            <Button size="small" type="link" onClick={() => setDetailId(d.id)}>
              详情
            </Button>
            {d.status === 'open' && action ? (
              <Popconfirm title="确定执行该自愈动作？" onConfirm={() => void doAction(d, action)}>
                <Button size="small" type="link" loading={actingId === d.id && actingAction === action}>
                  修复
                </Button>
              </Popconfirm>
            ) : null}
          </Space>
        );
      },
    },
  ];

  const actionForCode = (code: string): string | null => {
    if (code.includes('RECORDING_START_FAILED')) return 'retry';
    if (code.includes('PLATFORM_ACCESS_RESTRICTED')) return 'refresh_cookie';
    if (code.includes('DISK_SPACE_INSUFFICIENT')) return 'cleanup';
    if (code.includes('SMTP_SEND_FAILED')) return 'test_smtp';
    return null;
  };

  return (
    <div>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <Space size={16}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            自愈工作台
          </Typography.Title>
          <Badge count={openCount} color="red" showZero>
            <Tag>未解决 {openCount}</Tag>
          </Badge>
        </Space>
        <Space wrap>
          <Select
            allowClear
            placeholder="状态"
            style={{ width: 120 }}
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={[
              { value: 'open', label: '未解决' },
              { value: 'processing', label: '处理中' },
              { value: 'resolved', label: '已解决' },
              { value: 'expired', label: '已过期' },
            ]}
          />
          <Select
            allowClear
            placeholder="严重度"
            style={{ width: 110 }}
            value={severity}
            onChange={(v) => {
              setSeverity(v);
              setPage(1);
            }}
            options={[
              { value: 'error', label: '严重' },
              { value: 'warning', label: '警告' },
              { value: 'info', label: '提示' },
            ]}
          />
          <Select
            allowClear
            placeholder="房间"
            style={{ width: 160 }}
            value={roomId}
            onChange={(v) => {
              setRoomId(v);
              setPage(1);
            }}
            options={rooms.map((r) => ({ value: r.id, label: r.displayName }))}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void fetch({ status, severity, roomId, page, pageSize })}>
            刷新
          </Button>
        </Space>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={items}
        loading={loading}
        scroll={{ x: 800 }}
        locale={{ emptyText: '暂无诊断项' }}
        pagination={{
          current: page,
          pageSize,
          total,
          showSizeChanger: true,
          pageSizeOptions: [10, 20, 50],
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, ps) => {
            setPage(p);
            setPageSize(ps);
          },
        }}
      />
      <Drawer
        title="诊断详情"
        open={detailId !== null}
        width={440}
        loading={detailLoading}
        onClose={() => setDetailId(null)}
      >
        {detail ? (
          <Space direction="vertical" style={{ width: '100%' }} size={16}>
            <List size="small" bordered>
              <List.Item>
                <List.Item.Meta title="代码" description={detail.diagnostic.code} />
              </List.Item>
              <List.Item>
                <List.Item.Meta title="建议" description={detail.diagnostic.suggestion} />
              </List.Item>
              <List.Item>
                <List.Item.Meta
                  title="状态"
                  description={STATUS_META[detail.diagnostic.status].text}
                />
              </List.Item>
              {detail.diagnostic.details ? (
                <List.Item>
                  <List.Item.Meta
                    title="详情"
                    description={<pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(detail.diagnostic.details, null, 2)}</pre>}
                  />
                </List.Item>
              ) : null}
            </List>
            {detail.diagnostic.status === 'open' && actionForCode(detail.diagnostic.code) ? (
              <Popconfirm
                title="确定执行该自愈动作？"
                onConfirm={() => void doAction(detail.diagnostic, actionForCode(detail.diagnostic.code)!)}
              >
                <Button
                  type="primary"
                  loading={actingId === detail.diagnostic.id}
                >
                  {ACTION_LABEL[actionForCode(detail.diagnostic.code)!] ?? '执行修复'}
                </Button>
              </Popconfirm>
            ) : null}
            <Typography.Title level={5} style={{ marginBottom: 0 }}>
              动作记录
            </Typography.Title>
            <Timeline
              items={detail.actions.map((a: { performedAt: string; action: string; result: string; detail: string | null }) => ({
                color: a.result === 'ok' ? 'green' : 'red',
                children: (
                  <div>
                    <Typography.Text strong>{ACTION_LABEL[a.action] ?? a.action}</Typography.Text>
                    <br />
                    <Typography.Text type="secondary">{formatRelative(a.performedAt)}</Typography.Text>
                    {a.detail ? (
                      <>
                        <br />
                        <Typography.Text type="secondary">{a.detail}</Typography.Text>
                      </>
                    ) : null}
                  </div>
                ),
              }))}
            />
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}