import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useRef: (current: unknown) => ({ current }),
  useLayoutEffect: (effect: () => void) => effect(),
  useEffect: (effect: () => void) => effect(),
}));

import { dispatchPreviewShortcut, usePreviewShortcuts } from "./usePreviewShortcuts";
import { usePreviewShortcutStore } from "../../stores/previewShortcutStore";

function key(code: string, fields: Partial<KeyboardEvent> = {}) {
  return {
    code, getModifierState: () => false,
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    ...fields,
  } as unknown as KeyboardEvent;
}

afterEach(() => {
  usePreviewShortcutStore.getState().resetAll();
  vi.unstubAllGlobals();
});

describe("preview keyboard routing", () => {
  it("consumes matched keys only when the action is available", () => {
    const event = key("KeyR", { altKey: true, shiftKey: true });
    const run = vi.fn(() => false);
    dispatchPreviewShortcut(event, {}, run, () => true);
    expect(run).toHaveBeenCalledExactlyOnceWith("stopRecording");
    expect(event.preventDefault).not.toHaveBeenCalled();

    run.mockReset().mockReturnValue(true);
    dispatchPreviewShortcut(event, {}, run, () => true);
    expect(run).toHaveBeenCalledExactlyOnceWith("stopRecording");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it("leaves keys to an editable field, a selected range, or a higher overlay", () => {
    const { send, run, doc, dialog, higherDialog, input, popup, selectionActive } = mountShortcutListener();
    send(key("Escape", { target: input }));
    selectionActive.mockReturnValueOnce(true);
    send(key("ArrowLeft"));
    doc.querySelectorAll.mockReturnValueOnce([dialog, higherDialog]);
    send(key("Escape"));
    doc.querySelectorAll.mockReturnValueOnce([dialog]).mockReturnValueOnce([popup]);
    send(key("Escape"));
    doc.hasFocus.mockReturnValueOnce(false);
    send(key("Escape"));
    expect(run).not.toHaveBeenCalled();
    send(key("Escape"));
    expect(run).toHaveBeenCalledExactlyOnceWith("closePreview");
  });

  it("lets Escape dismiss the stop confirmation and suppresses preview actions until then", () => {
    const dismiss = vi.fn();
    const { send, run } = mountShortcutListener(dismiss);
    send(key("KeyR", { altKey: true, shiftKey: true }));
    send(key("Escape", { isComposing: true }));
    expect(dismiss).not.toHaveBeenCalled();
    const escape = key("Escape");
    send(escape);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });

  it("reads the latest saved binding and leaves cleared keys unhandled", () => {
    const { send, run, doc } = mountShortcutListener();
    const store = usePreviewShortcutStore.getState();
    store.setBinding("closePreview", null);
    store.setBinding("screenshot", { code: "KeyK" });
    send(key("Escape"));
    send(key("KeyS", { altKey: true }));
    send(key("ArrowLeft", { repeat: true }));
    expect(doc.querySelectorAll).not.toHaveBeenCalled();
    send(key("KeyK"));
    expect(run).toHaveBeenCalledExactlyOnceWith("screenshot");
  });
});

function mountShortcutListener(dismissConfirmation?: () => void) {
  class Target {
    private readonly editable: boolean;
    constructor(editable = false) { this.editable = editable; }
    closest() { return this.editable ? this : null; }
  }
  const input = new Target(true) as unknown as HTMLElement;
  const dialog = { getClientRects: () => [{}], closest: () => null, contains: () => true };
  const higherDialog = { ...dialog };
  const popup = { getClientRects: () => [{}] };
  const body = new Target();
  const doc = {
    body,
    activeElement: body,
    visibilityState: "visible",
    hasFocus: vi.fn(() => true),
    querySelectorAll: vi.fn((selector: string): { getClientRects: () => unknown[] }[] =>
      selector.includes("aria-modal") ? [dialog] : []),
    defaultView: { getComputedStyle: () => ({ zIndex: "1000" }) },
  };
  const addEventListener = vi.fn();
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { addEventListener });
  vi.stubGlobal("Element", Target);
  const run = vi.fn(() => true);
  const selectionActive = vi.fn(() => false);
  // The React mocks above install the capture listener synchronously.
  // oxlint-disable-next-line react-hooks/rules-of-hooks
  usePreviewShortcuts({
    enabled: true,
    anchor: { current: { closest: () => dialog } as unknown as HTMLElement },
    playerPortalId: "preview",
    selectionActive,
    run,
    dismissConfirmation,
  });
  const [eventType, send, capture] = addEventListener.mock.calls[0];
  expect([eventType, capture]).toEqual(["keydown", true]);
  return { send, run, doc, dialog, higherDialog, input, popup, selectionActive };
}
