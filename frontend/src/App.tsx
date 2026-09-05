import { lazy, Suspense, useEffect } from 'react';
import type { JSX } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { NavigateBlock } from './NavigateGuard';
import AppLayout from './components/AppLayout';
import Setup from './pages/Setup';
import Monitor from './pages/Monitor';
import Startup from './pages/Startup';
import StartupDiagnostics from './pages/StartupDiagnostics';
import { useSSE } from './hooks/useSSE';
import { useServiceStore } from './stores/serviceStore';
import { useBootStore, subscribeBridgeEvents } from './stores/bootStore';
import RecordingCompleteNotice from './components/RecordingCompleteNotice';
import OpenList2faModal from './components/OpenList2faModal';
import LazyRouteErrorBoundary from './components/LazyRouteErrorBoundary';

// 路由级懒加载：重页面按需拆分，首屏 bundle 显著变小（QA 性能建议）。
const Rooms = lazy(() => import('./pages/Rooms'));
const History = lazy(() => import('./pages/History'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const Recovery = lazy(() => import('./pages/Recovery'));
const Stats = lazy(() => import('./pages/Stats'));
const Wall = lazy(() => import('./pages/Wall'));

function SetupGuard({ children }: { children: JSX.Element }) {
  const status = useServiceStore((s) => s.status);
  const fetchStatus = useServiceStore((s) => s.fetchStatus);
  const { pathname } = useLocation();

  useEffect(() => {
    if (!status) void fetchStatus();
  }, [status, fetchStatus]);

  if (!status) return <NavigateBlock />;
  if (!status.setupCompleted && pathname !== '/setup') return <Navigate to="/setup" replace />;
  if (status.setupCompleted && pathname === '/setup') return <Navigate to="/monitor" replace />;
  return children;
}

function BootGate({ children }: { children: JSX.Element }) {
  const state = useBootStore((s) => s.state);
  const { pathname } = useLocation();

  if (pathname === '/startup-diagnostics') return children;

  if (state !== 'ready') {
    // Booting/degraded/existing-instance all funnel through the startup page.
    if (pathname === '/startup') return children;
    return <Navigate to="/startup" replace />;
  }
  return children;
}

export default function App() {
  useSSE();
  const bootState = useBootStore((s) => s.state);
  const boot = useBootStore((s) => s.boot);

  useEffect(() => {
    const unsub = subscribeBridgeEvents();
    if (bootState === 'booting') void boot();
    return unsub;
  }, [bootState, boot]);

  return (
    <>
      <RecordingCompleteNotice />
      <OpenList2faModal />
      <BootGate>
        <LazyRouteErrorBoundary>
          <Suspense fallback={<div style={{ height: '100vh', display: 'grid', placeItems: 'center' }}>加载中…</div>}>
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
          </Suspense>
        </LazyRouteErrorBoundary>
      </BootGate>
    </>
  );
}