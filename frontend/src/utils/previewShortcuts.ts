import {
  isComposingShortcut,
  isMacKeyboard,
  type Shortcut,
} from "./keyboardShortcuts";

export const previewShortcutDefinitions = [
  {
    id: "startRecording",
    label: "开始录制",
    binding: { code: "KeyR", alt: true },
  },
  {
    id: "stopRecording",
    label: "停止录制",
    binding: { code: "KeyR", alt: true, shift: true },
  },
  { id: "screenshot", label: "截图", binding: { code: "KeyS", alt: true } },
  {
    id: "toggleDanmaku",
    label: "打开或关闭弹幕列表",
    binding: { code: "KeyD", alt: true },
  },
  {
    id: "pictureInPicture",
    label: "启用画中画",
    binding: { code: "KeyV", alt: true },
  },
  { id: "closePreview", label: "关闭预览弹窗", binding: { code: "Escape" } },
  { id: "mark", label: "标记当前位置", binding: { code: "KeyM", alt: true } },
  {
    id: "markSegment",
    label: "标记片段起点或终点",
    binding: { code: "KeyP", alt: true },
  },
  {
    id: "returnToLive",
    label: "返回直播",
    binding: { code: "KeyL", alt: true },
  },
  { id: "seekBack", label: "播放头后退 1 秒", binding: { code: "ArrowLeft" } },
  {
    id: "seekForward",
    label: "播放头前进 1 秒",
    binding: { code: "ArrowRight" },
  },
  {
    id: "seekBackFive",
    label: "播放头后退 5 秒",
    binding: { code: "ArrowLeft", shift: true },
  },
  {
    id: "seekForwardFive",
    label: "播放头前进 5 秒",
    binding: { code: "ArrowRight", shift: true },
  },
] as const satisfies readonly {
  id: string;
  label: string;
  binding: Shortcut;
}[];

export type PreviewAction = (typeof previewShortcutDefinitions)[number]["id"];
export type ShortcutOverrides = Partial<Record<PreviewAction, Shortcut | null>>;

const defaults = Object.fromEntries(
  previewShortcutDefinitions.map(({ id, binding }) => [id, binding]),
) as Record<PreviewAction, Shortcut>;
const modifiers = ["ctrl", "alt", "shift", "meta"] as const;
const supportedCode =
  /^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|F([1-9]|1[0-2])|Escape|Home|End|PageUp|PageDown|Backspace|Delete|Insert|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash|Backquote)$/;

function normalizeShortcut(value: unknown, mac: boolean): Shortcut | undefined {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || !supportedCode.test(record.code))
    return;
  const shortcut: Shortcut = { code: record.code };
  for (const modifier of modifiers) {
    if (record[modifier] === true) shortcut[modifier] = true;
    else if (record[modifier] !== undefined && record[modifier] !== false)
      return;
  }
  const { code, alt, ctrl, meta, shift } = shortcut;
  if (
    (!mac && meta) ||
    (alt && ["F4", "Escape", "ArrowLeft", "ArrowRight"].includes(code)) ||
    (ctrl && (code === "Escape" || (alt && code === "Delete"))) ||
    (!mac && ["F5", "F10", "F11", "F12"].includes(code)) ||
    ((mac ? meta : ctrl) &&
      [
        "KeyA",
        "KeyC",
        "KeyF",
        "KeyH",
        "KeyM",
        "KeyN",
        "KeyP",
        "KeyQ",
        "KeyR",
        "KeyT",
        "KeyV",
        "KeyW",
        "KeyX",
        "KeyZ",
        "Equal",
        "Minus",
        "Digit0",
      ].includes(code)) ||
    (mac &&
      meta &&
      shift &&
      ["Digit3", "Digit4", "Digit5", "Digit6"].includes(code))
  )
    return;
  return shortcut;
}

export function readShortcutEvent(event: KeyboardEvent, mac = isMacKeyboard()) {
  if (event.repeat || isComposingShortcut(event)) return;
  return normalizeShortcut(
    {
      code: event.code,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    },
    mac,
  );
}

export function previewBinding(
  overrides: ShortcutOverrides,
  action: PreviewAction,
): Shortcut | null {
  return overrides[action] === undefined ? defaults[action] : overrides[action];
}

export function findPreviewAction(
  overrides: ShortcutOverrides,
  shortcut: Shortcut,
  except?: PreviewAction,
): PreviewAction | undefined {
  return previewShortcutDefinitions.find(({ id }) => {
    const bound = previewBinding(overrides, id);
    return (
      id !== except &&
      bound?.code === shortcut.code &&
      modifiers.every((modifier) => bound[modifier] === shortcut[modifier])
    );
  })?.id;
}

export function readShortcutOverrides(
  value: unknown,
  mac = isMacKeyboard(),
): ShortcutOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = value as Record<string, unknown>;
  const overrides: ShortcutOverrides = {};
  for (const { id } of previewShortcutDefinitions) {
    if (entries[id] === null) overrides[id] = null;
    else {
      const shortcut = normalizeShortcut(entries[id], mac);
      if (shortcut) overrides[id] = shortcut;
    }
  }
  // Restoring a default can expose another conflict. Each pass drops one override.
  for (;;) {
    const conflict = previewShortcutDefinitions.find(({ id }) => {
      const shortcut = overrides[id];
      return shortcut && findPreviewAction(overrides, shortcut, id);
    });
    if (!conflict) return overrides;
    delete overrides[conflict.id];
  }
}

export function updateShortcutOverride(
  overrides: ShortcutOverrides,
  action: PreviewAction,
  value: Shortcut | null | undefined,
  mac = isMacKeyboard(),
): { overrides: ShortcutOverrides } | { error: string } {
  const shortcut =
    value === undefined
      ? defaults[action]
      : value === null
        ? null
        : normalizeShortcut(value, mac);
  if (shortcut === undefined)
    return { error: "这个按键组合不可用，请选择其他按键。" };
  const conflict = shortcut && findPreviewAction(overrides, shortcut, action);
  if (conflict) {
    const label = previewShortcutDefinitions.find(
      ({ id }) => id === conflict,
    )?.label;
    return { error: `该快捷键已用于${label}` };
  }
  const next = { ...overrides };
  if (value === undefined) delete next[action];
  else next[action] = shortcut;
  return { overrides: next };
}
