// 挂载确认
import { useLayoutEffect } from "react";

export default function ReactMountedMarker() {
  useLayoutEffect(() => {
    document.getElementById("boot-hint")?.remove();
    document.documentElement.dataset.reactReady = "1";
    try {
      localStorage.setItem("lr-react-mounted", String(Date.now()));
    } catch {}
    console.log("[live-recorder] react mounted, boot-hint removed");
  }, []);
  return null;
}
