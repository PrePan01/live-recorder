import { useEffect, useState } from 'react';
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

function RollingDigit({ value }: { value: string }) {
  const [rolling, setRolling] = useState<{ current: string; previous: string | null }>({
    current: value,
    previous: null,
  });

  useEffect(() => {
    setRolling((state) =>
      state.current === value
        ? state
        : { current: value, previous: state.current },
    );
    const timer = window.setTimeout(() => {
      setRolling((state) => ({ current: state.current, previous: null }));
    }, 260);
    return () => window.clearTimeout(timer);
  }, [value]);

  return (
    <span className="lr-stat__rolling-digit">
      {rolling.previous ? <span className="lr-stat__value--rolling-old">{rolling.previous}</span> : null}
      <span className={rolling.previous ? "lr-stat__value--rolling-new" : undefined}>{rolling.current}</span>
    </span>
  );
}

function RollingNumber({ value }: { value: string }) {
  return (
    <span className="lr-stat__rolling-number">
      {[...value].map((digit, index) => (
        <RollingDigit key={index} value={digit} />
      ))}
    </span>
  );
}

function RollingDuration({ value }: { value: string }) {
  const parts = value.match(/\d+|[^\d]+/g) ?? [value];
  return (
    <div className="lr-stat__value lr-stat__value--recording lr-stat__value--rolling">
      {parts.map((part, index) =>
        /^\d+$/.test(part) ? (
          <RollingNumber key={`number-${index}`} value={part} />
        ) : (
          <span key={`unit-${index}`}>{part}</span>
        ),
      )}
    </div>
  );
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
  const duration = durationValue(startedAt, now);
  const [lastDuration, setLastDuration] = useState(duration);

  // Keep the final time visible during fade-out when activeRecording is cleared.
  if (recording && lastDuration !== duration) {
    setLastDuration(duration);
  }

  return (
    <div ref={ref} style={{ display: 'flex', gap: 8, width: '100%' }}>
      <StatCard label="最近检测" value={agoValue(lastCheckedAt, now)} tone={tone} />
      <div
        className={`lr-stat lr-stat--duration${recording ? ' lr-stat--duration-visible' : ''}`}
        aria-hidden={!recording}
      >
        <div className="lr-stat__label">已录制</div>
        <RollingDuration value={recording ? duration : lastDuration} />
      </div>
    </div>
  );
}
