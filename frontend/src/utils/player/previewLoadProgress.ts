// 将直播加载阶段转成进度百分比和提示文字，避免进度倒退。
export interface PreviewLoadProgress {
  percent: number;
  label: string;
}

const STAGES: Record<string, PreviewLoadProgress> = {
  requested: { percent: 5, label: "正在连接直播…" },
  connected: { percent: 10, label: "正在获取直播内容…" },
  platform_cookie_ready: { percent: 20, label: "正在获取直播内容…" },
  stream_url_ready: { percent: 45, label: "正在加载直播内容…" },
  youtube_manifests_ready: { percent: 60, label: "正在加载直播内容…" },
  youtube_source_process_started: { percent: 65, label: "正在加载直播内容…" },
  source_ready: { percent: 70, label: "正在准备视频…" },
  reused_native_source: { percent: 70, label: "正在准备视频…" },
  reused_preview_stream: { percent: 70, label: "正在准备视频…" },
  youtube_initial_segments_ready: { percent: 75, label: "正在准备视频…" },
  youtube_native_stream_ready: { percent: 75, label: "正在准备视频…" },
  preview_encoder_started: { percent: 80, label: "正在准备视频…" },
  preview_media_ready: { percent: 85, label: "正在加载视频…" },
  receiving_media: { percent: 90, label: "正在加载视频…" },
  decoded: { percent: 95, label: "视频即将显示…" },
  presented: { percent: 100, label: "直播已就绪" },
};
export const initialPreviewLoadProgress = STAGES.requested;
const LOCAL_STAGES = new Set([
  "connected",
  "receiving_media",
  "decoded",
  "presented",
]);
export function isServerPreviewProgressStage(stage: unknown): stage is string {
  return (
    typeof stage === "string" &&
    Object.hasOwn(STAGES, stage) &&
    !LOCAL_STAGES.has(stage)
  );
}
export function advancePreviewLoadProgress(
  current: PreviewLoadProgress,
  stage: string,
): PreviewLoadProgress {
  const next = Object.hasOwn(STAGES, stage) ? STAGES[stage] : undefined;
  return next && next.percent > current.percent ? next : current;
}
