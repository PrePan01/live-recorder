import { useEffect, useState } from 'react';
import { Badge, Button, Popover } from 'antd';
import { FieldTimeOutlined } from '@ant-design/icons';
import { selectVisibleTasks, useTasksStore } from '../stores/tasksStore';
import { useServiceStore } from '../stores/serviceStore';
import { useRecordingStore } from '../stores/recordingStore';
import { usePipelineStore } from '../stores/pipelineStore';
import { useUploadStore } from '../stores/uploadStore';
import { useDiagnosticStore } from '../stores/diagnosticStore';
import type { TaskItem } from '../types/tasks';
import { pipelineStepText } from '../utils/pipelineStepText';
import { encoderLabel } from '../utils/encoderText';

/**
 * 任务进度入口：告警按钮右侧同构三件套——按钮＋右上角小角标＋点击弹层。
 * 无任务 = 入口完全不存在（非禁用）；角标 = 在途清单长度（宽限期内仍计数）。
 * 数据 = GET /api/v1/tasks 聚合 + 听现有四类 store 变化 debounce 重拉（不新增事件契约）。
 */

const KIND_LABEL: Record<TaskItem['kind'], string> = {
  clip: '片段导出',
  pipeline: '后处理',
  upload: '上传',
  export: '诊断导出',
};

/** 卡面「处理阶段」：clip 单卡两相位——后处理相位随 state 换段名。 */
function stageText(task: TaskItem): string {
  if (task.kind === 'clip' && task.state === 'post_processing') return '后处理';
  return KIND_LABEL[task.kind];
}

function stateText(task: TaskItem): string {
  if (task.error) return task.error;
  switch (task.state) {
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'partial':
      return '部分完成';
    case 'cancelled':
      return '已取消';
    case 'unavailable':
      return '任务已移除';
    case 'queued':
      return '排队中';
    case 'exporting':
      return '导出中';
    case 'post_processing':
      return '后处理中';
    case 'running':
    case 'processing':
    default:
      return '进行中';
  }
}

function TaskCard({ task }: { task: TaskItem }) {
  const percent =
    typeof task.progressPercent === 'number'
      ? Math.max(0, Math.min(100, task.progressPercent))
      : null;
  return (
    <div
      className="lr-task-card"
      data-testid="task-card"
    >
      <div className="lr-task-card__title">
        {task.title}
      </div>
      {task.actualEncoder ? (
        <div className="lr-task-card__encoder">
          编码方式：{encoderLabel(task.actualEncoder)}
          {task.fallbackReason ? `（${task.fallbackReason}）` : ''}
        </div>
      ) : null}
      {/* 第二行两端对齐：左=状态（百分比）、右=处理阶段-步骤 */}
      <div className="lr-task-card__status">
        <span className="lr-task-card__state">
          {stateText(task)}
          {percent != null ? `（${Math.round(percent)}%）` : ''}
        </span>
        <span className="lr-task-card__stage">
          {stageText(task)}
          {task.step ? ` - ${pipelineStepText(task.step)}` : ''}
        </span>
      </div>
      {percent != null ? (
        <div className="lr-task-card__progress">
          <div className="lr-task-card__fill" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export function TaskProgressEntry() {
  const active = useTasksStore((state) => state.active);
  const grace = useTasksStore((state) => state.grace);
  const refresh = useTasksStore((state) => state.refresh);
  const scheduleRefresh = useTasksStore((state) => state.scheduleRefresh);
  const [open, setOpen] = useState(false);

  const tasks = selectVisibleTasks({ active, grace });

  // 挂载首拉（刷新页面首屏即对）+ 四类源变化 debounce 重拉 + SSE 重连校准。
  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState !== 'hidden') void refresh();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') return;
      useTasksStore.getState().pruneGrace(Date.now());
      refreshVisible();
    };
    refreshVisible();
    document.addEventListener('visibilitychange', onVisibilityChange);
    const unsubs = [
      useRecordingStore.subscribe(() => void scheduleRefresh()),
      usePipelineStore.subscribe(() => void scheduleRefresh()),
      useUploadStore.subscribe(() => void scheduleRefresh()),
      useDiagnosticStore.subscribe(() => void scheduleRefresh()),
    ];
    let wasConnected = useServiceStore.getState().sseConnected;
    const unsubConn = useServiceStore.subscribe((state) => {
      if (state.sseConnected && !wasConnected) refreshVisible(); // 重连校准（断线期间不冻结）
      wasConnected = state.sseConnected;
    });
    // 真轮询兑底：直调 refresh()、绝不经 debounce（密集事件会无限重置 debounce，
    // 任务变化的时刻恰恰拉不成）。
    // 后台不驱动 React 更新；回到前台立即校准，前台轮询不经 debounce。
    const poll = setInterval(refreshVisible, 1200);
    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      for (const unsub of unsubs) unsub();
      unsubConn();
    };
  }, [refresh, scheduleRefresh]);

  // 无任务 = 入口完全不存在（非禁用）。
  if (tasks.length === 0) return null;

  return (
    <Popover
      trigger="click"
      placement="topRight"
      open={open}
      onOpenChange={setOpen}
      arrow={false}
      title={<div className="lr-task-progress__title">任务进度</div>}
      content={
        <div className="lr-task-progress__list">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      }
    >
      <Badge count={tasks.length} size="small" offset={[-4, 4]}>
        <Button
          type="text"
          aria-label="任务进度"
          icon={<FieldTimeOutlined className="lr-task-progress__icon" />}
          className="lr-task-progress__trigger"
        />
      </Badge>
    </Popover>
  );
}
