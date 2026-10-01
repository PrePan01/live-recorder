/**
 * 任务进度聚合 DTO（与后端 GET /api/v1/tasks 契约原样）。
 * 四类在途：片段导出 / 管线后处理（含归档步）/ 上传 / 诊断导出。
 * 完成即离在途扫描——展示宽限由前端负责（后端不存已读）。
 */
export type TaskKind = 'clip' | 'pipeline' | 'upload' | 'export';

export interface TaskItem {
  id: string;
  kind: TaskKind;
  title: string;
  state: string;
  progressPercent?: number;
  step?: string | null;
  etaSeconds?: number | null;
  error?: string | null;
  updatedAt: string;
}
