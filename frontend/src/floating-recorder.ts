import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { fetchRooms, startRoomRecording, stopRecording } from './api/rooms';
import { EndpointResolver } from './api/endpoint';
import type { Room } from './types/room';
import './styles/floating-recorder.css';

interface FloatingState { targetRoomId: string | null; buttonSize: number }

const root = document.querySelector<HTMLElement>('#root')!;
let targetRoomId: string | null = null;
let room: Room | null = null;
let acting = false;
let timer: ReturnType<typeof setInterval> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let error: string | null = null;
let events: EventSource | null = null;
let dragStart: { x: number; y: number } | null = null;
let dragged = false;
let dragStarted = false;

const DRAG_START_DISTANCE_PX = 4;

const isRecording = () => room?.monitorState === 'recording' || room?.monitorState === 'reconnecting';
const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]!);
function applyButtonRadius(radius: number): void {
  const safeRadius = Math.min(100, Math.max(20, Math.round(radius)));
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--record-button-radius', `${safeRadius}px`);
  rootStyle.setProperty('--record-button-size', `${safeRadius * 2}px`);
  rootStyle.setProperty('--record-button-border', `${Math.min(12, Math.max(3, Math.round(safeRadius * 0.12)))}px`);
  rootStyle.setProperty('--record-button-indicator-size', `${Math.min(76, Math.max(22, Math.round(safeRadius * 0.82)))}px`);
}
const formatElapsed = (startedAt: string | undefined) => {
  if (!startedAt) return '00:00:00';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((part) => String(part).padStart(2, '0')).join(':');
};

async function refresh(): Promise<void> {
  if (!targetRoomId) return;
  try {
    room = (await fetchRooms()).find((candidate) => candidate.id === targetRoomId) ?? null;
    if (!room || (!room.enabled || room.lastLiveStatus !== 'live') && !isRecording()) {
      await invoke('hide_floating_recorder', { clearTarget: true });
      targetRoomId = null;
      room = null;
    }
  } catch {
    error = '无法连接录制服务';
  }
  render();
}

function render(): void {
  const recording = isRecording();
  const roomName = room?.displayName ?? '快速录制';
  root.innerHTML = `
    <section class="floating-recorder" aria-label="快速录制">
      <span class="recording-room-name" title="${escapeHtml(roomName)}">${escapeHtml(roomName)}</span>
      <button class="record-button ${recording ? 'record-button--active' : ''}" type="button" ${acting || !room ? 'disabled' : ''}
        aria-label="${recording ? '停止录制' : '开始录制'}" title="${escapeHtml(roomName)}">
        <span class="record-button__indicator" aria-hidden="true"></span>
      </button>
      <button class="floating-close" type="button" aria-label="关闭悬浮录制按钮" title="关闭"></button>
      <output class="recording-time ${recording ? '' : 'recording-time--hidden'}">${formatElapsed(room?.activeRecording?.startedAt)}</output>
      ${error ? `<span class="recording-error" role="status">${error}</span>` : ''}
      <menu class="floating-menu" hidden>
        <button type="button" data-action="hide">隐藏录制按钮</button>
        ${recording ? '<button type="button" data-action="stop-hide">停止录制并隐藏</button>' : ''}
      </menu>
    </section>`;
  const recordButton = root.querySelector<HTMLButtonElement>('.record-button');
  const surface = root.querySelector<HTMLElement>('.floating-recorder');
  surface?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('.floating-close, .floating-menu')) return;
    dragStart = { x: event.clientX, y: event.clientY };
    dragged = false;
    dragStarted = false;
  });
  surface?.addEventListener('pointermove', (event) => {
    if (!dragStart || dragStarted) return;
    if (Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) < DRAG_START_DISTANCE_PX) return;
    // On Windows, starting a native drag from pointerdown consumes the later
    // click event. Wait until the pointer has actually moved so a simple click
    // on the record button always reaches toggleRecording.
    dragged = true;
    dragStarted = true;
    void getCurrentWindow().startDragging().catch(() => { dragStarted = false; });
  });
  surface?.addEventListener('pointerup', () => { dragStart = null; dragStarted = false; });
  recordButton?.addEventListener('click', (event) => {
    if (dragged) {
      event.preventDefault();
      dragged = false;
      return;
    }
    void toggleRecording();
  });
  root.querySelector<HTMLButtonElement>('.floating-close')?.addEventListener('click', () =>
    void invoke('hide_floating_recorder', { clearTarget: true }),
  );
  surface?.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    root.querySelector<HTMLMenuElement>('.floating-menu')!.hidden = false;
  });
  root.querySelectorAll<HTMLButtonElement>('.floating-menu button').forEach((button) => button.addEventListener('click', () => void menuAction(button.dataset.action)));
}

async function toggleRecording(): Promise<void> {
  if (!targetRoomId || !room || acting) return;
  acting = true;
  error = null;
  render();
  try {
    if (isRecording()) await stopRecording(targetRoomId);
    else await startRoomRecording(targetRoomId, 'floating');
    await refresh();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : '录制操作失败';
  } finally {
    acting = false;
    render();
  }
}

async function menuAction(action: string | undefined): Promise<void> {
  if (action === 'stop-hide' && isRecording() && targetRoomId) {
    try { await stopRecording(targetRoomId); } catch { error = '停止录制失败'; render(); return; }
  }
  await invoke('hide_floating_recorder', { clearTarget: false });
}

async function setTarget(state: FloatingState): Promise<void> {
  targetRoomId = state.targetRoomId;
  applyButtonRadius(state.buttonSize);
  room = null;
  error = null;
  await refresh();
}

function subscribeRoomUpdates(): void {
  events?.close();
  events = new EventSource(`${EndpointResolver.base}/events`);
  events.addEventListener('room:updated', (event) => {
    try {
      const updated = JSON.parse((event as MessageEvent<string>).data) as Room;
      if (updated.id !== targetRoomId) return;
      room = updated;
      if ((!updated.enabled || updated.lastLiveStatus !== 'live') && !isRecording()) {
        void invoke('hide_floating_recorder', { clearTarget: true });
        targetRoomId = null;
        room = null;
      }
      render();
    } catch { /* Ignore malformed SSE frames. */ }
  });
}

void (async () => {
  await setTarget(await invoke<FloatingState>('get_floating_recorder_state'));
  await listen<FloatingState>('floating-recorder:target', (event) => void setTarget(event.payload));
  await listen<void>('floating-recorder:moved', () => { dragged = true; });
  subscribeRoomUpdates();
  // 界面刷新仅在窗口可见时进行（隐藏时每秒重绘/每5秒自问无人观看）；
  // 回前台立即补一次，录制计时显示不滞后。
  timer = setInterval(() => { if (!document.hidden && isRecording()) render(); }, 1000);
  refreshTimer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
})();

window.addEventListener('beforeunload', () => {
  if (timer) clearInterval(timer);
  if (refreshTimer) clearInterval(refreshTimer);
  events?.close();
});
