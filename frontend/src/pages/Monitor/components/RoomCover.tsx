import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { App, Spin } from "antd";
import {
  DownloadOutlined,
  LoadingOutlined,
  PictureOutlined,
} from "@ant-design/icons";
import { liveCoverSrc, saveLiveCover } from "../../../api/rooms";
import type { Room } from "../../../types/room";
import { hoverPreview } from "../../../utils/hoverPreview";

const VideoPlayer = lazy(() => import("../../../components/VideoPlayer"));

// Parent keys this component by the cover URL, so a new cover gets a fresh load state.
export default function RoomCover({ room }: { room: Room }) {
  const { message } = App.useApp();
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    room.liveCoverUrl ? "loading" : "failed",
  );
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const coverRef = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const owner = useRef(Symbol("cover-preview")).current;
  const previewing = useSyncExternalStore(
    hoverPreview.subscribe,
    () => hoverPreview.isActive(owner),
    () => false,
  );
  const [previewReady, setPreviewReady] = useState(false);
  const stopPreview = useCallback(() => {
    hovered.current = false;
    hoverPreview.cancel(owner);
  }, [owner]);
  useEffect(() => stopPreview, [stopPreview]);
  useEffect(() => {
    if (!previewing) {
      setPreviewReady(false);
      return;
    }
    const stopWhenHidden = () => {
      if (document.visibilityState !== "visible") stopPreview();
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) stopPreview();
    });
    if (coverRef.current) observer.observe(coverRef.current);
    document.addEventListener("visibilitychange", stopWhenHidden);
    window.addEventListener("blur", stopPreview);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", stopWhenHidden);
      window.removeEventListener("blur", stopPreview);
    };
  }, [previewing, stopPreview]);
  useEffect(() => {
    if (room.lastLiveStatus !== "live" || status !== "ready") stopPreview();
  }, [room.lastLiveStatus, status, stopPreview]);
  const src = room.liveCoverUrl
    ? liveCoverSrc(room.id, room.liveCoverUrl)
    : undefined;
  const save = async () => {
    if (pending.current || status !== "ready") return;
    pending.current = true;
    setSaving(true);
    try {
      const result = await saveLiveCover(room);
      if (result === "saved") message.success("封面已保存");
      if (result === "downloaded") message.success("封面下载已开始");
    } catch (error) {
      message.error(
        error instanceof Error ? error.message : "封面保存失败，请重试",
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <div className={`lr-room-cover-slot lr-room-cover-slot--${status}`}>
      <div
        ref={coverRef}
        className={`lr-room-cover lr-room-cover--${status}`}
        onPointerEnter={(event) => {
          if (
            event.pointerType !== "mouse" ||
            event.buttons !== 0 ||
            status !== "ready" ||
            room.lastLiveStatus !== "live"
          ) {
            return;
          }
          hovered.current = true;
          hoverPreview.request(
            owner,
            () => document.visibilityState === "visible" && hovered.current,
          );
        }}
        onPointerLeave={stopPreview}
        onPointerCancel={stopPreview}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        aria-busy={saving || status === "loading"}
      >
        {src ? (
          <>
            {status === "ready" ? (
              <img
                className="lr-room-cover__backdrop"
                src={src}
                alt=""
                aria-hidden="true"
              />
            ) : null}
            <img
              className="lr-room-cover__image"
              src={src}
              alt={`${room.displayName} 的直播封面`}
              loading="lazy"
              decoding="async"
              onLoad={() => setStatus("ready")}
              onError={() => setStatus("failed")}
            />
          </>
        ) : null}
        {previewing ? (
          <div
            className={`lr-room-cover__preview ${previewReady ? "lr-room-cover__preview--ready" : ""}`}
            aria-hidden="true"
          >
            <Suspense fallback={null}>
              <VideoPlayer
                roomId={room.id}
                platform={room.platform}
                muted
                fill
                thumbnail
                onLiveFirstFrame={() => setPreviewReady(true)}
                onPreviewError={stopPreview}
              />
            </Suspense>
          </div>
        ) : null}
        {status !== "ready" ? (
          <span className="lr-room-cover__placeholder">
            {status === "loading" ? <Spin size="small" /> : <PictureOutlined />}
            {status === "loading"
              ? "封面加载中"
              : src
                ? "封面加载失败"
                : "暂无封面"}
          </span>
        ) : (
          <button
            type="button"
            className="lr-room-cover__save"
            disabled={saving}
            onClick={() => void save()}
            aria-label={
              saving ? "正在保存封面" : `保存 ${room.displayName} 的直播封面`
            }
            title="保存封面"
          >
            <span className="lr-room-cover__save-icon" aria-hidden="true">
              {saving ? <LoadingOutlined spin /> : <DownloadOutlined />}
            </span>
            {saving ? "正在保存" : "保存封面"}
          </button>
        )}
      </div>
    </div>
  );
}
