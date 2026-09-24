import { Button, Input, Space, Tooltip, Typography } from "antd";
import {
  AppstoreOutlined,
  ReloadOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import MemphisRadioGroup from "../../../components/MemphisRadioGroup";
import { PlatformIcon } from "../../../components/PlatformLogo";
import type { Platform } from "../../../types/room";

export interface MonitorToolbarProps {
  filter: "全部" | "开播中" | "录制中" | "收藏";
  setFilter: (v: "全部" | "开播中" | "录制中" | "收藏") => void;
  platformFilter: "全部" | Platform;
  setPlatformFilter: (v: "全部" | Platform) => void;
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
