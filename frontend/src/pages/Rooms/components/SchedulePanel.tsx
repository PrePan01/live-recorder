import { Form, Select, TimePicker, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs, { type Dayjs } from "dayjs";
import {
  createSchedule,
  deleteSchedule,
  fetchSchedules,
  updateSchedule,
} from "../../../api/schedule";
import { formatTime } from "../../../utils/format";
import type { RecordingSchedule, ScheduleInput } from "../../../types/schedule";
import PlanPanel from "./PlanPanel";

const DAYS = [
  { value: 0, label: "周日" },
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
];

interface Values {
  daysOfWeek: ScheduleInput["daysOfWeek"];
  startTime?: Dayjs;
  endTime: Dayjs | null;
  enabled: boolean;
}

const columns: ColumnsType<RecordingSchedule> = [
  {
    title: "周期",
    dataIndex: "daysOfWeek",
    width: 160,
    render: (days: number[]) =>
      days.map((d) => DAYS.find((x) => x.value === d)?.label).join("、"),
  },
  { title: "开始", dataIndex: "startTime", width: 80 },
  {
    title: "结束",
    dataIndex: "endTime",
    width: 80,
    render: (value: string | null) => value ?? "无",
  },
  {
    title: "下次执行",
    dataIndex: "nextRunAt",
    width: 150,
    render: (value: string | null) => (value ? formatTime(value) : "-"),
  },
];

function initialValues(plan: RecordingSchedule | null): Values {
  return {
    daysOfWeek: plan?.daysOfWeek ?? [1],
    startTime: plan ? dayjs(`2000-01-01T${plan.startTime}`) : undefined,
    endTime: plan?.endTime ? dayjs(`2000-01-01T${plan.endTime}`) : null,
    enabled: plan?.enabled ?? true,
  };
}

async function save(
  roomId: string,
  plan: RecordingSchedule | null,
  values: Values,
) {
  if (!values.startTime) throw new Error("缺少开始时间");
  const input: ScheduleInput = {
    daysOfWeek: values.daysOfWeek,
    startTime: values.startTime.format("HH:mm"),
    endTime: values.endTime?.format("HH:mm") ?? null,
    enabled: values.enabled,
  };
  return plan
    ? updateSchedule(roomId, plan.id, input)
    : createSchedule(roomId, input);
}

export default function SchedulePanel({
  roomId,
  onCountChange,
}: {
  roomId: string;
  onCountChange: (count: number) => void;
}) {
  return (
    <PlanPanel
      roomId={roomId}
      label="定时计划"
      columns={columns}
      scrollWidth={670}
      load={fetchSchedules}
      onCountChange={onCountChange}
      remove={deleteSchedule}
      save={save}
      initialValues={initialValues}
      toggle={(id, plan, enabled) =>
        updateSchedule(id, plan.id, {
          daysOfWeek: plan.daysOfWeek,
          startTime: plan.startTime,
          endTime: plan.endTime,
          enabled,
        })
      }
      fields={
        <>
          <Form.Item
            label="每周重复"
            name="daysOfWeek"
            rules={[{ required: true, message: "至少选一天" }]}
          >
            <Select mode="multiple" options={DAYS} placeholder="选择星期" />
          </Form.Item>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
              gap: 12,
              alignItems: "start",
            }}
          >
            <Form.Item
              label="开始时间"
              name="startTime"
              rules={[{ required: true, message: "必填" }]}
            >
              <TimePicker
                aria-label="开始时间"
                format="HH:mm"
                style={{ width: "100%" }}
              />
            </Form.Item>
            <Form.Item label="结束时间（可选）" name="endTime">
              <TimePicker
                aria-label="结束时间（可选）"
                format="HH:mm"
                style={{ width: "100%" }}
              />
            </Form.Item>
          </div>
          <Typography.Paragraph type="secondary">
            按本机时间执行；结束早于开始视为跨天
          </Typography.Paragraph>
        </>
      }
    />
  );
}
