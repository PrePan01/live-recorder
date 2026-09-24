// 拆分（task #62）：导出任务抽屉——自 index.tsx 原样迁移；取消/刷新经 props 回调（逻辑留 index）。
import { Button, Drawer, Popconfirm, Progress, Space, Tag, Typography } from "antd";
import { formatTime } from "../../../utils/format";
import { EXPORT_STATUS_COLOR } from "./historyUtils";
import type { ExportJob } from "../../../types/export";

export default function ExportTasksDrawer({
  open,
  onClose,
  jobs,
  onRefresh,
  onCancelJob,
}: {
  open: boolean;
  onClose: () => void;
  jobs: ExportJob[];
  onRefresh: () => void;
  onCancelJob: (id: string) => void;
}) {
  return (
      <Drawer
        title="导出任务"
        open={open}
        size={460}
        onClose={onClose}
      >
        <Space orientation="vertical" style={{ width: "100%" }} size={12}>
          <Button size="small" onClick={onRefresh}>
            刷新
          </Button>
          {jobs.length === 0 ? (
            <Typography.Text type="secondary">暂无导出任务</Typography.Text>
          ) : (
            jobs.slice(0, 10).map((j) => (
              <div key={j.id}>
                <Space size={8} wrap>
                  <Tag color={EXPORT_STATUS_COLOR[j.status]}>{j.status}</Tag>
                  {j.status === "running" ? (
                    <Progress
                      percent={j.progress}
                      size="small"
                      style={{ width: 120 }}
                    />
                  ) : null}
                  {j.outputPath ? (
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12 }}
                      ellipsis
                    >
                      {j.outputPath}
                    </Typography.Text>
                  ) : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {formatTime(j.updatedAt)}
                  </Typography.Text>
                  {j.status === "queued" || j.status === "running" ? (
                    <Popconfirm
                      title="取消导出？已生成内容保留"
                      onConfirm={() => onCancelJob(j.id)}
                    >
                      <Button size="small" danger>
                        取消
                      </Button>
                    </Popconfirm>
                  ) : null}
                </Space>
                {j.error ? (
                  <Typography.Text
                    type="danger"
                    style={{ display: "block", fontSize: 12 }}
                  >
                    {j.error}
                  </Typography.Text>
                ) : null}
              </div>
            ))
          )}
        </Space>
      </Drawer>

  );
}
