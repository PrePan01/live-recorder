import { useEffect, useMemo, useRef, useState } from "react";
import {
  App,
  Button,
  Collapse,
  Popconfirm,
  Progress,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  cancelClipQueueItem,
  cancelPendingClipQueue,
  listClipQueue,
  retryClipQueueItem,
} from "../api/clipQueue";
import { openRecordingDirectory, playRecording } from "../api/recordings";
import { useClipQueueStore } from "../stores/clipQueueStore";
import { useRecordingStore } from "../stores/recordingStore";
import type { ClipQueueItem, ClipQueueState } from "../types/clipQueue";
import { encoderLabel } from "../utils/encoderText";
import { playbackClock } from "../utils/playbackClock";
const labels: Record<ClipQueueState, string> = {
  queued: "等待导出",
  running: "导出中",
  cancelling: "正在取消",
  done: "成功",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "中断待重试",
};
const unfinished = (item: ClipQueueItem) =>
  ["queued", "running", "cancelling"].includes(item.state);
function TaskRow({
  item,
  run,
}: {
  item: ClipQueueItem;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const snapshot = useRecordingStore((s) =>
    item.outputRecordingId
      ? s.recordingSnapshots[item.outputRecordingId]
      : undefined,
  );
  return (
    <div className="lr-clip-task-row">
      <Space size={6} wrap>
        <Tag
          color={
            item.state === "failed"
              ? "error"
              : item.state === "done"
                ? "success"
                : undefined
          }
        >
          {labels[item.state]}
        </Tag>
        <Typography.Text>{item.fileName}</Typography.Text>
        <Typography.Text type="secondary">
          {playbackClock(item.startSecond)}—{playbackClock(item.endSecond)}
        </Typography.Text>
      </Space>
      {item.state === "running" && snapshot?.progressPercent != null ? (
        <Progress size="small" percent={snapshot.progressPercent} />
      ) : null}
      {item.error ? <div role="status">{item.error}</div> : null}
      <Space size={4} wrap>
        {["queued", "running"].includes(item.state) ? (
          <Button
            size="small"
            onClick={() => void run(() => cancelClipQueueItem(item.id))}
          >
            取消
          </Button>
        ) : null}
        {["failed", "cancelled", "interrupted"].includes(item.state) ? (
          <Button
            size="small"
            onClick={() => void run(() => retryClipQueueItem(item.id))}
          >
            重试
          </Button>
        ) : null}
        {item.state === "done" && item.outputRecordingId ? (
          <>
            <Button
              size="small"
              onClick={() =>
                void run(() => playRecording(item.outputRecordingId!))
              }
            >
              播放文件
            </Button>
            <Button
              size="small"
              onClick={() =>
                void run(() => openRecordingDirectory(item.outputRecordingId!))
              }
            >
              打开所在目录
            </Button>
          </>
        ) : null}
      </Space>
      {item.actualEncoder ||
      item.fallbackReason ||
      snapshot?.pipelineStatus === "running" ||
      snapshot?.pipelineStatus === "queued" ? (
        <details>
          <summary>详情</summary>
          {item.actualEncoder ? (
            <div>编码方式：{encoderLabel(item.actualEncoder)}</div>
          ) : null}
          {item.fallbackReason ? <div>{item.fallbackReason}</div> : null}
          {snapshot?.pipelineStatus ? (
            <div>后处理：{snapshot.pipelineStatus}</div>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
export function ClipExportTasks() {
  const { message } = App.useApp();
  const version = useClipQueueStore((s) => s.version);
  const [items, setItems] = useState<ClipQueueItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    const generation = ++epoch.current;
    let disposed = false;
    const timer = setTimeout(() => {
      void listClipQueue(undefined, page)
        .then((data) => {
          if (!disposed && generation === epoch.current) {
            setItems(data.items);
            setHasMore(data.hasMore);
          }
        })
        .catch(() => {
          if (!disposed) message.error("导出任务加载失败");
        });
    }, 80);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [version, message, page]);
  const groups = useMemo(() => {
    const map = new Map<string, ClipQueueItem[]>();
    for (const item of items) {
      const group = map.get(item.batchId) ?? [];
      group.push(item);
      map.set(item.batchId, group);
    }
    return [...map.entries()].reverse();
  }, [items]);
  const run = async (action: () => Promise<void>) => {
    try {
      await action();
      useClipQueueStore.getState().touch();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    }
  };
  if (!items.length && page === 1) return null;
  return (
    <div className="lr-clip-tasks">
      <Collapse
        size="small"
        items={groups.map(([batchId, rows]) => {
          const settled = rows.filter((item) => !unfinished(item)).length;
          return {
            key: batchId,
            label: `${rows[0].recordingTitle || rows[0].recordingId} · ${new Date(rows[0].createdAt).toLocaleString()} · ${settled}/${rows.length} 段`,
            children: (
              <>
                <div>
                  成功 {rows.filter((i) => i.state === "done").length} ·
                  失败/中断{" "}
                  {
                    rows.filter((i) =>
                      ["failed", "interrupted"].includes(i.state),
                    ).length
                  }{" "}
                  · 取消 {rows.filter((i) => i.state === "cancelled").length}
                </div>
                <Progress
                  size="small"
                  percent={Math.round((settled / rows.length) * 100)}
                />
                <Space wrap>
                  <Popconfirm
                    title="取消本批未完成项？成功文件不受影响。"
                    onConfirm={() => run(() => cancelPendingClipQueue(batchId))}
                  >
                    <Button size="small" disabled={!rows.some(unfinished)}>
                      取消未完成
                    </Button>
                  </Popconfirm>
                  <Button
                    size="small"
                    disabled={
                      !rows.some((i) =>
                        ["failed", "interrupted"].includes(i.state),
                      )
                    }
                    onClick={() =>
                      void run(async () => {
                        for (const item of rows)
                          if (["failed", "interrupted"].includes(item.state))
                            await retryClipQueueItem(item.id);
                      })
                    }
                  >
                    重试失败项
                  </Button>
                </Space>
                <div className="lr-clip-task-list">
                  {rows.map((item) => (
                    <TaskRow key={item.id} item={item} run={run} />
                  ))}
                </div>
              </>
            ),
          };
        })}
      />
      <Space>
        <Button
          size="small"
          disabled={page === 1}
          onClick={() => setPage((n) => n - 1)}
        >
          较新批次
        </Button>
        <Button
          size="small"
          disabled={!hasMore}
          onClick={() => setPage((n) => n + 1)}
        >
          较早批次
        </Button>
        <Button
          size="small"
          onClick={() => useClipQueueStore.getState().touch()}
        >
          刷新
        </Button>
      </Space>
    </div>
  );
}
