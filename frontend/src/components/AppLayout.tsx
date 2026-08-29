import { Layout, Menu } from 'antd';
import {
  DashboardOutlined,
  HistoryOutlined,
  SettingOutlined,
  VideoCameraOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import StatusBar from './StatusBar';
import { useAppTheme } from '../theme';

const { Sider, Content, Header } = Layout;

const ITEMS = [
  { key: '/monitor', icon: <DashboardOutlined />, label: <NavLink to="/monitor">监控总览</NavLink> },
  { key: '/rooms', icon: <VideoCameraOutlined />, label: <NavLink to="/rooms">直播间</NavLink> },
  { key: '/history', icon: <HistoryOutlined />, label: <NavLink to="/history">录制历史</NavLink> },
  { key: '/recovery', icon: <ToolOutlined />, label: <NavLink to="/recovery">自愈工作台</NavLink> },
  { key: '/settings', icon: <SettingOutlined />, label: <NavLink to="/settings">设置</NavLink> },
];

export default function AppLayout() {
  const { pathname } = useLocation();
  const { mode } = useAppTheme();
  return (
    <Layout style={{ height: '100vh', overflow: 'hidden' }}>
      <Header style={{ padding: 0, background: 'var(--lr-surface)', lineHeight: 'normal', flexShrink: 0 }}>
        <StatusBar />
      </Header>
      <Layout>
        <Sider theme={mode === 'dark' ? 'dark' : 'light'} width={180} style={{ borderRight: '1px solid var(--lr-border)', overflow: 'auto' }}>
          <div style={{ fontWeight: 700, fontSize: 16, padding: '16px 24px' }}>直播录制台</div>
          <Menu
            mode="inline"
            selectedKeys={[ITEMS.find((i) => pathname.startsWith(i.key))?.key ?? '']}
            items={ITEMS}
            style={{ paddingTop: 4 }}
          />
        </Sider>
        <Content style={{ padding: 24, overflow: 'auto' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
