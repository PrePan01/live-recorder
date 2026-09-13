import type { NativeBridge } from '../bridge/nativeBridge';

export interface LiveStartedNotification {
  roomId: string;
  displayName: string;
}

export function sendLiveStartedDesktopNotification(
  nativeBridge: Pick<NativeBridge, 'notify'>,
  notification: LiveStartedNotification,
): Promise<void> {
  return nativeBridge.notify(
    'Live Recorder提醒',
    `订阅的 ${notification.displayName} 已开播`,
  );
}
