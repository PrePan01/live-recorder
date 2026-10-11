import { ClearOutlined, ClockCircleOutlined } from "@ant-design/icons";
import {
  Button,
  Dropdown,
  InputNumber,
  Space,
  Tooltip,
  Typography,
} from "antd";

import { usePreviewHighlights } from "../preview/usePreviewHighlights";
export function HighlightActions({
  highlightSeconds,
  setHighlightSeconds,
  highlightMaxSeconds,
  highlightAvailableSeconds,
  highlightDisabledReason,
  exporting,
  saveHighlight,
  clearHighlight,
  formatSeconds,
  quickSeconds,
}: ReturnType<typeof usePreviewHighlights>) {
  return (
    <Dropdown
      trigger={["click"]}
      placement="top"
      dropdownRender={() => (
        <div className="lr-highlight__menu">
          <Space size={2} align="center">
            <Typography.Text type="secondary" className="lr-highlight__secondary-text">
              当前已缓存
            </Typography.Text>
            <Tooltip title="清空当前直播缓存">
              <Button
                size="small"
                type="text"
                aria-label="清空当前直播缓存"
                icon={<ClearOutlined />}
                className="lr-highlight__clear-button"
                disabled={highlightAvailableSeconds < 1}
                onClick={clearHighlight}
              />
            </Tooltip>
          </Space>
          <div className="lr-highlight__buffered-time">
            {formatSeconds(highlightAvailableSeconds)}
          </div>
          <Typography.Text type="secondary" className="lr-highlight__secondary-text">
            {highlightAvailableSeconds > 0
              ? `缓存上限 ${formatSeconds(highlightMaxSeconds)}`
              : "正在接收直播帧，稍后即可保存"}
            {highlightDisabledReason === "slow_disk"
              ? "；磁盘写入过慢，已暂停继续缓存（已完成片段仍可导出）"
              : highlightDisabledReason === "write_error"
                ? "；缓存写入失败，已暂停继续缓存（已完成片段仍可导出）"
                : ""}
          </Typography.Text>
          <div className="lr-highlight__divider" />
          <Typography.Text strong className="lr-highlight__section-title">
            保存最近片段
          </Typography.Text>
          <Button.Group size="small" className="lr-highlight__quick-buttons">
            {quickSeconds.map((seconds, index) => (
              <Button
                key={`${seconds}-${index}`}
                className="lr-highlight__fill"
                onClick={() => saveHighlight(seconds)}
                disabled={exporting || highlightAvailableSeconds < seconds}
              >
                前 {formatSeconds(seconds)}
              </Button>
            ))}
          </Button.Group>
          <Space className="lr-highlight__row">
            <Tooltip title="当前已缓存时长">
              <Button
                size="small"
                type="text"
                aria-label="填入当前已缓存时长"
                icon={<ClockCircleOutlined />}
                className="lr-highlight__fill-time-button"
                disabled={highlightAvailableSeconds < 1}
                onClick={() =>
                  setHighlightSeconds(
                    Math.min(highlightAvailableSeconds, highlightMaxSeconds),
                  )
                }
              />
            </Tooltip>
            <InputNumber
              size="small"
              min={1}
              max={highlightMaxSeconds}
              precision={0}
              value={Math.min(highlightSeconds, highlightMaxSeconds)}
              changeOnWheel
              onChange={(v) =>
                setHighlightSeconds(Math.max(1, Math.round(Number(v ?? 30))))
              }
              className="lr-highlight__fill"
              addonAfter="秒"
            />
            <Button
              size="small"
              type="primary"
              loading={exporting}
              disabled={
                highlightAvailableSeconds < 1 ||
                highlightSeconds > highlightAvailableSeconds
              }
              onClick={() => saveHighlight(highlightSeconds)}
            >
              保存
            </Button>
          </Space>
        </div>
      )}
    >
      <Button
        className="lr-highlight__action-button"
        size="small"
        icon={<ClockCircleOutlined />}
        disabled={exporting}
      >
        精彩时刻
      </Button>
    </Dropdown>
  );
}
