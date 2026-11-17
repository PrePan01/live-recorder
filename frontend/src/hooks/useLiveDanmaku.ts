import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveDanmakuSnapshot } from '../api/danmaku';
import { createLiveDanmakuSession } from '../api/liveDanmakuSession';
import type { DanmakuMessage, DanmakuStatus } from '../types/danmaku';
import { mergeLiveDanmakuWindow } from '../utils/danmaku/liveDanmakuWindow';

/** One incremental subscription for the modal, independent of whether recording starts/stops. */
export function useLiveDanmaku(
  roomId: string,
  visible: boolean,
  video: HTMLVideoElement | null,
  cacheEnabled: boolean,
) {
  const enabled = visible || cacheEnabled;
  const [messages, setMessages] = useState<DanmakuMessage[]>([]);
  const [status, setStatus] = useState<DanmakuStatus | null>(null);
  const [lease, setLease] = useState<{ roomId: string; token: string; generation: string } | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const videoRef = useRef(video);
  const visibleRef = useRef(visible);
  useEffect(() => { videoRef.current = video; }, [video]);
  const anchorRef = useRef<number | null>(null);
  const lastVideoTime = useRef(0);
  const resetTime = useCallback(() => {
    anchorRef.current = null;
    lastVideoTime.current = 0;
    setResetKey(value => value + 1);
  }, []);
  const getTimeMs = useCallback(() => {
    const element = videoRef.current;
    return element?.buffered.length && anchorRef.current != null
      ? element.currentTime * 1000 + anchorRef.current : NaN;
  }, []);

  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) setMessages([]);
    resetTime();
  }, [visible, resetTime]);

  useEffect(() => {
    setMessages([]); setStatus(null); setLease(null); resetTime();
    if (!enabled) return;
    let generation = '';
    const apply = (data: LiveDanmakuSnapshot) => {
      if (generation !== data.generation) {
        generation = data.generation;
        setMessages([]); resetTime();
      }
      setStatus(previous => previous?.state === data.status.state
        && previous.since === data.status.since
        && previous.reason === data.status.reason
        && previous.recordingId === data.status.recordingId ? previous : data.status);
      if (!visibleRef.current) return;
      const element = videoRef.current;
      if (element?.buffered.length) {
        if (element.currentTime < lastVideoTime.current - 0.5) resetTime();
        lastVideoTime.current = element.currentTime;
        if (anchorRef.current == null) {
          anchorRef.current = data.mediaNowMs - element.buffered.end(element.buffered.length - 1) * 1000;
        }
      }
      setMessages(previous => mergeLiveDanmakuWindow(previous, data.messages, data.mediaNowMs));
    };
    return createLiveDanmakuSession(
      roomId,
      apply,
      () => setStatus(previous => ({ recordingId: previous?.recordingId ?? 'preview', state: 'reconnecting', since: Date.now() })),
      () => visibleRef.current,
      (token, nextGeneration) => setLease(previous =>
        previous?.token === token && previous.generation === nextGeneration
          ? previous
          : { roomId, token, generation: nextGeneration },
      ),
    );
  }, [roomId, enabled, resetTime]);
  return { messages, status, lease: lease?.roomId === roomId ? lease : null, resetKey, getTimeMs, resetTime };
}
