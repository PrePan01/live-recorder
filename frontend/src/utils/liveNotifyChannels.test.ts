import { describe, expect, it } from "vitest";
import { liveNotifyChannels, liveNotifySentence } from "./liveNotifyChannels";
import type { Settings } from "../types/settings";

function settingsWith(partial: Record<string, unknown>): Settings {
  return {
    notifications: {
      desktop: { liveStarted: true },
      email: { liveStarted: true },
      qq: { liveStarted: true },
      dedupeWindowMinutes: 30,
    },
    mail: { enabled: true, host: "smtp", from: "a@b.c", recipients: ["x"] },
    qmsg: { enabled: true, keySet: true },
    ...partial,
  } as unknown as Settings;
}

describe("live notification channels", () => {
  it("counts a channel only when its event switch is on and the channel is usable", () => {
    expect(liveNotifyChannels(settingsWith({}), true)).toEqual([
      "桌面",
      "邮件",
      "QQ",
    ]);
    expect(
      liveNotifyChannels(
        settingsWith({
          notifications: {
            desktop: { liveStarted: true },
            email: { liveStarted: true },
            qq: { liveStarted: true },
            dedupeWindowMinutes: 30,
          },
          qmsg: { enabled: true, keySet: false },
        }),
        true,
      ),
    ).toEqual(["桌面", "邮件"]);
    expect(
      liveNotifyChannels(
        settingsWith({
          mail: { enabled: false, host: "smtp", from: "a@b.c", recipients: ["x"] },
        }),
        true,
      ),
    ).toEqual(["桌面", "QQ"]);
  });
  it("drops channels whose event switch is off or whose configuration is missing", () => {
    const none = {
      desktop: { liveStarted: false },
      email: { liveStarted: false },
      qq: { liveStarted: false },
      dedupeWindowMinutes: 30,
    };
    expect(liveNotifyChannels(settingsWith({ notifications: none }), true)).toEqual(
      [],
    );
    expect(liveNotifyChannels(null, true)).toEqual([]);
    expect(
      liveNotifyChannels(
        settingsWith({
          notifications: {
            desktop: { liveStarted: true },
            email: { liveStarted: true },
            qq: { liveStarted: true },
            dedupeWindowMinutes: 30,
          },
          mail: { enabled: true, host: "", from: "", recipients: [] },
          qmsg: { enabled: true, keySet: true },
        }),
        false,
      ),
    ).toEqual(["QQ"]);
  });
  it("builds the hover sentence with the documented wording", () => {
    expect(liveNotifySentence(["桌面", "QQ"])).toBe("将通过桌面与QQ通知");
    expect(liveNotifySentence(["桌面"])).toBe("将通过桌面通知");
    expect(liveNotifySentence(["桌面", "邮件", "QQ"])).toBe(
      "将通过桌面、邮件与QQ通知",
    );
  });
});
