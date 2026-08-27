import dayjs from 'dayjs';

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  return dayjs(iso).format('YYYY-MM-DD HH:mm:ss');
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '从未';
  const diff = dayjs().diff(dayjs(iso), 'second');
  if (diff < 60) return `${Math.max(diff, 0)} 秒前`;
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

export function formatDuration(startIso: string, endIso?: string | null): string {
  const ms = dayjs(endIso ?? dayjs()).diff(dayjs(startIso));
  const sec = Math.max(Math.floor(ms / 1000), 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s).padStart(2, '0')}s`;
}
