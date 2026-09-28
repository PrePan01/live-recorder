import {
  Button,
  Input,
  Select,
  Space,
  Tag as AntTag,
  Tooltip,
  Typography,
} from "antd";
import {
  AppstoreOutlined,
  ReloadOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import MemphisRadioGroup from "../../../components/MemphisRadioGroup";
import { PlatformIcon } from "../../../components/PlatformLogo";
import type { Platform } from "../../../types/room";
import type { Tag } from "../../../types/tag";

export interface MonitorToolbarProps {
  filter: "全部" | "开播中" | "录制中" | "收藏";
  setFilter: (v: "全部" | "开播中" | "录制中" | "收藏") => void;
  platformFilter: "全部" | Platform;
  setPlatformFilter: (v: "全部" | Platform) => void;
  tagIds: string[];
  setTagIds: (v: string[]) => void;
  tags: Tag[];
  view: "卡片" | "列表";
  setView: (v: "卡片" | "列表") => void;
  keyword: string;
  setKeyword: (v: string) => void;
  liveCount: number;
  recordingCount: number;
  loading: boolean;
  refreshing: boolean;
  handleRefresh: () => Promise<void>;
}

export function MonitorToolbar({
  filter,
  setFilter,
  platformFilter,
  setPlatformFilter,
  tagIds,
  setTagIds,
  tags,
  view,
  setView,
  keyword,
  setKeyword,
  liveCount,
  recordingCount,
  loading,
  refreshing,
  handleRefresh,
}: MonitorToolbarProps) {
  return (
    <Space className="lr-page-header" wrap>
      <Typography.Title level={4} style={{ margin: 0 }}>
        监控总览
      </Typography.Title>
      <Space className="lr-page-actions" wrap>
        <MemphisRadioGroup
          options={[
            { label: "全部", value: "全部" },
            { label: `开播中 ${liveCount}`, value: "开播中" },
            { label: `录制中 ${recordingCount}`, value: "录制中" },
            { label: "收藏", value: "收藏" },
          ]}
          value={filter}
          onChange={(e) =>
            setFilter(e.target.value as "全部" | "开播中" | "录制中" | "收藏")
          }
        />
        <MemphisRadioGroup
          className="lr-platform-filter"
          aria-label="平台筛选"
          options={[
            { label: "全部", value: "全部" },
            {
              label: (
                <Tooltip title="B站">
                  <PlatformIcon platform="bilibili" />
                </Tooltip>
              ),
              value: "bilibili",
            },
            {
              label: (
                <Tooltip title="抖音">
                  <PlatformIcon platform="douyin" />
                </Tooltip>
              ),
              value: "douyin",
            },
          ]}
          value={platformFilter}
          onChange={(e) =>
            setPlatformFilter(e.target.value as "全部" | Platform)
          }
        />
        <Select
          mode="multiple"
          allowClear
          aria-label="标签筛选"
          placeholder="标签"
          className="lr-tag-filter"
          style={{ width: 140, height: 36 }}
          styles={{
            root: { alignItems: "center" },
            content: { alignItems: "center" },
            placeholder: { top: "50%", transform: "translateY(-50%)" },
          }}
          maxTagCount="responsive"
          value={tagIds}
          onChange={(v) => setTagIds(v as string[])}
          optionRender={(option) => {
            const tag = tags.find((item) => item.id === option.value);
            return (
              <AntTag color={tag?.color} style={{ marginInlineEnd: 0 }}>
                {option.label}
              </AntTag>
            );
          }}
          tagRender={({ label, value, closable, onClose }) => {
            const tag = tags.find((item) => item.id === value);
            return (
              <AntTag
                className="lr-tag-filter__tag"
                color={tag?.color}
                closable={closable}
                style={{ marginInlineEnd: 0 }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClose={onClose}
              >
                {label}
              </AntTag>
            );
          }}
          options={tags.map((t) => ({
            value: t.id,
            label: t.name,
          }))}
        />
        <MemphisRadioGroup
          className="lr-monitor-view-toggle"
          aria-label="显示方式"
          options={[
            {
              label: (
                <Tooltip title="卡片视图">
                  <AppstoreOutlined />
                </Tooltip>
              ),
              value: "卡片",
            },
            {
              label: (
                <Tooltip title="列表视图">
                  <UnorderedListOutlined />
                </Tooltip>
              ),
              value: "列表",
            },
          ]}
          value={view}
          onChange={(e) => {
            const nextView = e.target.value as "卡片" | "列表";
            setView(nextView);
            localStorage.setItem("lr-monitor-view", nextView);
          }}
        />
        <Input.Search
          allowClear
          placeholder="搜索房间"
          style={{ width: 180 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <Button
          aria-label="刷新"
          icon={<ReloadOutlined />}
          loading={loading || refreshing}
          onClick={() => {
            void handleRefresh().catch(() => undefined);
          }}
        ></Button>
      </Space>
    </Space>
  );
}
