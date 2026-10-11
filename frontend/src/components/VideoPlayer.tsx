import { Alert, Button, Spin } from "antd";
import type { VideoPlayerProps } from "./video/types";
import { useVideoPlayback } from "./video/useVideoPlayback";
export type { VideoPlayerProps } from "./video/types";

export default function VideoPlayer(props: VideoPlayerProps) {
  const {
    muted = true,
    thumbnail = false,
    fill = false,
    aspectRatio,
    preserveFrameOnSwitch = false,
    seek = null,
    onSeekRetry,
  } = props;
  const {
    attachVideoRef,
    transitionRef,
    state,
    setState,
    errorMsg,
    setReloadToken,
    hasEverPlayedRef,
  } = useVideoPlayback(props);
  return (
    <div
      className="lr-video-player" style={{ ...(fill ? { height: "100%" } : null) }}
    >
      {!thumbnail && state === "loading" && !hasEverPlayedRef.current && (
        <div className="lr-video-player__loading">
          <Spin description="连接预览流…" />
        </div>
      )}
      {!thumbnail && state === "error" && (
        <div className="lr-video-player__message">
          <Alert
            type="error"
            showIcon
            message="预览不可用"
            description={errorMsg}
            action={
              <Button
                size="small"
                onClick={() => {
                  if (seek && onSeekRetry) onSeekRetry();
                  else setReloadToken((value) => value + 1);
                }}
              >
                重试播放器
              </Button>
            }
          />
        </div>
      )}
      {state === "ended" && (
        <div className="lr-video-player__message">
          <Alert type="info" showIcon message="本场录制已结束" />
        </div>
      )}
      <video
        ref={attachVideoRef}
        controls={!thumbnail}
        muted={thumbnail || muted}
        playsInline
        autoPlay={!seek}
        onCanPlay={() =>
          !seek &&
          setState((current) => (current === "loading" ? "playing" : current))
        }
        onPlaying={() => {
          if (!seek) setState("playing");
        }}
        className="lr-video-player__video" style={{
          ...(fill
            ? { height: "100%", objectFit: "contain" as const }
            : { aspectRatio: aspectRatio ? String(aspectRatio) : "16 / 9" }), display: state === "error" || state === "ended" ? "none" : "block"
        }}
      />
      {preserveFrameOnSwitch && (
        <canvas
          ref={transitionRef}
          aria-hidden="true"
          className="lr-video-player__transition" style={{
            visibility:
              state === "error" || state === "ended" ? "hidden" : "visible"
          }}
        />
      )}
    </div>
  );
}
