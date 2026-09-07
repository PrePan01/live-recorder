import { useEffect } from 'react';
import { Button, Result, Space, Steps, Spin, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useBootStore } from '../../stores/bootStore';

const STEPS = ['获取实例锁', '启动本地服务', '检查健康与目录', '准备工作台'];

export default function Startup() {
  const { state, restart, refreshDiagnostics } = useBootStore();
  const navigate = useNavigate();
  // 原生接口返回前尚不能确认健康检查完成，不按计时器伪造启动进度。
  const step = state === 'ready' ? 3 : 1;

  useEffect(() => {
    if (state === 'ready') {
      void refreshDiagnostics();
      navigate('/monitor', { replace: true });
    }
  }, [state, navigate, refreshDiagnostics]);

  if (state === 'degraded') {
    return (
      <div className="lr-startup-page lr-startup-page--centered">
        <Result
          status="warning"
          title="服务未就绪"
          subTitle="本地服务启动失败，请查看诊断详情后重试。"
          extra={
            <Space>
              <Button onClick={() => navigate('/startup-diagnostics')}>打开诊断</Button>
              <Button type="primary" onClick={() => void restart()}>
                安全重试
              </Button>
            </Space>
          }
        />
      </div>
    );
  }

  if (state === 'existing-instance') {
    return (
      <div className="lr-startup-page lr-startup-page--centered">
        <Result
          status="info"
          title="已有实例在运行"
          subTitle="已将现有窗口带到前台，本窗口将自动关闭。"
          extra={<Button onClick={() => window.close()}>关闭本窗口</Button>}
        />
      </div>
    );
  }

  return (
    <div className="lr-startup-page lr-startup-page--loading">
      <Typography.Title level={3} style={{ margin: 0 }}>
        Live Recorder
      </Typography.Title>
      <Spin size="large" />
      <Steps
        current={step}
        orientation="vertical"
        size="small"
        style={{ maxWidth: 320, marginTop: 8 }}
        items={STEPS.map((title) => ({ title }))}
      />
    </div>
  );
}
