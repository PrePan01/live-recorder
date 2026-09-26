import { lazy, useEffect } from "react";
import type { JSX } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { NavigateBlock } from "./NavigateGuard";
import AppLayout from "./components/AppLayout";
import Setup from "./pages/Setup";
import Monitor from "./pages/Monitor";
import Startup from "./pages/Startup";
import StartupDiagnostics from "./pages/StartupDiagnostics";
import { useSSE } from "./hooks/useSSE";
import { useServiceStore } from "./stores/serviceStore";
import {
  bridge,
  useBootStore,
  subscribeBridgeEvents,
} from "./stores/bootStore";
import { useSettingsStore } from "./stores/settingsStore";
import { recordRecentErrorAction } from "./utils/errorDiagnostics";
import RecordingCompleteNotice from "./components/RecordingCompleteNotice";
import OpenList2faModal from "./components/OpenList2faModal";
import GlobalErrorNotice from "./components/GlobalErrorNotice";
import SetupCelebration from "./components/SetupCelebration";
import { LAZY_ROUTE_PATHS, loadRoute } from "./routes/preload";

const Rooms = lazy(() => loadRoute("/rooms"));
const History = lazy(() => loadRoute("/history"));
const SettingsPage = lazy(() => loadRoute("/settings"));
const Recovery = lazy(() => loadRoute("/recovery"));
const Stats = lazy(() => loadRoute("/stats"));
const Wall = lazy(() => loadRoute("/wall"));

function SetupGuard({ children }: { children: JSX.Element }) {
  const status = useServiceStore((s) => s.status);
  const fetchStatus = useServiceStore((s) => s.fetchStatus);
  const error = useServiceStore((s) => s.error);
  const { pathname } = useLocation();

  useEffect(() => {
    if (status) return;
    void fetchStatus();
    const timer = setInterval(() => {
      // 后台不轮询界面状态（业务在后端；仅连接建立前的短窗口，回前台下一轮即补）。
      if (document.visibilityState !== "visible") return;
      void fetchStatus();
    }, 5000);
    return () => clearInterval(timer);
  }, [status, fetchStatus]);

  if (!status)
    return <NavigateBlock error={error} onRetry={() => void fetchStatus()} />;
  if (!status.setupCompleted && pathname !== "/setup")
    return <Navigate to="/setup" replace />;
  if (status.setupCompleted && pathname === "/setup")
    return <Navigate to="/monitor" replace />;
  return children;
}

function BootGate({ children }: { children: JSX.Element }) {
  const state = useBootStore((s) => s.state);
  const { pathname } = useLocation();

  if (pathname === "/startup-diagnostics") return children;

  if (state !== "ready") {
    if (pathname === "/startup") return children;
    return <Navigate to="/startup" replace />;
  }
  return children;
}

export default function App() {
  useSSE();
  const boot = useBootStore((s) => s.boot);
  const bootState = useBootStore((s) => s.state);
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.load);
  const { pathname } = useLocation();

  useEffect(() => {
    recordRecentErrorAction(`navigation:${pathname}`);
  }, [pathname]);

  useEffect(() => {
    // 无障碍：antd Select 的 aria-label 不透传到内层 combobox input（label[for] 又指向
    // 不可标注的容器）——就近回填（控件自身 aria-label → 所属 Form.Item 标签文本）。
    const fill = () => {
      document
        .querySelectorAll<HTMLInputElement>("input.ant-select-input")
        .forEach((el) => {
          if (el.hasAttribute("aria-label")) return;
          const own =
            el.closest(".ant-select")?.getAttribute("aria-label") ?? null;
          const fiLabel = el
            .closest(".ant-form-item")
            ?.querySelector(".ant-form-item-label label")
            ?.textContent?.trim();
          const name = own || (fiLabel || null);
          if (name) el.setAttribute("aria-label", name);
        });
    };
    fill();
    const observer = new MutationObserver(fill);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const unsub = subscribeBridgeEvents();
    if (useBootStore.getState().state === "booting") void boot();
    return unsub;
  }, [boot]);

  useEffect(() => {
    if (bootState !== "ready" || settings) return;
    void loadSettings();
  }, [bootState, loadSettings, settings]);

  useEffect(() => {
    if (bootState !== "ready" || !bridge.isDesktop || !settings) return;
    void bridge
      .setFloatingRecorderSize(settings.floatingRecorderSize ?? 36)
      .catch(() => undefined);
  }, [bootState, settings]);

  useEffect(() => {
    if (bootState !== "ready") return;
    let disposed = false;
    let index = 0;
    const warmNext = () => {
      if (disposed || index >= LAZY_ROUTE_PATHS.length) return;
      const path = LAZY_ROUTE_PATHS[index++]!;
      const idle = (
        window as Window & {
          requestIdleCallback?: (
            cb: () => void,
            options?: { timeout: number },
          ) => number;
        }
      ).requestIdleCallback;
      const schedule = idle
        ? (cb: () => void) => idle(cb, { timeout: 2_000 })
        : (cb: () => void) => window.setTimeout(cb, 250);
      schedule(() => {
        if (disposed) return;
        void loadRoute(path)
          .catch(() => undefined)
          .finally(warmNext);
      });
    };
    warmNext();
    return () => {
      disposed = true;
    };
  }, [bootState]);

  return (
    <>
      <GlobalErrorNotice />
      <SetupCelebration />
      <RecordingCompleteNotice />
      <OpenList2faModal />
      <BootGate>
        <Routes>
          <Route path="/startup" element={<Startup />} />
          <Route path="/startup-diagnostics" element={<StartupDiagnostics />} />
          <Route
            path="/setup"
            element={
              <SetupGuard>
                <Setup />
              </SetupGuard>
            }
          />
          <Route
            element={
              <SetupGuard>
                <AppLayout />
              </SetupGuard>
            }
          >
            <Route path="/rooms" element={<Rooms />} />
            <Route path="/monitor" element={<Monitor />} />
            <Route path="/history" element={<History />} />
            <Route path="/recovery" element={<Recovery />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/wall" element={<Wall />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="/" element={<Navigate to="/monitor" replace />} />
          <Route path="*" element={<Navigate to="/monitor" replace />} />
        </Routes>
      </BootGate>
    </>
  );
}
