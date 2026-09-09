import dayjs from 'dayjs';
import StatCard from './StatCard';
import { useDisplayClock, useElementVisible } from '../hooks/useDisplayClock';

function agoValue(iso: string | null, now: number): string {
  if (!iso) return '—';
  const diff = Math.max(dayjs(now).diff(dayjs(iso), 'second'), 0);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function durationValue(startedAt: string | null, now: number): string {
  if (!startedAt) return '—';
  const sec = Math.max(dayjs(now).diff(dayjs(startedAt), 'second'), 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`;
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
  const [ref, visible] = useElementVisible<HTMLDivElement>();
  const now = useDisplayClock(visible);

  const recording = state === 'recording' || state === 'reconnecting';
  const tone = state === 'failed' ? 'failed' : recording ? 'recording' : state === 'checking' ? 'checking' : 'default';

  return (
    <div ref={ref} style={{ display: 'flex', gap: 8, width: '100%' }}>
      <StatCard label="最近检测" value={agoValue(lastCheckedAt, now)} tone={tone} />
      <StatCard label="已录制" value={durationValue(startedAt, now)} tone={recording ? 'recording' : 'default'} />
    </div>
  );
}
