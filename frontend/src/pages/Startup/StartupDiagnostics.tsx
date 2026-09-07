import { Alert, Button, Card, Space, Spin, Typography } from 'antd';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBootStore } from '../../stores/bootStore';

export default function StartupDiagnostics() {
  const { diagnostics, refreshDiagnostics, boot, restart, state, loading } =
    useBootStore();
  const navigate = useNavigate();

  useEffect(() => {
    void refreshDiagnostics();
    if (!loading) return;
    const timer = setInterval(() => void refreshDiagnostics(), 1000);
    return () => clearInterval(timer);
  }, [refreshDiagnostics, loading]);

  return (
    <div className="lr-diagnostics-page">
      <Card
        title="启动诊断"
        extra={
          <Space>
            <Button onClick={() => navigate('/monitor')}>返回工作台</Button>
            <Button
              type="primary"
              onClick={() => void boot()}
              loading={loading}
            >
              重试连接
            </Button>
            <Button onClick={() => void restart()} disabled={loading}>
              重启服务
            </Button>
          </Space>
        }
      >
        <Spin spinning={loading}>
          <Space orientation="vertical" style={{ width: '100%' }} size="middle">
            {diagnostics.length === 0 && (
              <Typography.Text type="secondary">正在检查…</Typography.Text>
            )}
            {diagnostics.map((item) => (
              <Alert
                key={item.key}
                type={
                  item.status === 'ok'
                    ? 'success'
                    : item.status === 'warn'
                      ? 'info'
                      : 'error'
                }
                showIcon
                message={item.message}
                description={
                  item.detail ? (
                    <pre
                      style={{
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                      }}
                    >
                      {item.detail}
                    </pre>
                  ) : undefined
                }
              />
            ))}
            {state === 'ready' && (
              <Alert type="success" showIcon message="本地服务运行正常" />
            )}
          </Space>
        </Spin>
      </Card>
    </div>
  );
}
