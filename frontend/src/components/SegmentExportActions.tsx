import { Button } from "antd";
import { ExportOutlined } from "@ant-design/icons";
import type { useSegmentExport } from "../hooks/useSegmentExport";

export function SegmentExportActions({
  exports,
  disabled = false,
}: {
  exports: ReturnType<typeof useSegmentExport>;
  disabled?: boolean;
}) {
  if (!exports.segmentIds.length) return null;
  return (
    <>
      <Button
        size="small"
        icon={<ExportOutlined />}
        disabled={disabled || exports.busy}
        onClick={exports.selectOrSubmit}
      >
        {exports.selecting
          ? exports.selectedIds.length
            ? `导出${exports.selectedIds.length}条选中片段`
            : "取消导出"
          : "导出选中片段"}
      </Button>
    </>
  );
}
