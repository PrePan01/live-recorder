import type { LiveStatus } from '../types/room';

const META: Record<LiveStatus, { color: string; text: string }> = {
  live: { color: '#52c41a', text: '直播中' },
  offline: { color: '#d9d9d9', text: '未开播' },
  restricted: { color: '#faad14', text: '受限' },
};

export default function LiveStatusTag({ status }: { status: LiveStatus | null }) {
  if (!status) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#d9d9d9' }} />
        <span style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>未检测</span>
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