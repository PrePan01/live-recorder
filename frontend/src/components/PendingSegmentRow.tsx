import { useState } from "react";
import { Button, Input, Modal, Tooltip } from "antd";
import { DeleteOutlined, EditOutlined } from "@ant-design/icons";
import { playbackClock } from "../utils/player/playbackClock";

export interface PendingSegment {
  start: number;
  text: string;
  saving: boolean;
  onEdit: (text: string) => void;
  onDelete: () => void;
}

export function PendingSegmentRow({ segment, timeWidth }: {
  segment: PendingSegment;
  timeWidth: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const save = () => {
    if (segment.saving || !draft.trim()) return;
    segment.onEdit(draft.trim());
    setEditing(false);
  };
  return (
    <>
      <div className="lr-marker-nav__row lr-marker-nav__row--pending">
        <span className="lr-marker-nav__seek">
          <time style={{ width: `${timeWidth}ch` }}>{playbackClock(segment.start)}—???</time>
          <span>{segment.text}</span>
        </span>
        <Tooltip title="编辑">
          <Button
            type="text"
            size="small"
            disabled={segment.saving}
            aria-label={`编辑 ${segment.text}`}
            icon={<EditOutlined />}
            onClick={() => { setDraft(segment.text); setEditing(true); }}
          />
        </Tooltip>
        <Tooltip title="删除（取消标记片段）">
          <Button
            type="text"
            size="small"
            disabled={segment.saving}
            aria-label={`删除 ${segment.text}`}
            icon={<DeleteOutlined />}
            onClick={segment.onDelete}
          />
        </Tooltip>
      </div>
      <Modal
        title="编辑标记"
        open={editing}
        onOk={save}
        onCancel={() => setEditing(false)}
        okButtonProps={{ disabled: segment.saving || !draft.trim() }}
        destroyOnHidden
      >
        <Input
          value={draft}
          maxLength={200}
          disabled={segment.saving}
          onChange={(event) => setDraft(event.target.value)}
          onPressEnter={save}
          aria-label="标记文字"
        />
      </Modal>
    </>
  );
}
