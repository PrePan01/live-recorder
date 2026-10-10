import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveDanmakuSnapshot } from '../api/danmaku';
import { createLiveDanmakuSession } from '../api/liveDanmakuSession';
import type { DanmakuMessage, DanmakuStatus } from '../types/danmaku';
import { mergeLiveDanmakuWindow } from '../utils/liveDanmakuWindow';

/** One incremental subscription for the modal, independent of whether recording starts/stops. */
export function useLiveDanmaku(roomId: string, enabled: boolean, video: HTMLVideoElement | null) {
  const [messages, setMessages] = useState<DanmakuMessage[]>([]);
  const [status, setStatus] = useState<DanmakuStatus | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const videoRef = useRef(video);
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
    setMessages([]); setStatus(null); resetTime();
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
    return createLiveDanmakuSession(roomId, apply, () => {
      setStatus(previous => ({ recordingId: previous?.recordingId ?? 'preview', state: 'reconnecting', since: Date.now() }));
    });
  }, [roomId, enabled, resetTime]);
  return { messages, status, resetKey, getTimeMs, resetTime };
}
