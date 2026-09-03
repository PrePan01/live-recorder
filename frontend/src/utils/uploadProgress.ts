export function formatUploadWait(startedAt: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 5) return '刚刚';
  if (elapsedSeconds < 60) return `${elapsedSeconds} 秒`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return seconds > 0 && minutes < 10 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
}

/** 99% 是协议阶段边界，不是仍差 1%；前端应显示“收尾/核验”而不是静止数字。 */
export function cloudFinalizingText(updatedAt: string, now = Date.now()): string {
  const timestamp = new Date(updatedAt).getTime();
  if (!Number.isFinite(timestamp)) return '文件数据已传完，正在等待 OpenList 确认远端文件';
  const elapsedMs = Math.max(0, now - timestamp);
  const waited = formatUploadWait(updatedAt, now);
  if (elapsedMs < 45_000) return `文件数据已传完，等待 OpenList 确认 · 已等待 ${waited}`;
  if (elapsedMs < 3 * 60_000) return `正在确认远端文件是否完整 · 已等待 ${waited}`;
  return `OpenList 响应较慢，仍在自动确认；无需手动重传 · 已等待 ${waited}`;
}

export type VisibleUploadPhase = 'preparing' | 'sending' | 'cloud' | 'verifying' | 'resuming' | null;

export function uploadPhaseLabel(phase: VisibleUploadPhase, progress: number): string {
  if (phase === 'preparing') return '准备上传';
  if (phase === 'sending') return '发送文件';
  if (phase === 'cloud') return '云端写入';
  if (phase === 'verifying' || progress >= 99) return '最终确认';
  if (phase === 'resuming') return '恢复进度';
  return '上传中';
}

export function uploadPhaseText(phase: VisibleUploadPhase, progress: number, updatedAt: string, now = Date.now()): string {
  if (phase === 'preparing') return '正在连接 OpenList 并准备目标目录…';
  if (phase === 'sending') return '阶段 1/2：正在把本地文件发送到 OpenList…';
  if (phase === 'resuming') return '服务已恢复，正在继续查询原 OpenList 任务，不会从 0 重传…';
  if (phase === 'cloud') return '阶段 2/2：OpenList 正在写入云端存储…';
  if (phase === 'verifying' || progress >= 99) return cloudFinalizingText(updatedAt, now);
  return progress < 50 ? '正在发送文件到 OpenList…' : 'OpenList 正在写入云端存储…';
}
