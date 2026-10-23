import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RoomPolicyFields from "./RoomPolicyFields";
import type { RoomEffectivePolicy } from "../../../types/room";
import type { Settings } from "../../../types/settings";

function render(enabled: boolean, batch = false, reminder = false) {
  return renderToStaticMarkup(createElement(RoomPolicyFields, {
    value: { liveNotificationEnabled: reminder },
    settings: { mail: { enabled }, checkIntervalSec: { default: 60 } } as Settings,
    onChange: () => {},
    presentation: batch ? "form" : "console",
    batch,
  }));
}

describe("room live reminder", () => {
  it.each([false, true])("shows only the live reminder regardless of global mail configuration (batch=%s)", batch => {
    for (const mailEnabled of [false, true]) {
      const markup = render(mailEnabled, batch);
      expect(markup).toContain('aria-label="开播提醒"');
      expect(markup).not.toContain('aria-label="邮件通知"');
      expect(markup).not.toContain('aria-label="桌面通知"');
      if (!batch) {
        expect(markup).toMatch(/aria-label="开播提醒"[^>]*aria-checked="false"/);
        expect(render(mailEnabled, batch, true)).toMatch(/aria-label="开播提醒"[^>]*aria-checked="true"/);
      }
    }
  });
});


describe("effective policy updates", () => {
  it("updates inherited switches and values when a refreshed room arrives", () => {
    const settings = { autoRecord: true, danmaku: { enabled: true }, quality: "720p",
      checkIntervalDefaults: { bilibili: 45 } } as Settings;
    const effective: RoomEffectivePolicy = {
      autoRecord: { value: false, source: "global" },
      danmakuEnabled: { value: false, source: "global" },
      quality: { value: "original", source: "global" },
      checkIntervalSec: { value: 60, source: "global" },
    };
    const renderPolicy = (policy: RoomEffectivePolicy) => renderToStaticMarkup(createElement(RoomPolicyFields, {
      value: { autoRecord: null, danmakuEnabled: null, quality: null, checkIntervalSec: null },
      effective: policy, settings, platform: "bilibili", presentation: "console", onChange: () => {},
    }));
    expect(renderPolicy(effective)).toMatch(/aria-label="自动录制"[^>]*aria-checked="false"/);
    const updated = renderPolicy({
      autoRecord: { value: true, source: "global" },
      danmakuEnabled: { value: true, source: "global" },
      quality: { value: "720p", source: "global" },
      checkIntervalSec: { value: 45, source: "global" },
    });
    expect(updated).toMatch(/aria-label="自动录制"[^>]*aria-checked="true"/);
    expect(updated).toMatch(/aria-label="弹幕保存"[^>]*aria-checked="true"/);
    expect(updated).toContain("45 秒");
    expect(updated).toContain("720p");
  });
});
