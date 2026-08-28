export interface StatCardProps {
  label: string;
  value: string;
  tone?: 'default' | 'recording' | 'failed' | 'checking';
}

export default function StatCard({ label, value, tone = 'default' }: StatCardProps) {
  const cls = tone === 'default' ? '' : ` lr-stat__value--${tone}`;
  return (
    <div
      className="lr-stat"
      style={{
        flex: 1,
        minWidth: 0,
        background: '#fafafa',
        borderRadius: 8,
        padding: '8px 10px',
        border: '1px solid #f0f0f0',
      }}
    >
      <div className="lr-stat__label">{label}</div>
      <div className={`lr-stat__value${cls}`}>{value}</div>
    </div>
  );
}