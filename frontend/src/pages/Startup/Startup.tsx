import { useEffect } from 'react';
import { Button, Result, Space, Steps, Spin, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useBootStore } from '../../stores/bootStore';

const STEPS = ['获取实例锁', '启动本地服务', '检查健康与目录', '准备工作台'];

export default function Startup() {
  const {
    state,
    boot,
    restart,
    refreshDiagnostics,
    diagnostics,
    loading,
    slow,
  } = useBootStore();
  const navigate = useNavigate();
  // 原生接口返回前尚不能确认健康检查完成，不按计时器伪造启动进度。
  const phase = diagnostics[0]?.key;
  const step =
    state === 'ready'
      ? 3
      : phase === 'health'
        ? 2
        : phase === 'starting'
          ? 1
          : 0;
  useEffect(() => {
    if (!loading) return;
    void refreshDiagnostics();
    const timer = setInterval(() => void refreshDiagnostics(), 1000);
    return () => clearInterval(timer);
  }, [loading, refreshDiagnostics]);

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
          subTitle={
            diagnostics[0]?.detail?.split('\n')[0] ||
            diagnostics[0]?.message ||
            '本地服务暂未连接，可重试连接或查看诊断。'
          }
          extra={
            <Space>
              <Button onClick={() => navigate('/startup-diagnostics')}>
                打开诊断
              </Button>
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
      <Typography.Text>
        {diagnostics[0]?.message || '正在检查本地服务'}
      </Typography.Text>
      {slow && (
        <Typography.Text type="secondary">
          启动耗时较长，仍在等待当前进程；完成后会自动进入工作台。
        </Typography.Text>
      )}
      <Button type="link" onClick={() => navigate('/startup-diagnostics')}>
        查看启动详情
      </Button>
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
