import { describe, expect, it, vi } from 'vitest';
import { sendLiveStartedDesktopNotification } from './liveNotification';

describe('sendLiveStartedDesktopNotification', () => {
  it('sends the required title and room-specific live-start message', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await sendLiveStartedDesktopNotification({ notify }, { roomId: 'room_1', displayName: '主播A' });
    expect(notify).toHaveBeenCalledWith('Live Recorder提醒', '订阅的 主播A 已开播');
  });
});
