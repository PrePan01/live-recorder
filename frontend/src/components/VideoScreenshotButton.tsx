import { CameraOutlined } from "@ant-design/icons";
import { Button, Tooltip } from "antd";
import type { useVideoScreenshot } from "../hooks/useVideoScreenshot";

export function VideoScreenshotButton({
  enabled,
  saving,
  takeScreenshot,
}: ReturnType<typeof useVideoScreenshot>) {
  return (
    <Tooltip title="截图">
      <Button
        type="text"
        size="small"
        aria-label="截图"
        icon={<CameraOutlined />}
        disabled={!enabled}
        loading={saving}
        onClick={() => void takeScreenshot()}
      />
    </Tooltip>
  );
}
