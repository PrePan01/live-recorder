import { create } from "./createStore";
import { readPref, writePref } from "../utils/prefStorage";
import {
  readShortcutOverrides,
  updateShortcutOverride,
  type PreviewAction,
  type ShortcutOverrides,
} from "../utils/previewShortcuts";
import type { Shortcut } from "../utils/keyboardShortcuts";

const storageKey = "lr-preview-shortcuts";

type State = {
  overrides: ShortcutOverrides;
  setBinding: (action: PreviewAction, value: Shortcut | null | undefined) => string | undefined;
  restoreFromBackup: (value: unknown) => void;
  resetAll: () => void;
};

export const usePreviewShortcutStore = create<State>((set, get) => {
  const save = (overrides: ShortcutOverrides) => {
    writePref(storageKey, overrides);
    set({ overrides });
  };

  return {
    overrides: readShortcutOverrides(readPref<unknown>(storageKey, {})),
    setBinding(action, value) {
      const result = updateShortcutOverride(get().overrides, action, value);
      if ("error" in result) return result.error;
      save(result.overrides);
    },
    restoreFromBackup(value) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        save(readShortcutOverrides(value));
      }
    },
    resetAll: () => save({}),
  };
});
