import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import StatCard from './StatCard';

function agoValue(iso: string | null): string {
  if (!iso) return '—';
  const diff = Math.max(dayjs().diff(dayjs(iso), 'second'), 0);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function durationValue(startedAt: string | null): string {
  if (!startedAt) return '—';
  const sec = Math.max(dayjs().diff(dayjs(startedAt), 'second'), 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s).padStart(2, '0')}s`;
}

export default function RoomStats({
  lastCheckedAt,
  startedAt,
  state,
}: {
  lastCheckedAt: string | null;
  startedAt: string | null;
  state: 'recording' | 'reconnecting' | 'checking' | 'failed' | 'idle' | 'completed' | 'disabled';
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const recording = state === 'recording' || state === 'reconnecting';
  const tone = state === 'failed' ? 'failed' : recording ? 'recording' : state === 'checking' ? 'checking' : 'default';

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <StatCard label="最近检测" value={agoValue(lastCheckedAt)} tone={tone} />
      <StatCard label="已录制" value={durationValue(startedAt)} tone={recording ? 'recording' : 'default'} />
    </div>
  );
}