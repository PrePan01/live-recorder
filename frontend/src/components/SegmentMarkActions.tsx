import type { ReactNode } from "react";
import { Button, Tooltip } from "antd";
import Icon from "@ant-design/icons";
import type { useSegmentMarking } from "../hooks/useSegmentMarking";

function SegmentIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="16" />
      <path d="M6 4v16M18 4v16M2 8h4M2 12h4M2 16h4M18 8h4M18 12h4M18 16h4" />
    </svg>
  );
}
export function SegmentMarkActions({
  marking,
  disabled,
  children,
}: {
  marking: ReturnType<typeof useSegmentMarking>;
  current?: number;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      <Tooltip title="Alt+P">
        <Button
          size="small"
          icon={<Icon component={SegmentIcon} />}
          disabled={disabled}
          loading={marking.saving}
          onClick={() => void marking.mark()}
        >
          {marking.start == null ? "标记片段" : "片段结束"}
        </Button>
      </Tooltip>
      {children}
      {marking.start != null ? (
        <>
          <Button
            size="small"
            disabled={marking.saving}
            onClick={marking.cancel}
          >
            取消标记片段
          </Button>
        </>
      ) : null}
    </>
  );
}
