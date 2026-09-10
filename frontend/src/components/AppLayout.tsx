import { Suspense, useEffect, useState, useTransition } from "react";
import { Layout, Menu, Spin } from "antd";
import {
  DashboardOutlined,
  HistoryOutlined,
  SettingOutlined,
  VideoCameraOutlined,
  ToolOutlined,
  BarChartOutlined,
  AppstoreOutlined,
} from "@ant-design/icons";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import StatusBar from "./StatusBar";
import { useAppTheme } from "../theme";
import AppVersion from "./AppVersion";
import LazyRouteErrorBoundary from "./LazyRouteErrorBoundary";
import { preloadRoute } from "../routes/preload";

const { Sider, Content, Footer } = Layout;

const SIDEBAR_COLLAPSED_STORAGE_KEY = "lr-sidebar-collapsed";

function readSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    // Storage can be unavailable in restricted WebViews; keep the default UI.
    return false;
  }
}

const ITEMS = [
  {
    key: "/monitor",
    icon: <DashboardOutlined />,
    label: (
      <span onPointerEnter={() => preloadRoute("/monitor")}>监控总览</span>
    ),
  },
  {
    key: "/rooms",
    icon: <VideoCameraOutlined />,
    label: <span onPointerEnter={() => preloadRoute("/rooms")}>直播间</span>,
  },
  {
    key: "/history",
    icon: <HistoryOutlined />,
    label: (
      <span onPointerEnter={() => preloadRoute("/history")}>录制历史</span>
    ),
  },
  {
    key: "/wall",
    icon: <AppstoreOutlined />,
    label: <span onPointerEnter={() => preloadRoute("/wall")}>直播墙</span>,
  },
  {
    key: "/stats",
    icon: <BarChartOutlined />,
    label: <span onPointerEnter={() => preloadRoute("/stats")}>统计看板</span>,
  },
  {
    key: "/recovery",
    icon: <ToolOutlined />,
    label: (
      <span onPointerEnter={() => preloadRoute("/recovery")}>自愈工作台</span>
    ),
  },
  {
    key: "/settings",
    icon: <SettingOutlined />,
    label: <span onPointerEnter={() => preloadRoute("/settings")}>设置</span>,
  },
];

export default function AppLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // Keep the clicked item responsive while the next route is rendering. The
  // route update is intentionally lower priority so a heavy page cannot make
  // the navigation surface feel stuck.
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const { mode } = useAppTheme();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const [sidebarBelowBreakpoint, setSidebarBelowBreakpoint] = useState(false);

  useEffect(() => {
    setPendingPath(null);
  }, [pathname]);

  const selectedPath = pendingPath ?? pathname;

  const handleSidebarCollapse = (
    collapsed: boolean,
    type: "clickTrigger" | "responsive",
  ) => {
    // Sider emits a responsive event while it mounts. It reflects the current
    // viewport rather than a user choice, so saving it would overwrite the
    // remembered state on every refresh.
    if (type !== "clickTrigger") return;

    setSidebarCollapsed(collapsed);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
      // Storage can be unavailable in restricted WebViews; state still works
      // for the current session.
    }
  };

  return (
    <Layout
      className="lr-app-shell"
      style={{ height: "100vh", overflow: "hidden" }}
    >
      <Layout>
        <Sider
          className="lr-app-sider"
          theme={mode === "dark" ? "dark" : "light"}
          width={180}
          collapsible
          breakpoint="md"
          collapsedWidth={48}
          collapsed={sidebarBelowBreakpoint || sidebarCollapsed}
          onCollapse={handleSidebarCollapse}
          onBreakpoint={setSidebarBelowBreakpoint}
          style={{
            borderRight: "1px solid var(--lr-border)",
            overflow: "hidden",
          }}
        >
          <div className="lr-app-brand">
            <img src="/icon1.png" alt="直播录制台" draggable={false} />
            <span>直播录制台</span>
          </div>
          <Menu
            mode="inline"
            selectedKeys={[
              ITEMS.find((i) => selectedPath.startsWith(i.key))?.key ?? "",
            ]}
            items={ITEMS}
            onClick={({ key }) => {
              const destination = String(key);
              if (destination !== pathname) {
                setPendingPath(destination);
                startTransition(() => navigate(destination));
              }
            }}
            style={{ paddingTop: 4 }}
          />
          <AppVersion />
        </Sider>
        <Content
          className="lr-app-content"
          style={{
            padding: "clamp(12px, 2vw, 24px)",
            overflow: "auto",
            minWidth: 0,
            position: "relative",
          }}
        >
          {/* Keep navigation and the status bar alive when one page fails. */}
          <LazyRouteErrorBoundary key={pathname}>
            <Suspense
              fallback={
                <div
                  style={{
                    minHeight: 180,
                    display: "grid",
                    placeItems: "center",
                    background: "#fff",
                  }}
                ></div>
              }
            >
              <Outlet />
            </Suspense>
          </LazyRouteErrorBoundary>
          {isPending ? (
            <div
              role="status"
              aria-label="正在加载页面"
              style={{
                position: "absolute",
                inset: 0,
                display: "grid",
                placeItems: "center",
                background:
                  "color-mix(in srgb, var(--lr-surface) 0%, transparent)",
                pointerEvents: "none",
                zIndex: 2,
              }}
            >
              <Spin />
            </div>
          ) : null}
        </Content>
      </Layout>
      <Footer
        className="lr-app-footer"
        style={{
          padding: 0,
          background: "var(--lr-surface)",
          lineHeight: "normal",
          flexShrink: 0,
          height: 36,
        }}
      >
        <StatusBar />
      </Footer>
    </Layout>
  );
}
