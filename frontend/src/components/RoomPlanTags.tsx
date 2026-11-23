import { Tag } from "antd";
import type { Room } from "../types/room";

export function renderRoomPlanTags(enabledPlans: Room["enabledPlans"]) {
  return [
    enabledPlans?.schedule && (
      <Tag key="schedule" color="gold" style={{ marginInlineEnd: 0 }}>
        定时计划
      </Tag>
    ),
    enabledPlans?.keyword && (
      <Tag key="keyword" color="cyan" style={{ marginInlineEnd: 0 }}>
        关键词计划
      </Tag>
    ),
  ];
}
