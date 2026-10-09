import { styles } from "./highlightStyles";
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
        <div style={styles.menu}>
          <Space size={2} align="center">
            <Typography.Text type="secondary" style={styles.secondaryText}>
              当前已缓存
            </Typography.Text>
            <Tooltip title="清空当前直播缓存">
              <Button
                size="small"
                type="text"
                aria-label="清空当前直播缓存"
                icon={<ClearOutlined />}
                style={styles.clearButton}
                disabled={highlightAvailableSeconds < 1}
                onClick={clearHighlight}
              />
            </Tooltip>
          </Space>
          <div style={styles.bufferedTime}>
            {formatSeconds(highlightAvailableSeconds)}
          </div>
          <Typography.Text type="secondary" style={styles.secondaryText}>
            {highlightAvailableSeconds > 0
              ? `缓存上限 ${formatSeconds(highlightMaxSeconds)}`
              : "正在接收直播帧，稍后即可保存"}
            {highlightDisabledReason === "slow_disk"
              ? "；磁盘写入过慢，已暂停继续缓存（已完成片段仍可导出）"
              : highlightDisabledReason === "write_error"
                ? "；缓存写入失败，已暂停继续缓存（已完成片段仍可导出）"
                : ""}
          </Typography.Text>
          <div style={styles.divider} />
          <Typography.Text strong style={styles.sectionTitle}>
            保存最近片段
          </Typography.Text>
          <Button.Group size="small" style={styles.quickButtons}>
            {quickSeconds.map((seconds, index) => (
              <Button
                key={`${seconds}-${index}`}
                style={styles.fill}
                onClick={() => saveHighlight(seconds)}
                disabled={exporting || highlightAvailableSeconds < seconds}
              >
                前 {formatSeconds(seconds)}
              </Button>
            ))}
          </Button.Group>
          <Space style={styles.row}>
            <Tooltip title="当前已缓存时长">
              <Button
                size="small"
                type="text"
                aria-label="填入当前已缓存时长"
                icon={<ClockCircleOutlined />}
                style={styles.fillTimeButton}
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
              style={styles.fill}
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
        style={styles.actionButton}
        size="small"
        icon={<ClockCircleOutlined />}
        disabled={exporting}
      >
        精彩时刻
      </Button>
    </Dropdown>
  );
}
