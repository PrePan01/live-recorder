import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal, Slider, Space, Switch, Tooltip, Typography } from 'antd';
import { PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons';
import mpegts from 'mpegts.js';
import { recordingFileUrl } from '../api/recordings';
import { fetchDanmaku } from '../api/danmaku';
import { DanmakuLayer } from './DanmakuLayer';
import RecordingTrack from './RecordingTrack';
import { fetchRecordingGaps, fetchRecordingMarkers } from '../api/recordings';
import type { RecordingGap, RecordingMarker } from '../types/recording';
import {
  DANMUKU_DENSITY_OPTIONS,
  loadDanmakuPref,
  saveDanmakuPref,
} from '../utils/danmakuPrefs';
import {
  danmakuStateText,
  selectDanmakuStatus,
  useDanmakuStore,
} from '../stores/danmakuStore';
import type { DanmakuGap, DanmakuMessage } from '../types/danmaku';

interface DanmakuPlayerModalProps {
  recordingId: string;
  title: string;
  /** 完成态文件路径：决定原生 mp4 播放还是 FLV 流式播放。 */
  filePath?: string;
  /** 定位起播秒（缺口定位用）；就绪后跳到该点。 */
  initialSecond?: number;
  onClose: () => void;
}

function loadPref<T>(key: string, fallback: T): T {
  return loadDanmakuPref(key, fallback);
}

function savePref(key: string, value: unknown): void {
  saveDanmakuPref(key, value);
}

function formatClock(totalSeconds: number): string {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 弹幕回看宿主：完成态文件播放 + 弹幕飘屏。
 * mp4 走原生 video、FLV 走 mpegts（同一文件路由）；媒体时间=文件时间轴 0 基，
 * 弹幕按媒体时间加载，跳播换表清屏，暂停/倍速由媒体时间驱动天然同步。
 */
export function DanmakuPlayerModal({
  recordingId,
  title,
  filePath,
  initialSecond = 0,
  onClose,
}: DanmakuPlayerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<mpegts.Player | null>(null);
  const loadSeqRef = useRef(0);
  const [messages, setMessages] = useState<DanmakuMessage[]>([]);
  const [gaps, setGaps] = useState<DanmakuGap[]>([]);
  const [visible, setVisible] = useState(() => loadPref('visible', true));
  const [opacity, setOpacity] = useState(() => loadPref('opacity', 0.9));
  const [density, setDensity] = useState(() => loadPref('density', 40));
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [seekTick, setSeekTick] = useState(0);
  const [markers, setMarkers] = useState<RecordingMarker[]>([]);
  const [videoGaps, setVideoGaps] = useState<RecordingGap[]>([]);
  const [failed, setFailed] = useState(false);
  const danmakuStatus = useDanmakuStore((s) => selectDanmakuStatus(s, recordingId));
  const isNative = (filePath ?? '').toLowerCase().endsWith('.mp4');
  const fileUrl = recordingFileUrl(recordingId);

  const getTimeMs = useCallback(
    () => (videoRef.current?.currentTime ?? 0) * 1000,
    [],
  );

  const reload = useCallback(
    async (atMs: number) => {
      const seq = ++loadSeqRef.current;
      try {
        const data = await fetchDanmaku(recordingId, {
          fromMs: Math.max(0, atMs - 2_000),
          toMs: atMs + 30 * 60_000,
          limit: 5000,
        });
        if (seq !== loadSeqRef.current) return;
        setMessages(data.messages);
        setGaps(data.gaps ?? []);
        if (data.status) useDanmakuStore.getState().applyStatus(data.status);
      } catch {
        if (seq !== loadSeqRef.current) return;
        setMessages([]);
        setGaps([]);
      }
    },
    [recordingId],
  );

  useEffect(() => {
    void reload(0);
    void fetchRecordingMarkers(recordingId).then(setMarkers).catch(() => undefined);
    void fetchRecordingGaps(recordingId).then(setVideoGaps).catch(() => undefined);
  }, [reload, recordingId]);

  // FLV 走 mpegts 绑源；mp4 由 JSX src 直绑（原生）。
  useEffect(() => {
    if (isNative) return undefined;
    const video = videoRef.current;
    if (!video) return undefined;
    const player = mpegts.createPlayer(
      { type: 'flv', url: fileUrl, isLive: false },
      { enableStashBuffer: false, accurateSeek: true },
    );
    player.attachMediaElement(video);
    player.load();
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
    };
  }, [isNative, fileUrl]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  };

  return (
    <Modal
      open
      width={960}
      title={<Typography.Text strong>{title}</Typography.Text>}
      footer={
        <Space>
          {danmakuStatus ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {danmakuStateText(danmakuStatus.state)}
            </Typography.Text>
          ) : null}
          <span style={{ fontSize: 12, opacity: 0.7 }}>弹幕</span>
          <Switch
            size="small"
            checked={visible}
            onChange={(v) => {
              setVisible(v);
              savePref('visible', v);
            }}
          />
          <Tooltip title="弹幕透明度">
            <Slider
              style={{ width: 90 }}
              min={0.2}
              max={1}
              step={0.1}
              value={opacity}
              onChange={(v) => {
                setOpacity(v as number);
                savePref('opacity', v);
              }}
            />
          </Tooltip>
          <Tooltip title="同屏密度">
            <Slider
              style={{ width: 80 }}
              min={0}
              max={DANMUKU_DENSITY_OPTIONS.length - 1}
              step={1}
              value={DANMUKU_DENSITY_OPTIONS.indexOf(density)}
              onChange={(v) => {
                const d = DANMUKU_DENSITY_OPTIONS[v as number] ?? 40;
                setDensity(d);
                savePref('density', d);
              }}
            />
          </Tooltip>
          <Button onClick={onClose}>关闭</Button>
        </Space>
      }
      onCancel={onClose}
    >
      <div style={{ position: 'relative', background: '#000', aspectRatio: '16 / 9' }}>
        {failed ? (
          <div
            style={{
              color: 'rgba(255,255,255,0.75)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
            }}
          >
            视频加载失败，弹幕可先看列表
          </div>
        ) : null}
        <video
          ref={videoRef}
          src={isNative ? fileUrl : undefined}
          style={{ width: '100%', height: '100%', display: 'block' }}
          onPlay={() => {
            setPlaying(true);
            setFailed(false);
          }}
          onPause={() => setPlaying(false)}
          onTimeUpdate={() => {
            const v = videoRef.current;
            if (v) setCurrent(v.currentTime);
          }}
          onLoadedMetadata={() => {
            const v = videoRef.current;
            if (v && Number.isFinite(v.duration)) setDuration(v.duration);
            if (v && initialSecond > 0) {
              v.currentTime = initialSecond;
              setSeekTick((t) => t + 1);
              void reload(initialSecond * 1000);
            }
          }}
          onError={() => setFailed(true)}
          onClick={togglePlay}
        />
        <DanmakuLayer
          messages={messages}
          gaps={gaps}
          getTimeMs={getTimeMs}
          maxBullets={density}
          opacity={opacity}
          visible={visible}
          resetKey={seekTick}
        />
      </div>
      <div style={{ marginTop: 8 }}>
        <RecordingTrack
          elapsedSeconds={duration}
          markers={markers}
          editable={false}
          gaps={videoGaps}
          onSeekCommit={(target) => {
            if (typeof target !== 'number') return;
            const v = videoRef.current;
            if (v) v.currentTime = target;
            setCurrent(target);
            setSeekTick((t) => t + 1);
            void reload(target * 1000);
          }}
        />
      </div>
      <Space style={{ marginTop: 8 }} size="middle">
        <Button
          type="text"
          icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
          onClick={togglePlay}
        />
        <Slider
          style={{ width: 520 }}
          min={0}
          max={Math.max(1, duration)}
          step={0.5}
          value={current}
          onChange={(v) => {
            const target = v as number;
            const v2 = videoRef.current;
            if (v2) v2.currentTime = target;
            setCurrent(target);
            setSeekTick((t) => t + 1);
            void reload(target * 1000);
          }}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatClock(current)} / {formatClock(duration)}
        </Typography.Text>
        <Tooltip title="播放倍速">
          <Slider
            style={{ width: 90 }}
            min={0.5}
            max={3}
            step={0.25}
            value={rate}
            onChange={(v) => {
              const r = v as number;
              setRate(r);
              const v2 = videoRef.current;
              if (v2) v2.playbackRate = r;
            }}
          />
        </Tooltip>
      </Space>
    </Modal>
  );
}
