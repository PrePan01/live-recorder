import { App } from "antd";
import { useEffect, useRef, useState } from "react";
import { savePreviewScreenshot } from "../../api/screenshots";
import {
  canCaptureVideoFrame,
  captureVideoFrame,
} from "../../utils/player/captureVideoFrame";

export function usePreviewScreenshot(
  roomId: string,
  video: HTMLVideoElement | null,
  frameReady: boolean,
  switching: boolean,
  recordingId?: string,
) {
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const busyRef = useRef(false);
  const [hasFrame, setHasFrame] = useState(false);
  useEffect(() => {
    const update = (event?: Event) =>
      setHasFrame(event?.type !== "waiting" && canCaptureVideoFrame(video));
    const events = [
      "loadeddata",
      "resize",
      "emptied",
      "seeking",
      "seeked",
      "error",
      "waiting",
      "canplay",
    ];
    update();
    events.forEach((event) => video?.addEventListener(event, update));
    return () =>
      events.forEach((event) => video?.removeEventListener(event, update));
  }, [video, frameReady]);
  const enabled = frameReady && !switching && hasFrame;
  const takeScreenshot = async () => {
    if (busyRef.current || !enabled) return;
    busyRef.current = true;
    setSaving(true);
    try {
      const png = await captureVideoFrame(video);
      await savePreviewScreenshot(roomId, png, recordingId);
      message.success(`截图已保存`);
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "截图保存失败，请重试",
      );
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  };
  return { saving, enabled, takeScreenshot };
}
