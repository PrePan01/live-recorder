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
      style={{
        position: "relative",
        background: "#000",
        overflow: "hidden",
        ...(fill ? { height: "100%" } : null),
      }}
    >
      {!thumbnail && state === "loading" && !hasEverPlayedRef.current && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 1,
            display: "grid",
            placeItems: "center",
            pointerEvents: "none",
          }}
        >
          <Spin description="连接预览流…" />
        </div>
      )}
      {!thumbnail && state === "error" && (
        <div style={{ padding: 24 }}>
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
        <div style={{ padding: 24 }}>
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
        style={{
          width: "100%",
          ...(fill
            ? { height: "100%", objectFit: "contain" as const }
            : { aspectRatio: aspectRatio ? String(aspectRatio) : "16 / 9" }),
          display: state === "error" || state === "ended" ? "none" : "block",
        }}
      />
      {preserveFrameOnSwitch && (
        <canvas
          ref={transitionRef}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            background: "#000",
            pointerEvents: "none",
            display: "none",
            visibility:
              state === "error" || state === "ended" ? "hidden" : "visible",
          }}
        />
      )}
    </div>
  );
}
