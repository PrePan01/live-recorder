import { Spin } from 'antd';

export function NavigateBlock() {
  return (
    <div style={{ height: '100vh', display: 'grid', placeItems: 'center' }}>
      <Spin size="large" description="连接本地服务…" />
    </div>
  );
}
