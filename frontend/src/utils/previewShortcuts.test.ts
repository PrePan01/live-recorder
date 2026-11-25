import { describe, expect, it } from "vitest";
import {
  findPreviewAction,
  previewBinding,
  previewShortcutDefinitions,
  readShortcutEvent,
  readShortcutOverrides,
  updateShortcutOverride,
} from "./previewShortcuts";
import { formatShortcut, isReplayAltShortcut } from "./keyboardShortcuts";

function key(code: string, fields: Partial<KeyboardEvent> = {}) {
  return { code, getModifierState: () => false, ...fields } as KeyboardEvent;
}

describe("preview shortcut bindings", () => {
  it("recognizes every default on macOS and Windows by physical key", () => {
    for (const mac of [true, false]) {
      for (const { id, binding } of previewShortcutDefinitions) {
        const shortcut = readShortcutEvent(key(binding.code, {
          key: mac ? "®" : "r",
          altKey: "alt" in binding,
          shiftKey: "shift" in binding,
        }), mac);
        expect(shortcut && findPreviewAction({}, shortcut)).toBe(id);
      }
    }
    expect(formatShortcut({ code: "KeyR", alt: true, shift: true }, true)).toBe("Option+Shift+R");
    expect(formatShortcut({ code: "KeyR", alt: true, shift: true }, false)).toBe("Alt+Shift+R");
  });

  it("requires an exact modifier match and ignores composition, AltGr and repeats", () => {
    const extraModifier = readShortcutEvent(key("KeyS", { altKey: true, shiftKey: true }), false);
    expect(extraModifier && findPreviewAction({}, extraModifier)).toBeUndefined();
    for (const fields of [
      { isComposing: true },
      { keyCode: 229 },
      { key: "Dead" },
      { getModifierState: (modifier: string) => modifier === "AltGraph" },
      { repeat: true },
    ]) {
      expect(readShortcutEvent(key("KeyM", { altKey: true, ...fields }))).toBeUndefined();
    }
  });

  it("keeps Shift optional for fixed replay bindings but blocks text composition and repeats", () => {
    expect(isReplayAltShortcut(key("KeyM", { altKey: true }))).toBe(true);
    expect(isReplayAltShortcut(key("KeyP", { altKey: true, shiftKey: true }))).toBe(true);
    for (const fields of [
      { ctrlKey: true },
      { metaKey: true },
      { repeat: true },
      { isComposing: true },
      { defaultPrevented: true },
      { getModifierState: (modifier: string) => modifier === "AltGraph" },
    ]) {
      expect(isReplayAltShortcut(key("KeyP", { altKey: true, ...fields }))).toBe(false);
    }
  });

  it("keeps navigation and common system shortcuts reserved", () => {
    expect(readShortcutEvent(key("Tab"), false)).toBeUndefined();
    expect(readShortcutEvent(key("F4", { altKey: true }), false)).toBeUndefined();
    expect(readShortcutEvent(key("ArrowLeft", { altKey: true }), false)).toBeUndefined();
    expect(readShortcutEvent(key("KeyQ", { metaKey: true }), true)).toBeUndefined();
    expect(readShortcutEvent(key("KeyK", { metaKey: true }), true)).toEqual({ code: "KeyK", meta: true });
    expect(readShortcutEvent(key("Escape"), true)).toEqual({ code: "Escape" });
  });

  it("supports clearing, reassigning, and resetting without creating a conflict", () => {
    const escape = { code: "Escape" };
    expect(updateShortcutOverride({}, "mark", escape, false)).toEqual({
      error: "该快捷键已用于关闭预览弹窗",
    });
    const reassigned = updateShortcutOverride({ closePreview: null }, "mark", escape, false);
    expect(reassigned).toEqual({ overrides: { closePreview: null, mark: escape } });
    if (!("overrides" in reassigned)) throw new Error(reassigned.error);
    expect(findPreviewAction(reassigned.overrides, escape)).toBe("mark");
    expect(findPreviewAction(reassigned.overrides, { code: "KeyM", alt: true })).toBeUndefined();
    expect(updateShortcutOverride(reassigned.overrides, "closePreview", undefined, false))
      .toEqual({ error: "该快捷键已用于标记当前位置" });
    expect(updateShortcutOverride({ closePreview: null }, "closePreview", undefined, false))
      .toEqual({ overrides: {} });
  });

  it("recovers malformed and conflicting saved entries while retaining valid changes", () => {
    const raw = JSON.parse(JSON.stringify({
      closePreview: null,
      screenshot: { code: "KeyK", ctrl: true },
      mark: { code: "KeyR", alt: true },
      seekForward: { code: "Tab" },
      obsolete: { code: "KeyG" },
    }));
    const overrides = readShortcutOverrides(raw, false);
    expect(overrides).toEqual({ closePreview: null, screenshot: { code: "KeyK", ctrl: true } });
    expect(previewBinding(overrides, "mark")).toEqual({ code: "KeyM", alt: true });
    expect(readShortcutOverrides("malformed", false)).toEqual({});
  });
});
