import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { usePreviewShortcutStore } from "../../stores/previewShortcutStore";
import { topModalDialog } from "../../utils/foregroundDialog";
import { isComposingShortcut, isEditableShortcutTarget } from "../../utils/keyboardShortcuts";
import {
  findPreviewAction,
  readShortcutEvent,
  type PreviewAction,
  type ShortcutOverrides,
} from "../../utils/previewShortcuts";

type RunPreviewAction = (action: PreviewAction) => boolean;

export function dispatchPreviewShortcut(
  event: KeyboardEvent,
  overrides: ShortcutOverrides,
  run: RunPreviewAction,
  foreground: (event: KeyboardEvent) => boolean,
) {
  if (event.defaultPrevented) return;
  const shortcut = readShortcutEvent(event);
  const action = shortcut && findPreviewAction(overrides, shortcut);
  if (action && foreground(event) && run(action)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

const exclusiveTarget = [
  '[role="listbox"]', '[role="menu"]',
  '[role="slider"]:not([data-preview-playhead])',
].join(",");

export function usePreviewShortcuts({
  enabled,
  anchor,
  playerPortalId,
  run,
  selectionActive,
  dismissConfirmation,
}: {
  enabled: boolean;
  anchor: RefObject<HTMLElement | null>;
  playerPortalId: string;
  run: RunPreviewAction;
  selectionActive: () => boolean;
  dismissConfirmation?: () => void;
}) {
  const latest = useRef({ run, selectionActive, dismissConfirmation });
  useLayoutEffect(() => {
    latest.current = { run, selectionActive, dismissConfirmation };
  });

  useEffect(() => {
    if (!enabled) return;
    const activeDialog = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      const dialog = anchor.current?.closest('[role="dialog"]');
      return dialog && topModalDialog() === dialog ? dialog : undefined;
    };
    const inScope = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (isEditableShortcutTarget(target) || target?.closest(exclusiveTarget) ||
        latest.current.selectionActive()) return false;
      const dialog = activeDialog();
      if (!dialog) return false;
      if (target && target !== document.body && target !== document.documentElement &&
        !dialog.contains(target) && !document.getElementById(playerPortalId)?.contains(target)) return false;
      for (const popup of document.querySelectorAll(
        ".ant-popover:not(.ant-popover-hidden), .ant-dropdown:not(.ant-dropdown-hidden), .ant-select-dropdown:not(.ant-select-dropdown-hidden)",
      )) {
        if (popup.getClientRects().length) return false;
      }
      return true;
    };
    const runCurrent: RunPreviewAction = (action) => latest.current.run(action);
    const keydown = (event: KeyboardEvent) => {
      const { dismissConfirmation } = latest.current;
      if (dismissConfirmation) {
        if (event.code === "Escape" && !event.defaultPrevented &&
          !event.repeat && !isComposingShortcut(event) && activeDialog()) {
          event.preventDefault();
          event.stopPropagation();
          dismissConfirmation();
        }
        return;
      }
      dispatchPreviewShortcut(event, usePreviewShortcutStore.getState().overrides, runCurrent, inScope);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [enabled, anchor, playerPortalId]);
}
