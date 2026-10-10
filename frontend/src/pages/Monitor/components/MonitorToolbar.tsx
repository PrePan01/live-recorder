import {
  Button,
  Input,
  Popover,
  Select,
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
import TagFilterSelect from "../../../components/TagFilterSelect";
import type { Platform } from "../../../types/room";
import type { Tag } from "../../../types/tag";
import {
  MONITOR_SORT_OPTIONS,
  type MonitorSort,
} from "../../../utils/monitorSort";

export interface MonitorToolbarProps {
  sort: MonitorSort;
  setSort: (value: MonitorSort) => void;
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
  sort,
  setSort,
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
  const activeAdvancedFilterCount =
    (platformFilter === "全部" ? 0 : 1) + tagIds.length;

  const advancedFilters = (
    <div className="lr-monitor-advanced-filters">
      <div className="lr-monitor-advanced-filters__section">
        <span className="lr-monitor-advanced-filters__label">平台</span>
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
      </div>
      <div className="lr-monitor-advanced-filters__section">
        <span className="lr-monitor-advanced-filters__label">标签</span>
        <TagFilterSelect
          tags={tags}
          value={tagIds}
          onChange={setTagIds}
          placeholder="选择标签"
          style={{ width: "100%" }}
        />
      </div>
      <div className="lr-monitor-advanced-filters__section">
        <span className="lr-monitor-advanced-filters__label">排序</span>
        <Select
          aria-label="直播间排序"
          value={sort}
          onChange={setSort}
          options={[...MONITOR_SORT_OPTIONS]}
          style={{ width: "100%" }}
        />
      </div>
      {activeAdvancedFilterCount > 0 && (
        <Button
          type="link"
          size="small"
          className="lr-monitor-advanced-filters__clear"
          onClick={() => {
            setPlatformFilter("全部");
            setTagIds([]);
          }}
        >
          清除筛选
        </Button>
      )}
    </div>
  );

  return (
    <div className="lr-page-header lr-monitor-header">
      <Typography.Title level={4} style={{ margin: 0 }}>
        监控总览
      </Typography.Title>
      <div className="lr-monitor-header__controls">
        <div className="lr-monitor-header__state-filter">
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
        </div>
        <div className="lr-monitor-header__tools">
          <Popover
            content={advancedFilters}
            trigger={["hover", "click"]}
            placement="bottomRight"
            overlayClassName="lr-monitor-filter-popover"
          >
            <Button aria-label="更多筛选" className="lr-monitor-filter-trigger">
              筛选与排序
              {activeAdvancedFilterCount > 0
                ? ` ${activeAdvancedFilterCount}`
                : ""}
            </Button>
          </Popover>
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
            className="lr-monitor-header__search"
            allowClear
            placeholder="搜索房间"
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
        </div>
      </div>
    </div>
  );
}
