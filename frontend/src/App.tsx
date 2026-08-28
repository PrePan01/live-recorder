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
import { useSSE } from './hooks/useSSE';
import { useServiceStore } from './stores/serviceStore';
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

export default function App() {
  useSSE();
  return (
    <>
      <RecordingCompleteNotice />
      <Routes>
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
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="/" element={<Navigate to="/monitor" replace />} />
      <Route path="*" element={<Navigate to="/monitor" replace />} />
      </Routes>
    </>
  );
}
