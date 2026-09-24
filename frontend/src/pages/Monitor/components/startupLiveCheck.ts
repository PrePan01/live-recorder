// Monitor 拆分（task #61）：启动时开播检测单例——自 index.tsx 原样迁移，零行为变更。
import { checkEnabledRooms } from "../../../api/rooms";

let startupLiveCheck: Promise<void> | null = null;

export function triggerStartupLiveCheck(): Promise<void> {
  if (!startupLiveCheck) {
    const request = checkEnabledRooms().then(() => undefined);
    startupLiveCheck = request;
    void request.catch(() => {
      if (startupLiveCheck === request) startupLiveCheck = null;
    });
  }
  return startupLiveCheck;
}
