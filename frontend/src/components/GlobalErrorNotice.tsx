import { useEffect } from "react";
import { App } from "antd";
import { isExpectedCancellation, reportError } from "../utils/errorDiagnostics";

/** Global handlers diagnose unexpected async failures without replacing the running UI. */
export default function GlobalErrorNotice() {
  const { message } = App.useApp();

  useEffect(() => {
    const show = (source: string, reason: unknown) => {
      if (isExpectedCancellation(reason)) return;
      const result = reportError(source, reason);
      console.error(`[live-recorder] ${source}`, reason);
      if (result.shouldNotify) message.warning("操作异常", 3);
    };
    const onError = (event: ErrorEvent) =>
      show("window.error", event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => {
      if (isExpectedCancellation(event.reason)) return;
      event.preventDefault();
      show("window.unhandledrejection", event.reason);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [message]);
  return null;
}
