import { useEffect } from 'react';
import type { JSX } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { NavigateBlock } from './NavigateGuard';
import AppLayout from './components/AppLayout';
import Setup from './pages/Setup';
import Rooms from './pages/Rooms';
import Monitor from './pages/Monitor';
import History from './pages/History';
import SettingsPage from './pages/Settings';
import Recovery from './pages/Recovery';
import Stats from './pages/Stats';
import Startup from './pages/Startup';
import StartupDiagnostics from './pages/StartupDiagnostics';
import { useSSE } from './hooks/useSSE';
import { useServiceStore } from './stores/serviceStore';
import { useBootStore, subscribeBridgeEvents } from './stores/bootStore';
import RecordingCompleteNotice from './components/RecordingCompleteNotice';

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
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
          <Route path="/" element={<Navigate to="/monitor" replace />} />
          <Route path="*" element={<Navigate to="/monitor" replace />} />
        </Routes>
      </BootGate>
    </>
  );
}