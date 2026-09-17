import { useEffect, useRef } from "react";
import styles from "./index.module.css";

const DEBUG_STORAGE_KEY = "lr-wall-mirror-debug";

function saveDebugSnapshot(id: string, value: Record<string, unknown>) {
  try {
    const current = JSON.parse(
      localStorage.getItem(DEBUG_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    localStorage.setItem(
      DEBUG_STORAGE_KEY,
      JSON.stringify({ ...current, [id]: value }),
    );
  } catch {
    // 诊断不能影响直播墙本身。
  }
}

/**
 * 将同一房间的主 video 镜像到重复格子。
 *
 * CSS 尺寸与 Canvas 绘制缓冲区是两套尺寸。绘制缓冲区绝不能参与画面框的布局，
 * 否则 WebKit 全屏重排会产生 ResizeObserver loop 并令镜像按固有尺寸缩小。
 */
export default function VideoMirror({
  source,
  layoutVersion,
}: {
  source: HTMLVideoElement | null;
  /** 进入或退出直播墙全屏时重测一次稳定后的画面框。 */
  layoutVersion: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const debugId = useRef(`mirror-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas || !source) return;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    let disposed = false;
    let animationFrame: number | null = null;
    let drawWidth = 0;
    let drawHeight = 0;
    let lastMediaTime = Number.NaN;
    let drawCount = 0;
    let lastDrawError = "";
    let lastDebugAt = 0;

    const syncBackingStore = (cssWidth: number, cssHeight: number) => {
      if (cssWidth <= 0 || cssHeight <= 0) return;
      // 三路墙最多两个镜像；限制到 1.5x 足够清晰且避免全屏时不必要的 GPU 内存。
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      const nextWidth = Math.max(1, Math.round(cssWidth * ratio));
      const nextHeight = Math.max(1, Math.round(cssHeight * ratio));
      if (canvas.width === nextWidth && canvas.height === nextHeight) {
        drawWidth = nextWidth;
        drawHeight = nextHeight;
        return;
      }
      canvas.width = nextWidth;
      canvas.height = nextHeight;
      drawWidth = nextWidth;
      drawHeight = nextHeight;
    };

    const resize = () => {
      const { width, height } = frame.getBoundingClientRect();
      syncBackingStore(width, height);
    };
    resize();

    // Tauri 的“应用内全屏”只切换 CSS 类，不一定触发 window resize。布局提交后
    // 再取两次尺寸，覆盖 WebKit 的异步 fixed/grid 重排；这里刻意不用
    // ResizeObserver，避免 WebKit 将 Canvas 缓冲区更新误判为观察循环。
    let settleFrame: number | null = requestAnimationFrame(() => {
      resize();
      settleFrame = requestAnimationFrame(resize);
    });
    window.addEventListener("resize", resize);

    const draw = () => {
      if (
        disposed ||
        drawWidth === 0 ||
        drawHeight === 0 ||
        source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        !source.videoWidth ||
        !source.videoHeight
      ) {
        return;
      }
      try {
        context.fillStyle = "#000";
        context.fillRect(0, 0, drawWidth, drawHeight);
        const scale = Math.min(
          drawWidth / source.videoWidth,
          drawHeight / source.videoHeight,
        );
        const width = source.videoWidth * scale;
        const height = source.videoHeight * scale;
        context.drawImage(
          source,
          (drawWidth - width) / 2,
          (drawHeight - height) / 2,
          width,
          height,
        );
        drawCount += 1;
      } catch (error) {
        lastDrawError = error instanceof Error ? error.message : String(error);
      }
    };

    // WebKit 在 fixed/grid 切换期间会偶发停止派发 requestVideoFrameCallback，
    // 但 requestAnimationFrame 仍持续运行。只在媒体时间前进时真正复制画面，
    // 因此不会把两个镜像的 drawImage 调用放大到显示器刷新率。
    const scheduleFrame = () => {
      animationFrame = requestAnimationFrame(() => {
        if (!disposed && source.currentTime !== lastMediaTime) {
          lastMediaTime = source.currentTime;
          draw();
        }
        const now = performance.now();
        if (now - lastDebugAt >= 1_000) {
          lastDebugAt = now;
          const frameRect = frame.getBoundingClientRect();
          let pixel: number[] | null = null;
          try {
            pixel = Array.from(
              context.getImageData(
                Math.max(0, Math.floor(drawWidth / 2)),
                Math.max(0, Math.floor(drawHeight / 2)),
                1,
                1,
              ).data,
            );
          } catch {
            // 采样失败不代表 drawImage 失败，仍保留其它状态。
          }
          saveDebugSnapshot(debugId.current, {
            at: Date.now(),
            layoutVersion,
            frame: [Math.round(frameRect.width), Math.round(frameRect.height)],
            canvas: [canvas.width, canvas.height],
            source: {
              readyState: source.readyState,
              currentTime: source.currentTime,
              video: [source.videoWidth, source.videoHeight],
            },
            drawCount,
            lastDrawError,
            centerPixel: pixel,
          });
        }
        if (!disposed) scheduleFrame();
      });
    };
    scheduleFrame();

    return () => {
      disposed = true;
      window.removeEventListener("resize", resize);
      if (settleFrame !== null) cancelAnimationFrame(settleFrame);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    };
  }, [source, layoutVersion]);

  return (
    <div ref={frameRef} className={styles.mirrorFrame}>
      <canvas ref={canvasRef} className={styles.mirror} aria-label="直播画面镜像" />
    </div>
  );
}
