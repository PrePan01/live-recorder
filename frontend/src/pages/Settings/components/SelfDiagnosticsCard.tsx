import { Card, Button, List, Space, Tag, Typography } from "antd";
import { CheckCircleOutlined, SyncOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import {
  fetchPerformanceDiagnostics,
  type PerformanceDiagnostic,
} from "../../../api/diagnostics";
import { formatTime } from "../../../utils/format";
import type { SelfCheckItem, SelfCheckStatus } from "../../../api/service";
import type { Room } from "../../../types/room";

const CHECK_COLOR: Record<SelfCheckStatus, string> = {
  ok: "success",
  fail: "error",
  warn: "warning",
  pending: "default",
};
const CHECK_TEXT: Record<SelfCheckStatus, string> = {
  ok: "正常",
  fail: "异常",
  warn: "警告",
  pending: "检测中",
};
const PERFORMANCE_DIAGNOSTICS_ENABLED = import.meta.env.DEV;
const PERFORMANCE_STAGE_LABEL: Record<string, string> = {
  requested: "已请求",
  highlight_buffer_stopped: "精彩时刻缓存已停用",
  storage_checks_ready: "存储检查完成",
  platform_cookie_ready: "平台授权已读取",
  stream_url_ready: "流地址已获取",
  ready: "已收到首段直播数据",
  failed: "启动失败",
  skipped: "未执行",
};

export interface SelfDiagnosticsCardProps {
  checks: SelfCheckItem[] | null;
  checking: boolean;
  runSelfCheck: () => Promise<void>;
  rooms: Room[];
}

/** 一键自检 + 性能诊断卡：原 Settings/index 内联两卡整块迁移（checks 状态仍在页面共享给 ffmpeg 守卫）。 */
export default function SelfDiagnosticsCard(props: SelfDiagnosticsCardProps) {
  const { checks, checking, runSelfCheck, rooms } = props;
  const [performanceDiagnostics, setPerformanceDiagnostics] = useState<
    PerformanceDiagnostic[]
  >([]);
  const [loadingPerformanceDiagnostics, setLoadingPerformanceDiagnostics] =
    useState(false);
  const loadPerformanceDiagnostics = async () => {
    setLoadingPerformanceDiagnostics(true);
    try {
      setPerformanceDiagnostics(await fetchPerformanceDiagnostics());
    } catch {
      // 性能诊断不可用不影响设置页其它功能。
    } finally {
      setLoadingPerformanceDiagnostics(false);
    }
  };

  useEffect(() => {
    if (PERFORMANCE_DIAGNOSTICS_ENABLED) void loadPerformanceDiagnostics();
  }, []);
  return (
    <>
      <Card
        className="lr-settings-card lr-self-check-card"
        title="一键自检"
        extra={
          <Button
            size="small"
            icon={<SyncOutlined />}
            loading={checking}
            onClick={() => void runSelfCheck()}
          >
            {checks ? "重新检测" : "开始检测"}
          </Button>
        }
      >
        {checks === null ? (
          <Typography.Paragraph type="secondary">
            点击检测，检测功能是否正常
          </Typography.Paragraph>
        ) : (
          <List
            size="small"
            dataSource={checks}
            locale={{ emptyText: "无检测项" }}
            renderItem={(c) => (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Space>
                      {c.status === "ok" ? (
                        <CheckCircleOutlined style={{ color: "#52c41a" }} />
                      ) : (
                        <Tag color={CHECK_COLOR[c.status]}>
                          {CHECK_TEXT[c.status]}
                        </Tag>
                      )}
                      <Typography.Text strong>{c.label}</Typography.Text>
                    </Space>
                  }
                  description={
                    <>
                      {c.detail ? (
                        <Typography.Text type="secondary">
                          {c.detail}
                        </Typography.Text>
                      ) : null}
                      {c.fixHint ? (
                        <Typography.Text
                          type="warning"
                          style={{ display: "block" }}
                        >
                          修复：{c.fixHint}
                        </Typography.Text>
                      ) : null}
                    </>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>
      {PERFORMANCE_DIAGNOSTICS_ENABLED && (
        <Card
          className="lr-settings-card"
          title="性能诊断"
          extra={
            <Button
              size="small"
              loading={loadingPerformanceDiagnostics}
              onClick={() => void loadPerformanceDiagnostics()}
            >
              刷新
            </Button>
          }
        >
          <Typography.Paragraph type="secondary">
            显示本次服务运行期间最近 100
            次录制或预览启动的服务端耗时；完整记录也会随诊断日志导出。
          </Typography.Paragraph>
          <List
            size="small"
            dataSource={performanceDiagnostics.slice(0, 20)}
            locale={{ emptyText: "尚无录制或预览启动记录" }}
            renderItem={(item) => {
              const room = rooms.find(
                (candidate) => candidate.id === item.roomId,
              );
              const kind =
                item.kind === "recording_start" ? "录制启动" : "预览启动";
              const outcome =
                item.outcome === "ok"
                  ? "完成"
                  : item.outcome === "running"
                    ? "进行中"
                    : item.outcome === "skipped"
                      ? "跳过"
                      : "失败";
              return (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space wrap>
                        <Typography.Text strong>{kind}</Typography.Text>
                        <Tag>
                          {item.platform === "bilibili" ? "B站" : "抖音"}
                        </Tag>
                        <Tag
                          color={
                            item.outcome === "ok"
                              ? "success"
                              : item.outcome === "failed"
                                ? "error"
                                : "default"
                          }
                        >
                          {outcome}
                        </Tag>
                        <Typography.Text type="secondary">
                          {item.elapsedMs} ms
                        </Typography.Text>
                      </Space>
                    }
                    description={
                      <>
                        <Typography.Text type="secondary">
                          {room?.displayName ?? "已删除的直播间"} ·{" "}
                          {formatTime(item.startedAt)}
                          {item.errorCode ? ` · ${item.errorCode}` : ""}
                        </Typography.Text>
                        <Typography.Text
                          type="secondary"
                          style={{ display: "block" }}
                        >
                          {item.stages
                            .map(
                              (stage) =>
                                `${PERFORMANCE_STAGE_LABEL[stage.name] ?? stage.name} ${stage.elapsedMs} ms`,
                            )
                            .join(" · ")}
                        </Typography.Text>
                      </>
                    }
                  />
                </List.Item>
              );
            }}
          />
        </Card>
      )}
    </>
  );
}
