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
      style={{
        padding: '8px 12px',
        borderRadius: 6,
        background: 'rgba(139,92,246,0.06)',
        marginBottom: 8,
      }}
      data-testid="task-card"
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
        {task.title}
      </div>
      {/* 第二行两端对齐：左=状态（百分比）、右=处理阶段-步骤 */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 8,
          fontSize: 12,
          opacity: 0.75,
        }}
      >
        <span style={{ minWidth: 0 }}>
          {stateText(task)}
          {percent != null ? `（${Math.round(percent)}%）` : ''}
        </span>
        <span style={{ flexShrink: 0 }}>
          {stageText(task)}
          {task.step ? ` - ${pipelineStepText(task.step)}` : ''}
        </span>
      </div>
      {percent != null ? (
        <div
          style={{ marginTop: 6, height: 4, borderRadius: 2, background: 'rgba(139,92,246,0.15)', overflow: 'hidden' }}
        >
          <div style={{ width: `${percent}%`, height: '100%', background: '#8b5cf6', transition: 'width 300ms' }} />
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
    void refresh();
    const unsubs = [
      useRecordingStore.subscribe(() => void scheduleRefresh()),
      usePipelineStore.subscribe(() => void scheduleRefresh()),
      useUploadStore.subscribe(() => void scheduleRefresh()),
      useDiagnosticStore.subscribe(() => void scheduleRefresh()),
    ];
    let wasConnected = useServiceStore.getState().sseConnected;
    const unsubConn = useServiceStore.subscribe((state) => {
      if (state.sseConnected && !wasConnected) void refresh(); // 重连校准（断线期间不冻结）
      wasConnected = state.sseConnected;
    });
    // 真轮询兑底：直调 refresh()、绝不经 debounce（密集事件会无限重置 debounce，
    // 任务变化的时刻恰恰拉不成）。
    // 零新增事件契约；接口为内存微扫，常开零负担。
    const poll = setInterval(() => void useTasksStore.getState().refresh(), 1200);
    return () => {
      clearInterval(poll);
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
      title={<div style={{ fontSize: 13, fontWeight: 600 }}>任务进度</div>}
      content={
        <div style={{ width: 320, maxHeight: '60vh', overflowY: 'auto' }}>
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
          icon={<FieldTimeOutlined style={{ fontSize: 18 }} />}
          style={{ height: 28, width: 28, padding: 0 }}
        />
      </Badge>
    </Popover>
  );
}
