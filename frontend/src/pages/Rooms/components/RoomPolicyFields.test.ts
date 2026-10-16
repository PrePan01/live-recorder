import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RoomPolicyFields from "./RoomPolicyFields";
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
