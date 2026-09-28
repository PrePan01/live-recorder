import { Select, Tag as AntTag } from "antd";
import type { CSSProperties } from "react";
import type { Tag } from "../types/tag";

interface TagFilterSelectProps {
  tags: Tag[];
  value: string[];
  onChange: (tagIds: string[]) => void;
  placeholder?: string;
  style?: CSSProperties;
  disabled?: boolean;
}

/** Shared colored multi-tag filter used by monitor, rooms, and statistics. */
export default function TagFilterSelect({
  tags,
  value,
  onChange,
  placeholder = "标签",
  style,
  disabled,
}: TagFilterSelectProps) {
  return (
    <Select
      mode="multiple"
      allowClear
      aria-label="标签筛选"
      placeholder={placeholder}
      className="lr-tag-filter"
      style={{ width: 140, height: 36, ...style }}
      styles={{
        root: { alignItems: "center" },
        content: { alignItems: "center" },
        placeholder: { top: "50%", transform: "translateY(-50%)" },
      }}
      maxTagCount="responsive"
      value={value}
      disabled={disabled}
      onChange={(next) => onChange(next as string[])}
      optionRender={(option) => {
        const tag = tags.find((item) => item.id === option.value);
        return (
          <AntTag
            className="lr-tag-filter__option"
            color={tag?.color}
            title={tag?.name}
            style={{ marginInlineEnd: 0 }}
          >
            <span>{option.label}</span>
          </AntTag>
        );
      }}
      tagRender={({ label, value: tagId, closable, onClose }) => {
        const tag = tags.find((item) => item.id === tagId);
        return (
          <AntTag
            className="lr-tag-filter__tag"
            color={tag?.color}
            closable={closable}
            title={tag?.name}
            style={{ marginInlineEnd: 0 }}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClose={onClose}
          >
            <span>{label}</span>
          </AntTag>
        );
      }}
      options={tags.map((tag) => ({ value: tag.id, label: tag.name }))}
    />
  );
}
