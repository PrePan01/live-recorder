import { Alert, Button, Card, Space, Spin, Typography } from 'antd';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBootStore } from '../../stores/bootStore';

export default function StartupDiagnostics() {
  const { diagnostics, refreshDiagnostics, restart, state, loading } = useBootStore();
  const navigate = useNavigate();

  useEffect(() => {
    void refreshDiagnostics();
  }, [refreshDiagnostics]);

  return (
    <div style={{ height: '100vh', overflow: 'auto', padding: 24 }}>
      <Card
        title="启动诊断"
        extra={
          <Space>
            <Button onClick={() => navigate('/monitor')}>返回工作台</Button>
            <Button type="primary" onClick={() => void restart()} loading={loading}>
              安全重试
            </Button>
          </Space>
        }
      >
        <Spin spinning={loading}>
          <Space orientation="vertical" style={{ width: '100%' }} size="middle">
            {diagnostics.length === 0 && <Typography.Text type="secondary">正在检查…</Typography.Text>}
            {diagnostics.map((item) => (
              <Alert
                key={item.key}
                type="error"
                showIcon
                message={item.message}
                description={item.detail || undefined}
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