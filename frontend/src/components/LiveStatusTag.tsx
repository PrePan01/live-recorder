import type { LiveStatus } from '../types/room';

const META: Record<LiveStatus, { colorClass: string; text: string }> = {
  live: { colorClass: 'lr-live-status-text--live', text: '直播中' },
  offline: { colorClass: 'lr-live-status-text--offline', text: '未开播' },
  restricted: { colorClass: 'lr-live-status-text--restricted', text: '受限' },
};

export default function LiveStatusTag({ status }: { status: LiveStatus | null }) {
  if (!status) {
    return (
      <span className="lr-live-status-tag">
        <span className="lr-live-status-dot lr-live-status-dot--offline" />
        <span className="lr-live-status-text lr-live-status-text--offline">未检测</span>
      </span>
    );
  }
  const meta = META[status];
  return (
    <span className="lr-live-status-tag">
      <span className={`lr-live-status-dot lr-live-status-dot--${status}`} />
      <span className={`lr-live-status-text ${meta.colorClass}`}>{meta.text}</span>
    </span>
  );
}
