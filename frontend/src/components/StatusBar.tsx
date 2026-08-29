import { useEffect } from 'react';
import { Badge, Button, Popover, Progress, Space, Tag, Typography, List } from 'antd';
import { CloudServerOutlined, WarningOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { useServiceStore } from '../stores/serviceStore';
import { useAlertStore, selectUnreadCount } from '../stores/alertStore';
import { formatBytes, formatRelative } from '../utils/format';
import GlobalSearch from './GlobalSearch';

export default function StatusBar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const status = useServiceStore((s) => s.status);
  const sseConnected = useServiceStore((s) => s.sseConnected);
  const alerts = useAlertStore((s) => s.alerts);
  const unread = useAlertStore(selectUnreadCount);
  const fetchAlerts = useAlertStore((s) => s.fetchAlerts);
  const markRead = useAlertStore((s) => s.markRead);
  const markAllRead = useAlertStore((s) => s.markAllRead);
  const retryFailure = useAlertStore((s) => s.retryFailure);
  const retryingId = useAlertStore((s) => s.retryingId);

  useEffect(() => {
    void fetchAlerts();
  }, [fetchAlerts]);

  useEffect(() => {
    const t = setInterval(() => void useServiceStore.getState().fetchStatus(), 300_000);
    return () => clearInterval(t);
  }, []);

  const online = status?.state === 'running' && sseConnected;
  const free = status?.disk?.freeBytes ?? 0;
  const total = status?.disk?.totalBytes ?? 1;
  const freeRatio = total > 0 ? free / total : 0;
  const spaceDanger = free < 20_000_000_000 || freeRatio < 0.1;
  const isSettingsPage = pathname.startsWith('/settings');

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 24,
        padding: '0 24px',
        background: 'var(--lr-surface)',
        borderBottom: '1px solid var(--lr-border)',
        height: 48,
      }}
    >
      <Space>
        <CloudServerOutlined style={{ color: online ? '#52c41a' : '#ff4d4f' }} />
        <Typography.Text strong>
          {status?.state === 'restarting' ? '服务重启中' : online ? '服务正常' : '服务已断开'}
        </Typography.Text>
        {status?.version ? <Tag>{status.version}</Tag> : null}
        <Tag color={status && status.activeRecordings > 0 ? 'red' : 'default'}>
          {status ? `录制中 ${status.activeRecordings}` : '录制中 -'}
        </Tag>
      </Space>
      <GlobalSearch />
      <Space>
        <Typography.Text type={spaceDanger ? 'danger' : 'secondary'}>
          {spaceDanger ? '⚠ 磁盘空间不足' : '磁盘可用'}
        </Typography.Text>
        <Progress
          percent={Math.round(freeRatio * 100)}
          status={spaceDanger ? 'exception' : 'normal'}
          size="small"
          style={{ width: 120 }}
          format={() => formatBytes(free)}
        />
        {spaceDanger ? <Tag color="red">需清理</Tag> : null}
      </Space>
      <div style={{ marginLeft: 'auto' }}>
        <Popover
          trigger="click"
          placement="bottomRight"
          content={
            <List
              size="small"
              style={{ width: 360, maxHeight: 400, overflow: 'auto' }}
              header={
                <Space>
                  <Typography.Text strong>告警</Typography.Text>
                  <Button size="small" disabled={isSettingsPage} onClick={() => void markAllRead()}>
                    全部已读
                  </Button>
                  {!isSettingsPage && (
                    <Button size="small" type="link" onClick={() => navigate('/settings')}>
                      查看全部
                    </Button>
                  )}
                </Space>
              }
              dataSource={alerts.slice(0, 8)}
              locale={{ emptyText: '暂无告警' }}
              renderItem={(a) => (
                <List.Item
                  actions={
                    a.resolved
                      ? []
                      : [
                          a.roomId && a.failureReason ? (
                            <Button
                              key="retry"
                              size="small"
                              type="link"
                              loading={retryingId === a.id}
                              onClick={() => void retryFailure(a).catch(() => undefined)}
                            >
                              重试
                            </Button>
                          ) : null,
                          <Button key="read" size="small" type="link" onClick={() => void markRead(a.id)}>
                            已读
                          </Button>,
                        ]
                  }
                >
                  <List.Item.Meta
                    title={a.message}
                    description={
                      <Space direction="vertical" size={0}>
                        <span>
                          {a.source} · {formatRelative(a.occurredAt)}
                        </span>
                        {a.failureReason ? (
                          <Typography.Text type="danger">
                            [{a.failureReason.code}] {a.failureReason.message}
                          </Typography.Text>
                        ) : null}
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          }
        >
          <Badge count={unread} size="small" offset={[-4, 4]}>
            <Button type="text" icon={<WarningOutlined style={{ fontSize: 18 }} />} />
          </Badge>
        </Popover>
      </div>
    </div>
  );
}
