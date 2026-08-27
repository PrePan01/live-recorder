import type {
  AxiosAdapter,
  AxiosHeaders,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from 'axios';
import axios from 'axios';
import type { Room } from '../../types/room';
import type { Recording } from '../../types/recording';
import type { Alert } from '../../types/alert';
import type { Settings } from '../../types/settings';
import type { ServiceStatus } from '../../types/service';
import type { ServerEvent } from '../../types/events';
import type { ApiErrorEnvelope } from '../../types/error';

const now = () => new Date().toISOString();
const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const env = (code: string, message: string, retryable = false, recordingId?: string): ApiErrorEnvelope => ({
  code,
  message,
  occurredAt: now(),
  retryable,
  ...(recordingId ? { recordingId } : {}),
});

const settings: Settings = {
  recordingDirectory: '/Users/example/Videos/live-recorder',
  maxConcurrentRecordings: 2,
  checkIntervalSec: { default: 60, bilibili: 60, douyin: 120 },
  quality: 'original',
  retry: { maxAttempts: 3, delaysSeconds: [5, 15, 45] },
  diskGuard: { minFreeBytes: 21_474_836_480, minFreePercent: 10 },
  mail: {
    enabled: true,
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    username: 'notify@example.com',
    from: 'notify@example.com',
    recipients: ['owner@example.com'],
    passwordSet: true,
  },
};

const rooms: Room[] = [
  {
    id: 'room_01JMOCKBILI',
    platform: 'bilibili',
    url: 'https://live.bilibili.com/21452505',
    displayName: 'Mock B站主播',
    enabled: true,
    monitorState: 'idle',
    lastCheckedAt: now(),
    lastError: null,
    createdAt: now(),
    updatedAt: now(),
  },
  {
    id: 'room_01JMOCKDY00',
    platform: 'douyin',
    url: 'https://live.douyin.com/731234567890',
    displayName: 'Mock 抖音主播',
    enabled: true,
    monitorState: 'idle',
    lastCheckedAt: now(),
    lastError: null,
    createdAt: now(),
    updatedAt: now(),
  },
];

const recordings: Recording[] = [
  {
    id: 'rec_01JMOCHK0001',
    roomId: 'room_01JMOCKBILI',
    platform: 'bilibili',
    streamSessionId: 'sess_mock_a001',
    streamTitle: 'Mock 直播：周末闲聊',
    state: 'completed',
    startedAt: new Date(Date.now() - 86400_000).toISOString(),
    endedAt: new Date(Date.now() - 86400_000 + 5400_000).toISOString(),
    filePath: `${settings.recordingDirectory}/2026-08-27/Mock B站主播_sess_mock_a001.mkv`,
    fileSizeBytes: 1_610_000_000,
    failureReason: null,
    retryCount: 0,
  },
  {
    id: 'rec_01JMOCHK0002',
    roomId: 'room_01JMOCKDY00',
    platform: 'douyin',
    streamSessionId: 'sess_mock_b002',
    streamTitle: 'Mock 直播：游戏实况',
    state: 'failed',
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    endedAt: new Date(Date.now() - 3300_000).toISOString(),
    filePath: null,
    fileSizeBytes: 0,
    failureReason: env(
      'STREAM_DISCONNECTED_RECONNECT_EXHAUSTED',
      '断流重连次数已耗尽',
      true,
    ),
    retryCount: 3,
  },
];

const alerts: Alert[] = [
  {
    id: uid('alr'),
    level: 'warning',
    source: 'disk',
    message: '磁盘可用空间低于 20GB，新录制可能受限',
    occurredAt: new Date(Date.now() - 7200_000).toISOString(),
    resolved: false,
  },
];

const serviceStatus: ServiceStatus = {
  state: 'running',
  version: '0.1.0-mock',
  uptimeSeconds: 0,
  disk: { freeBytes: 256_000_000_000, totalBytes: 1_000_000_000_000 },
  activeRecordings: 0,
  setupCompleted: true,
};

// ---------- 事件模拟（对应 SSE 7 事件） ----------
type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();

export function subscribeMockEvents(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(e: ServerEvent) {
  listeners.forEach((cb) => cb(e));
}

function touch(room: Room) {
  room.updatedAt = now();
  emit({ type: 'room:updated', room: { ...room } });
}

function emitRecording(r: Recording) {
  emit({ type: 'recording:updated', recording: { ...r } });
}

function pushAlert(level: Alert['level'], source: string, message: string) {
  const alert: Alert = { id: uid('alr'), level, source, message, occurredAt: now(), resolved: false };
  alerts.unshift(alert);
  emit({ type: 'alert:created', alert: { ...alert } });
}

// ---------- 开播模拟 ----------
let checkLiveFlag = true;

function startRecording(room: Room) {
  const rec: Recording = {
    id: uid('rec'),
    roomId: room.id,
    platform: room.platform,
    streamSessionId: uid('sess'),
    streamTitle: `Mock 直播 ${new Date().toLocaleTimeString('zh-CN')}`,
    state: 'pending',
    startedAt: now(),
    endedAt: null,
    filePath: null,
    fileSizeBytes: 0,
    failureReason: null,
    retryCount: 0,
  };
  recordings.unshift(rec);
  emitRecording(rec);
  setTimeout(() => {
    if (rec.state !== 'pending') return;
    rec.state = 'recording';
    rec.filePath = `${settings.recordingDirectory}/${now().slice(0, 10)}/${room.displayName}_${rec.streamSessionId}.mkv`;
    serviceStatus.activeRecordings += 1;
    room.monitorState = 'recording';
    room.lastError = null;
    touch(room);
    emitRecording(rec);
    pushAlert('info', 'recorder', `「${room.displayName}」开播，录制已开始`);
    setTimeout(() => finishRecording(room, rec), 20_000);
  }, 800);
}

function finishRecording(room: Room, rec: Recording, failed = false) {
  if (rec.state !== 'recording' && rec.state !== 'reconnecting') return;
  rec.state = failed ? 'failed' : 'completed';
  rec.endedAt = now();
  if (failed) {
    rec.failureReason = env('STREAM_DISCONNECTED_RECONNECT_EXHAUSTED', '断流重连次数已耗尽', true, rec.id);
    room.monitorState = 'failed';
    room.lastError = rec.failureReason;
  } else {
    rec.fileSizeBytes = 500_000_000 + Math.floor(Math.random() * 1e9);
    room.monitorState = 'completed';
    room.lastError = null;
  }
  serviceStatus.activeRecordings = Math.max(serviceStatus.activeRecordings - 1, 0);
  touch(room);
  emitRecording(rec);
  pushAlert(failed ? 'error' : 'info', 'recorder', `「${room.displayName}」录制${failed ? '失败' : '完成'}`);
}

// ---------- 路由 ----------
class MockFail extends Error {
  body: ApiErrorEnvelope;
  status: number;
  constructor(body: ApiErrorEnvelope, status: number) {
    super(body.message);
    this.body = body;
    this.status = status;
  }
}

const ok = (data: unknown, status = 200) => ({ status, data });

function findRoom(id: string): Room {
  const room = rooms.find((r) => r.id === id);
  if (!room) throw new MockFail(env('ROOM_LINK_INVALID', '房间不存在'), 404);
  return room;
}

function detectPlatform(url: string): Room['platform'] {
  if (/live\.douyin\.com|douyin\.com/.test(url)) return 'douyin';
  if (/live\.bilibili\.com|bilibili\.com/.test(url)) return 'bilibili';
  throw new MockFail(env('ROOM_LINK_INVALID', '链接无效或平台不支持'), 422);
}

function route(method: string, path: string, query: Record<string, string>, body: Record<string, unknown>) {
  const seg = path.split('/').filter(Boolean);

  if (seg[0] === 'rooms') {
    if (seg.length === 1 && method === 'GET') return ok({ rooms });
    if (seg.length === 1 && method === 'POST') {
      const url = String(body.url ?? '');
      const platform = detectPlatform(url);
      if (rooms.some((r) => r.url === url)) {
        throw new MockFail(env('ROOM_LINK_DUPLICATE', '该直播间已存在'), 409);
      }
      const room: Room = {
        id: uid('room'),
        platform,
        url,
        displayName: String(body.displayName ?? `${platform === 'bilibili' ? 'B站' : '抖音'} ${url.split('/').pop()}`),
        enabled: true,
        monitorState: 'idle',
        lastCheckedAt: null,
        lastError: null,
        createdAt: now(),
        updatedAt: now(),
      };
      rooms.push(room);
      emit({ type: 'room:updated', room: { ...room } });
      return ok({ room }, 201);
    }
    const room = findRoom(seg[1]);
    if (seg.length === 2 && method === 'PATCH') {
      if (body.url) Object.assign(room, { url: String(body.url), platform: detectPlatform(String(body.url)) });
      if (body.displayName) room.displayName = String(body.displayName);
      touch(room);
      return ok({ room });
    }
    if (seg.length === 2 && method === 'DELETE') {
      rooms.splice(rooms.indexOf(room), 1);
      return { status: 204, data: undefined };
    }
    if (seg[2] === 'enable' && method === 'PATCH') {
      room.enabled = Boolean(body.enabled);
      room.monitorState = room.enabled ? 'idle' : 'disabled';
      touch(room);
      return ok({ room });
    }
    if (seg[2] === 'check' && method === 'POST') {
      if (!room.enabled) throw new MockFail(env('ROOM_LINK_INVALID', '房间已停用'), 400);
      room.monitorState = 'checking';
      room.lastCheckedAt = now();
      touch(room);
      setTimeout(() => {
        const live = checkLiveFlag;
        checkLiveFlag = !checkLiveFlag;
        if (live) {
          startRecording(room);
        } else {
          room.monitorState = 'idle';
          room.lastError = null;
          touch(room);
        }
      }, 1500);
      return ok({ ok: true });
    }
    if (seg[2] === 'stop-recording' && method === 'POST') {
      const rec = recordings.find(
        (r) => r.roomId === room.id && (r.state === 'recording' || r.state === 'pending' || r.state === 'reconnecting'),
      );
      if (rec) finishRecording(room, rec);
      return ok({ ok: true });
    }
  }

  if (seg[0] === 'recordings') {
    if (seg.length === 1 && method === 'GET') {
      const page = Number(query.page ?? 1);
      const pageSize = Math.min(Number(query.pageSize ?? 20), 100);
      let items = [...recordings];
      if (query.roomId) items = items.filter((r) => r.roomId === query.roomId);
      if (query.sessionId) items = items.filter((r) => r.streamSessionId === query.sessionId);
      if (query.state) items = items.filter((r) => r.state === query.state);
      return ok({ items, total: items.length, page, pageSize });
    }
    const rec = recordings.find((r) => r.id === seg[1]);
    if (!rec) throw new MockFail(env('RECORDING_FILE_CORRUPTED', '录制记录不存在'), 404);
    if (seg[2] === 'open') return ok({ ok: true, path: rec.filePath });
  }

  if (seg[0] === 'settings') {
    if (seg.length === 1 && method === 'GET') return ok({ settings });
    if (seg.length === 1 && method === 'PUT') {
      if (body.saveDirectory) settings.recordingDirectory = String(body.saveDirectory);
      if (body.maxConcurrentRecordings) settings.maxConcurrentRecordings = Number(body.maxConcurrentRecordings);
      if (body.quality) settings.quality = String(body.quality) as Settings['quality'];
      if (body.checkIntervalSec) settings.checkIntervalSec = { ...settings.checkIntervalSec, ...(body.checkIntervalSec as object) };
      if (body.mail) {
        const { password, ...mailRest } = body.mail as Record<string, unknown>;
        settings.mail = { ...settings.mail, ...(mailRest as object), passwordSet: Boolean(password) || settings.mail.passwordSet };
      }
      
      emit({ type: 'settings:updated', settings: { ...settings } });
      return ok({ settings });
    }
    if (seg[1] === 'validate-directory') {
      const dir = String(body.directory ?? '');
      const valid = dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir);
      if (!valid) throw new MockFail(env('DIRECTORY_NOT_WRITABLE', '路径不合法或不可写'), 422);
      return ok({ ok: true });
    }
    if (seg[1] === 'test-smtp') return ok({ ok: true });
  }

  if (seg[0] === 'alerts') {
    if (seg.length === 1 && method === 'GET') return ok({ alerts });
    if (seg[1] === 'read-all' && method === 'POST') {
      alerts.forEach((a) => (a.resolved = true));
      return ok({ ok: true });
    }
    const alert = alerts.find((a) => a.id === seg[1]);
    if (alert && method === 'PATCH') {
      alert.resolved = Boolean(body.resolved);
      emit({ type: 'alert:updated', alert: { ...alert } });
      return ok({ alert });
    }
  }

  if (seg[0] === 'service' && seg[1] === 'status') {
    return ok({ serviceStatus });
  }

  throw new MockFail(env('SERVICE_UNAVAILABLE', `mock 未实现 ${method} ${path}`), 404);
}

export const mockAdapter: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
  const path = (config.url ?? '').split('?')[0];
  const query: Record<string, string> = {};
  const params = config.params as Record<string, unknown> | undefined;
  Object.entries(params ?? {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null) query[k] = String(v);
  });
  const body = typeof config.data === 'string' ? JSON.parse(config.data || '{}') : (config.data ?? {});
  const method = (config.method ?? 'get').toUpperCase();
  let result: { status: number; data: unknown };
  try {
    result = route(method, path, query, body as Record<string, unknown>);
  } catch (err) {
    if (err instanceof MockFail) {
      const response: AxiosResponse = {
        data: { error: err.body },
        status: err.status,
        statusText: 'Mock Error',
        headers: {} as AxiosHeaders,
        config,
      };
      throw new axios.AxiosError(err.body.message, 'ERR_BAD_REQUEST', config, null, response);
    }
    throw err;
  }
  return { data: result.data, status: result.status, statusText: 'OK', headers: {} as AxiosHeaders, config };
};
