import type { LiveStatus } from '../types/room';

const META: Record<LiveStatus, { color: string; text: string; icon: string }> = {
  live: { color: 'var(--lr-success)', text: '直播中', icon: '●' },
  offline: { color: 'var(--lr-text-tertiary)', text: '未开播', icon: '○' },
  restricted: { color: 'var(--lr-warning)', text: '受限', icon: '◐' },
};

export default function LiveStatusTag({ status }: { status: LiveStatus | null }) {
  if (!status) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--lr-text-tertiary)' }} />
        <span style={{ fontSize: 12, color: 'var(--lr-text-secondary)' }}>未检测</span>
      </span>
    );
  }
  const meta = META[status];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: meta.color,
          boxShadow: status === 'live' ? `0 0 0 3px ${meta.color}33` : undefined,
        }}
      />
      <span style={{ fontSize: 12, color: meta.color, fontWeight: status === 'live' ? 600 : 400 }}>{meta.text}</span>
    </span>
  );
}