import { Button, Input, Space } from "antd";
import { useState, type KeyboardEvent } from "react";
import { usePreviewShortcutStore } from "../../../stores/previewShortcutStore";
import {
  previewBinding,
  previewShortcutDefinitions,
  readShortcutEvent,
  updateShortcutOverride,
  type PreviewAction,
} from "../../../utils/previewShortcuts";
import { formatShortcut, isComposingShortcut, type Shortcut } from "../../../utils/keyboardShortcuts";
import { SettingsGroup } from "./SettingsPrimitives";

export function ShortcutsPanel() {
  const overrides = usePreviewShortcutStore((state) => state.overrides);
  const setBinding = usePreviewShortcutStore((state) => state.setBinding);
  const resetAll = usePreviewShortcutStore((state) => state.resetAll);
  const [editing, setEditing] = useState<PreviewAction>();
  const [candidate, setCandidate] = useState<Shortcut>();
  const [error, setError] = useState<{ action: PreviewAction; text: string }>();
  const candidateResult =
    editing &&
    candidate &&
    updateShortcutOverride(overrides, editing, candidate);
  const candidateError =
    candidateResult && "error" in candidateResult
      ? candidateResult.error
      : undefined;

  const finishEditing = () => {
    if (editing) {
      const id = `shortcut-${editing}-control`;
      requestAnimationFrame(() => document.getElementById(id)?.focus());
    }
    setEditing(undefined);
    setCandidate(undefined);
    setError(undefined);
  };
  const capture = (
    action: PreviewAction,
    event: KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.code === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (
      event.repeat ||
      isComposingShortcut(event.nativeEvent) ||
      /^(Control|Alt|Meta|Shift)(Left|Right)$/.test(event.code)
    )
      return;
    const shortcut = readShortcutEvent(event.nativeEvent);
    setCandidate(shortcut);
    setError(
      shortcut
        ? undefined
        : { action, text: "这个按键组合不可用，请选择其他按键。" },
    );
  };
  const save = (action: PreviewAction, value: Shortcut | null | undefined) => {
    const text = setBinding(action, value);
    if (text) setError({ action, text });
    else if (editing === action) finishEditing();
    else setError(undefined);
  };

  return (
    <SettingsGroup
      title="直播预览"
      action={
        <Button
          size="small"
          disabled={!Object.keys(overrides).length}
          onClick={() => {
            resetAll();
            finishEditing();
          }}
        >
          全部恢复默认
        </Button>
      }
    >
      {previewShortcutDefinitions.map(({ id, label }) => {
        const binding = previewBinding(overrides, id);
        const rowError =
          (error?.action === id ? error.text : undefined) ??
          (editing === id ? candidateError : undefined);
        const anchor = `shortcut-${id}`;
        return (
          <div id={anchor} key={id} className="lr-settings-row">
            <div className="lr-settings-row__copy">
              <span id={`${anchor}-label`} className="lr-settings-row__label">
                {label}
              </span>
            </div>
            <div className="lr-settings-row__control">
              {editing === id ? (
                <Space wrap>
                  <Input
                    autoFocus
                    readOnly
                    size="small"
                    aria-labelledby={`${anchor}-label`}
                    aria-describedby={rowError ? `${anchor}-error` : undefined}
                    status={rowError ? "error" : undefined}
                    placeholder="请按下快捷键"
                    value={candidate ? formatShortcut(candidate) : ""}
                    onKeyDown={(event) => capture(id, event)}
                  />
                  <Button
                    size="small"
                    type="primary"
                    disabled={!candidate || !!rowError}
                    onClick={() => candidate && save(id, candidate)}
                  >
                    保存
                  </Button>
                  <Button size="small" onClick={finishEditing}>
                    取消
                  </Button>
                </Space>
              ) : (
                <div className="lr-shortcut-binding">
                  <Button
                    id={`${anchor}-control`}
                    size="small"
                    aria-label={`修改${label}快捷键，当前${binding ? formatShortcut(binding) : "未绑定"}`}
                    onClick={() => {
                      setEditing(id);
                      setCandidate(undefined);
                      setError(undefined);
                    }}
                  >
                    {binding ? formatShortcut(binding) : "未绑定"}
                  </Button>
                  <Space className="lr-shortcut-binding__actions">
                    <Button
                      size="small"
                      type="text"
                      aria-label={`清除${label}快捷键`}
                      disabled={!binding}
                      onClick={() => save(id, null)}
                    >
                      清除
                    </Button>
                    <Button
                      size="small"
                      type="text"
                      aria-label={`恢复${label}的默认快捷键`}
                      disabled={overrides[id] === undefined}
                      onClick={() => save(id, undefined)}
                    >
                      恢复默认
                    </Button>
                  </Space>
                </div>
              )}
              {rowError && (
                <div
                  id={`${anchor}-error`}
                  className="lr-settings-save is-invalid"
                  role="alert"
                >
                  {rowError}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </SettingsGroup>
  );
}
