import { Layout, Menu } from 'antd';
import {
  DashboardOutlined,
  HistoryOutlined,
  SettingOutlined,
  VideoCameraOutlined,
  ToolOutlined,
  BarChartOutlined,
  AppstoreOutlined,
} from '@ant-design/icons';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import StatusBar from './StatusBar';
import { useAppTheme } from '../theme';

const { Sider, Content, Header } = Layout;

const ITEMS = [
  { key: '/monitor', icon: <DashboardOutlined />, label: <NavLink to="/monitor">监控总览</NavLink> },
  { key: '/rooms', icon: <VideoCameraOutlined />, label: <NavLink to="/rooms">直播间</NavLink> },
  { key: '/history', icon: <HistoryOutlined />, label: <NavLink to="/history">录制历史</NavLink> },
  { key: '/wall', icon: <AppstoreOutlined />, label: <NavLink to="/wall">直播墙</NavLink> },
  { key: '/stats', icon: <BarChartOutlined />, label: <NavLink to="/stats">统计看板</NavLink> },
  { key: '/recovery', icon: <ToolOutlined />, label: <NavLink to="/recovery">自愈工作台</NavLink> },
  { key: '/settings', icon: <SettingOutlined />, label: <NavLink to="/settings">设置</NavLink> },
];

export default function AppLayout() {
  const { pathname } = useLocation();
  const { mode } = useAppTheme();
  return (
    <Layout className="lr-app-shell" style={{ height: '100vh', overflow: 'hidden' }}>
      <Header className="lr-app-header" style={{ padding: 0, background: 'var(--lr-surface)', lineHeight: 'normal', flexShrink: 0, height: 48 }}>
        <StatusBar />
      </Header>
      <Layout>
        <Sider
          className="lr-app-sider"
          theme={mode === 'dark' ? 'dark' : 'light'}
          width={180}
          collapsible
          breakpoint="md"
          collapsedWidth={48}
          style={{ borderRight: '1px solid var(--lr-border)', overflow: 'auto' }}
        >
          <div className="lr-app-brand">直播录制台</div>
          <Menu
            mode="inline"
            selectedKeys={[ITEMS.find((i) => pathname.startsWith(i.key))?.key ?? '']}
            items={ITEMS}
            style={{ paddingTop: 4 }}
          />
        </Sider>
        <Content
          className="lr-app-content"
          style={{
            padding: 'clamp(12px, 2vw, 24px)',
            overflow: 'auto',
            minWidth: 0,
          }}
        >
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
