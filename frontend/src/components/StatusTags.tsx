import { Tag } from 'antd';
import type { MonitorState } from '../types/room';
import type { RecordingState } from '../types/recording';

const MONITOR_META: Record<MonitorState, { color: string; text: string }> = {
  idle: { color: 'default', text: '空闲' },
  checking: { color: 'processing', text: '检测中' },
  recording: { color: 'red', text: '录制中' },
  reconnecting: { color: 'orange', text: '重连中' },
  completed: { color: 'green', text: '已完成' },
  failed: { color: 'error', text: '失败' },
  disabled: { color: 'default', text: '已停用' },
};

const RECORDING_META: Record<RecordingState, { color: string; text: string }> = {
  pending: { color: 'default', text: '待启动' },
  recording: { color: 'red', text: '录制中' },
  reconnecting: { color: 'orange', text: '重连中' },
  completed: { color: 'green', text: '已完成' },
  failed: { color: 'error', text: '失败' },
};

export function MonitorStateTag({ state }: { state: MonitorState }) {
  const meta = MONITOR_META[state];
  return <Tag color={meta.color}>{meta.text}</Tag>;
}

export function RecordingStateTag({ state }: { state: RecordingState }) {
  const meta = RECORDING_META[state];
  return <Tag color={meta.color}>{meta.text}</Tag>;
}

export function PlatformTag({ platform }: { platform: string }) {
  return <Tag color={platform === 'bilibili' ? 'blue' : 'magenta'}>{platform === 'bilibili' ? 'B站' : '抖音'}</Tag>;
}
