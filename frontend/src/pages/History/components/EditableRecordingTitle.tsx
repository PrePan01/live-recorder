import { useRef, useState } from "react";
import { App, Input, Typography } from "antd";
import { ApiError } from "../../../types/error";
import { describeError } from "../../../utils/errorMap";

interface Props {
  id: string;
  title: string;
  onSave: (id: string, title: string) => Promise<void>;
}

export default function EditableRecordingTitle({ id, title, onSave }: Props) {
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const active = useRef(false);
  const pending = useRef(false);

  const beginEditing = () => {
    if (pending.current) return;
    active.current = true;
    setDraft(title);
    setEditing(true);
  };

  const finishEditing = () => {
    active.current = false;
    setEditing(false);
  };

  const save = async () => {
    // Enter、失焦或禁用输入框可能连续触发，单次编辑只提交一个请求。
    if (!active.current || pending.current) return;
    const nextTitle = draft.trim();
    if (!nextTitle) {
      message.warning("标题不能为空");
      finishEditing();
      return;
    }
    if (nextTitle === title) {
      finishEditing();
      return;
    }
    pending.current = true;
    setSaving(true);
    try {
      await onSave(id, nextTitle);
      finishEditing();
    } catch (error) {
      message.error(
        error instanceof ApiError
          ? describeError(error.code, error.message)
          : "标题保存失败，请重试",
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      {editing ? (
        <Input
          autoFocus
          aria-label="录制标题"
          value={draft}
          disabled={saving}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save()}
          onPressEnter={(event) => {
            if (!event.nativeEvent.isComposing) event.currentTarget.blur();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              finishEditing();
            }
          }}
        />
      ) : (
        <Typography.Text
          ellipsis
          title={title || "未命名"}
          style={{ display: "block", cursor: "text" }}
          tabIndex={0}
          onDoubleClick={(event) => {
            event.stopPropagation();
            beginEditing();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              beginEditing();
            }
          }}
        >
          {title || "未命名"}
        </Typography.Text>
      )}
    </div>
  );
}
