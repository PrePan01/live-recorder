import { useCallback, useEffect, useMemo, useState } from "react";
import {
  App,
  Button,
  Collapse,
  DatePicker,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from "antd";
import { ExportOutlined, CopyOutlined } from "@ant-design/icons";
import { buildRecordingColumns } from "./components/recordingColumns";
import PlayerModal from "./components/PlayerModal";
import PipelineDrawer from "./components/PipelineDrawer";
import ExportTasksDrawer from "./components/ExportTasksDrawer";
import dayjs from "dayjs";
import { useRecordingStore } from "../../stores/recordingStore";
import { useRoomStore } from "../../stores/roomStore";
import { useResizableColumns } from "../../hooks/useResizableColumns";
import { ApiError } from "../../types/error";
import { describeError } from "../../utils/errorMap";
import { createExport, cancelExport, fetchExports } from "../../api/export";
import { fetchUploads, retryUpload, uploadRecording } from "../../api/openlist";
import { classifyUploadError } from "../../utils/uploadError";
import { useUploadStore } from "../../stores/uploadStore";
import type { ExportJob } from "../../types/export";
import type { Recording } from "../../types/recording";

export default function History() {
  const { message } = App.useApp();
  const {
    items,
    total,
    page,
    pageSize,
    loading,
    fetchHistory,
    openDirectory,
    renameRecording,
    removeRecording,
    batchRemove,
    exportCsv,
  } = useRecordingStore();
  const rooms = useRoomStore((s) => s.rooms);
  const fetchRooms = useRoomStore((s) => s.fetchRooms);
  const upsertUpload = useUploadStore((s) => s.upsert);
  const requestTwoFactorPrompt = useUploadStore(
    (s) => s.requestTwoFactorPrompt,
  );
  const [grouped, setGrouped] = useState(false);
  const [roomId, setRoomId] = useState<string | undefined>();
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs] | null>(
    null,
  );
  const [renaming, setRenaming] = useState<Recording | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [playing, setPlaying] = useState<Recording | null>(null);
  const [pipelineRec, setPipelineRec] = useState<Recording | null>(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportDir, setExportDir] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [exportDrawer, setExportDrawer] = useState(false);
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [, setTick] = useState(0);
  const [uploadErrorDetail, setUploadErrorDetail] = useState<{
    recordingId: string;
    title: string;
    raw: string;
  } | null>(null);

  // 录制中记录时长本地走时：每秒重渲染一次，不再依赖后端每秒 SSE（QA 性能建议③）。
  useEffect(() => {
    const hasRecording = items.some(
      (r) => r.state === "recording" || r.state === "reconnecting",
    );
    if (!hasRecording) return;
    const timer = setInterval(() => {
      // 后台不刷相对时间（表格无人观看）；回前台下一次心跳即更新。
      if (document.visibilityState !== "visible") return;
      setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [items]);

  useEffect(() => {
    // 显式传全量筛选（roomId/dateFrom/dateTo 用 undefined 表示清除），
    // 覆盖 store 合并的旧 query，避免清除筛选后残留上次筛选参数。
    const q: {
      page: number;
      roomId?: string;
      dateFrom?: string;
      dateTo?: string;
    } = {
      page: 1,
      roomId,
      dateFrom: dateRange
        ? dateRange[0].startOf("day").toISOString()
        : undefined,
      dateTo: dateRange ? dateRange[1].endOf("day").toISOString() : undefined,
    };
    void fetchHistory(q).catch(() =>
      message.error("历史列表加载失败，请稍后重试"),
    );
    if (rooms.length === 0) void fetchRooms();
  }, [fetchHistory, roomId, dateRange]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const focusId = params.get("focus");
    if (!focusId || items.length === 0) return;
    const el = document.querySelector(
      `[data-rec-id="${focusId}"]`,
    ) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.style.transition = "background 1s ease";
      el.style.background = "var(--lr-hover-bg)";
      setTimeout(() => {
        el.style.background = "";
      }, 2000);
    }
    window.history.replaceState({}, "", "/history");
  }, [items]);

  const roomName = useMemo(
    () => new Map(rooms.map((r) => [r.id, r.displayName])),
    [rooms],
  );
  const roomLabel = useCallback(
    (r: Recording) => r.roomName || roomName.get(r.roomId) || r.roomId,
    [roomName],
  );

  const handleBatchDelete = async () => {
    setBatchBusy(true);
    try {
      const res = await batchRemove(selectedKeys.map(String));
      setSelectedKeys([]);
      message.success(
        `已删除 ${res.deleted.length} 条${res.failed.length > 0 ? `，失败 ${res.failed.length} 条` : ""}`,
      );
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "批量删除失败",
      );
    } finally {
      setBatchBusy(false);
    }
  };

  const handleExport = async () => {
    if (selectedKeys.length === 0) {
      message.warning("请先选择要导出的录制");
      return;
    }
    if (!exportDir.trim()) {
      message.warning("请输入导出目录");
      return;
    }
    setExportBusy(true);
    try {
      await createExport(selectedKeys.map(String), exportDir.trim());
      message.success("导出任务已创建");
      setExportModalOpen(false);
      setExportDrawer(true);
      void refreshExports();
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "导出失败",
      );
    } finally {
      setExportBusy(false);
    }
  };

  const refreshExports = async () => {
    try {
      setExportJobs(await fetchExports());
    } catch {
      /* 忽略 */
    }
  };

  // #13 OpenList 2FA：上传任务失败且标记「需要 2FA 验证」时弹窗收集一次性码。
  const retryUploadFor = useCallback(
    async (recordingId: string) => {
      try {
        const jobs = await fetchUploads(50);
        const job = jobs.find((j) => j.recordingId === recordingId);
        if (!job) {
          message.warning("未找到该录制的上传任务");
          return;
        }
        const retried = await retryUpload(job.id);
        // Retry may return an immediate 2FA-required failure. Update the
        // root-owned upload store directly so its global OTP modal never
        // depends on an asynchronous SSE delivery race.
        upsertUpload(retried);
        if ((retried.error ?? "").includes("OpenList 需要 2FA 验证")) {
          requestTwoFactorPrompt();
          message.info("需要完成 2FA 验证后才能继续上传");
        } else {
          message.success("已触发重试");
        }
      } catch (e) {
        message.error(
          e instanceof ApiError ? describeError(e.code, e.message) : "重试失败",
        );
      }
    },
    [message, requestTwoFactorPrompt, upsertUpload],
  );

  // #18②：手动上传未自动上传的录制（无上传任务时 History 提供「上传」按钮）。
  const handleManualUpload = useCallback(
    async (recordingId: string) => {
      try {
        await uploadRecording(recordingId);
        message.success("已触发上传");
        void fetchHistory().catch(() =>
          message.error("历史列表刷新失败，请稍后重试"),
        );
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : "上传失败";
        message.error(msg);
        // #18 反馈②：手动上传失败（如源文件已删除）→ 本地更新单元格状态，不再停留在「上传」按钮。
        if (msg.includes("源文件已删除")) {
          useRecordingStore.getState().patchRecordingUpload(recordingId, {
            status: "failed",
            progress: 0,
            remotePath: null,
            error: msg,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    },
    [message, fetchHistory],
  );

  // #19：查看失败任务错误详情（错误码 + 可执行建议 + 原始错误全文）。
  const handleUploadErrorDetail = useCallback((recording: Recording) => {
    const raw = recording.upload?.error ?? "未知错误";
    setUploadErrorDetail({
      recordingId: recording.id,
      title: recording.streamTitle || recording.id,
      raw,
    });
  }, []);

  const handleCopyErrorDetail = useCallback(async () => {
    if (!uploadErrorDetail) return;
    try {
      await navigator.clipboard.writeText(uploadErrorDetail.raw);
      message.success("错误详情已复制");
    } catch {
      message.error("复制失败，请手动复制");
    }
  }, [uploadErrorDetail, message]);

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const csv = await exportCsv();
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `recordings-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      message.success("CSV 已导出");
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "导出失败",
      );
    } finally {
      setExporting(false);
    }
  };

  const columns = useMemo(
    () =>
      buildRecordingColumns({
        roomLabel,
        openDirectory,
        removeRecording,
        message,
        handleManualUpload,
        handleUploadErrorDetail,
        setRenaming,
        setRenameValue,
        setPlaying,
        setPipelineRec,
        retryUploadFor,
      }),
    [
      roomLabel,
      openDirectory,
      removeRecording,
      message,
      handleManualUpload,
      handleUploadErrorDetail,
    ],
  );

  const groups = useMemo(() => {
    const map = new Map<string, Recording[]>();
    items.forEach((r) => {
      const key = r.streamSessionId ?? r.id;
      map.set(key, [...(map.get(key) ?? []), r]);
    });
    return [...map.entries()].map(([sessionId, recs]) => ({ sessionId, recs }));
  }, [items]);

  const { columns: resizedColumns, components: resizableComponents } =
    useResizableColumns<Recording>(columns);

  return (
    <div className="lr-page lr-history-page">
      <Space className="lr-page-header" wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          录制历史
        </Typography.Title>
        <Space>
          <Typography.Text type="secondary">按场次分组</Typography.Text>
          <Switch aria-label="按场次分组" checked={grouped} onChange={setGrouped} />
        </Space>
      </Space>
      <Space className="lr-filter-bar" wrap>
        <Select
          allowClear
          aria-label="按房间筛选"
          placeholder="按房间筛选"
          style={{ width: 200 }}
          value={roomId}
          onChange={setRoomId}
          options={rooms.map((r) => ({ value: r.id, label: r.displayName }))}
        />
        <DatePicker.RangePicker
          aria-label="录制日期范围"
          value={dateRange}
          onChange={(v) => setDateRange(v as [dayjs.Dayjs, dayjs.Dayjs] | null)}
        />
        <Button loading={exporting} onClick={() => void handleExportCsv()}>
          导出 CSV
        </Button>
        <Button
          icon={<ExportOutlined />}
          disabled={batchBusy || selectedKeys.length === 0}
          onClick={() => setExportModalOpen(true)}
        >
          备份导出{selectedKeys.length > 0 ? ` (${selectedKeys.length})` : ""}
        </Button>
        <Popconfirm
          title={`确定删除所选 ${selectedKeys.length} 条录制？将连带删除文件且不可恢复。`}
          onConfirm={() => void handleBatchDelete()}
          disabled={selectedKeys.length === 0}
        >
          <Button danger disabled={batchBusy || selectedKeys.length === 0}>
            批量删除
            {selectedKeys.length > 0 ? ` (${selectedKeys.length})` : ""}
          </Button>
        </Popconfirm>
      </Space>
      {grouped ? (
        <Collapse
          items={groups.map(({ sessionId, recs }) => ({
            key: sessionId,
            label: (
              <Space>
                <Typography.Text strong>
                  {recs[0].streamTitle || "未命名场次"}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {dayjs(recs[0].startedAt).format("MM-DD HH:mm")} ·{" "}
                  {recs.length} 段 · {roomLabel(recs[0])}
                </Typography.Text>
              </Space>
            ),
            children: (
              <Table
                rowKey="id"
                size="small"
                columns={resizedColumns}
                components={resizableComponents}
                dataSource={recs}
                pagination={false}
                sticky={{ offsetScroll: 8 }}
                scroll={{ x: 1400 }}
              />
            ),
          }))}
        />
      ) : (
        <Table
          rowKey="id"
          columns={resizedColumns}
          components={resizableComponents}
          dataSource={items}
          loading={loading}
          sticky={{ offsetScroll: 8 }}
          onRow={(r) =>
            ({ "data-rec-id": r.id }) as React.HTMLAttributes<HTMLElement>
          }
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: setSelectedKeys,
          }}
          scroll={{ x: 1400 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            onChange: (p, ps) =>
              void fetchHistory({ page: p, pageSize: ps, roomId }).catch(
                () => message.error("历史列表加载失败，请稍后重试"),
              ),
          }}
        />
      )}
      <PlayerModal playing={playing} onClose={() => setPlaying(null)} />
      <PipelineDrawer
        pipelineRec={pipelineRec}
        onClose={() => setPipelineRec(null)}
      />
      <Modal
        title="重命名录制"
        open={renaming !== null}
        onCancel={() => setRenaming(null)}
        onOk={() => {
          if (!renaming) return;
          setRenameBusy(true);
          void renameRecording(renaming.id, renameValue)
            .then(() => {
              message.success("已重命名");
              setRenaming(null);
            })
            .catch((e) =>
              message.error(
                e instanceof ApiError
                  ? describeError(e.code, e.message)
                  : "重命名失败",
              ),
            )
            .finally(() => setRenameBusy(false));
        }}
        confirmLoading={renameBusy}
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            重命名会同步修改录制文件名。
          </Typography.Text>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="新标题"
          />
        </Space>
      </Modal>
      <Modal
        title={`备份导出（${selectedKeys.length} 条）`}
        open={exportModalOpen}
        onCancel={() => setExportModalOpen(false)}
        onOk={() => void handleExport()}
        confirmLoading={exportBusy}
        okText="开始导出"
        destroyOnHidden
      >
        <Space orientation="vertical" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            打包为目录（源文件+封面+manifest.json，不含密钥）；缺失附件标部分成功，不损坏源文件。
          </Typography.Text>
          <Input
            placeholder="导出目录（如 /Users/name/Exports）"
            value={exportDir}
            onChange={(e) => setExportDir(e.target.value)}
          />
        </Space>
      </Modal>
      <ExportTasksDrawer
        open={exportDrawer}
        onClose={() => setExportDrawer(false)}
        jobs={exportJobs}
        onRefresh={() => void refreshExports()}
        onCancelJob={(id) =>
          void cancelExport(id)
            .then(() => void refreshExports())
            .catch((e) => message.error(describeError(e.code, e.message)))
        }
      />
      {/* #19：上传失败错误详情——分级展示（可执行建议 + 错误码 + 原始错误全文）+ 复制。 */}
      <Modal
        title={`上传错误详情${uploadErrorDetail ? `：${uploadErrorDetail.title}` : ""}`}
        open={uploadErrorDetail !== null}
        onCancel={() => setUploadErrorDetail(null)}
        footer={[
          <Button
            key="copy"
            icon={<CopyOutlined />}
            onClick={() => void handleCopyErrorDetail()}
          >
            复制错误详情
          </Button>,
          <Button
            key="close"
            type="primary"
            onClick={() => setUploadErrorDetail(null)}
          >
            关闭
          </Button>,
        ]}
        destroyOnHidden
      >
        {uploadErrorDetail ? (
          <Space orientation="vertical" style={{ width: "100%" }} size={12}>
            <div>
              <Typography.Text
                type="secondary"
                style={{ display: "block", fontSize: 12 }}
              >
                错误码
              </Typography.Text>
              <Tag color="red">
                {classifyUploadError(uploadErrorDetail.raw).code}
              </Tag>
            </div>
            <div>
              <Typography.Text
                type="secondary"
                style={{ display: "block", fontSize: 12 }}
              >
                处理建议
              </Typography.Text>
              <Typography.Text>
                {classifyUploadError(uploadErrorDetail.raw).action}
              </Typography.Text>
            </div>
            <div>
              <Typography.Text
                type="secondary"
                style={{ display: "block", fontSize: 12 }}
              >
                详细原因（原始错误）
              </Typography.Text>
              <Typography.Paragraph
                style={{ margin: 0 }}
                copyable={{ text: uploadErrorDetail.raw }}
              >
                <Typography.Text type="danger">
                  {uploadErrorDetail.raw}
                </Typography.Text>
              </Typography.Paragraph>
            </div>
          </Space>
        ) : null}
      </Modal>
    </div>
  );
}
