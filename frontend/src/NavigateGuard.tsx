import { Button, Result, Spin } from 'antd';

export function NavigateBlock({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  return (
    <div className="lr-startup-page lr-memphis-pattern lr-system-result" style={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
      {error ? (
        <Result status="warning" title="暂时无法连接本地服务" subTitle={`${error} 正在自动重连。`}
          extra={<Button onClick={onRetry}>立即重试</Button>} />
      ) : <Spin size="large" description="连接本地服务…" />}
    </div>
  );
}
