export type Shortcut = {
  code: string;
  ctrl?: true;
  alt?: true;
  shift?: true;
  meta?: true;
};

export function isMacKeyboard() {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
}

export function isComposingShortcut(event: KeyboardEvent) {
  return event.isComposing || event.keyCode === 229 || event.key === "Process" ||
    event.key === "Dead" || event.getModifierState("AltGraph");
}

export function isEditableShortcutTarget(target: EventTarget | null) {
  return target != null && target instanceof Element && Boolean(target.closest(
    'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]',
  ));
}

/** Fixed replay bindings historically accept an extra Shift modifier. */
export function isReplayAltShortcut(event: KeyboardEvent) {
  return event.altKey && !event.ctrlKey && !event.metaKey &&
    !event.defaultPrevented && !event.repeat && !isComposingShortcut(event) &&
    !isEditableShortcutTarget(event.target);
}

const keyLabels: Record<string, string> = {
  Escape: "Esc", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Backquote: "`",
};

export function formatShortcut(shortcut: Shortcut, mac = isMacKeyboard()) {
  const { code, ctrl, alt, shift, meta } = shortcut;
  return [
    ctrl && "Ctrl", meta && (mac ? "Command" : "Win"),
    alt && (mac ? "Option" : "Alt"), shift && "Shift",
    keyLabels[code] ?? code.replace(/^(Key|Digit)/, ""),
  ].filter(Boolean).join("+");
}

export function shortcutTitle(label: string, shortcut: Shortcut | null) {
  return shortcut ? `${label}（${formatShortcut(shortcut)}）` : label;
}
