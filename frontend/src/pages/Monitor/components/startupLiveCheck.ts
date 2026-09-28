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
