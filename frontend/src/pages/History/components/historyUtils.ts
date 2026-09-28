import { bridge } from "../../../stores/bootStore";

const QUALITY_LABEL: Record<string, string> = {
  original: "原画",
  "1080p": "1080p",
  "720p": "720p",
  "360p": "360p",
};
function phaseOfUpload(progress: number): "sending" | "cloud" | "verifying" {
  if (progress >= 99) return "verifying";
  if (progress < 50) return "sending";
  return "cloud";
}
const EXPORT_STATUS_COLOR: Record<string, string> = {
  queued: "default",
  running: "processing",
  ok: "green",
  partial: "orange",
  failed: "red",
  cancelled: "default",
};

function openExternalUrl(url: string): void {
  void bridge.openPath(url).catch(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  });
}

export { QUALITY_LABEL, phaseOfUpload, EXPORT_STATUS_COLOR, openExternalUrl };
