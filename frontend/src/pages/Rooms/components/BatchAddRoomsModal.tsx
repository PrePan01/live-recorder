import { useState } from "react";
import { Alert, App, Input, List, Modal, Typography } from "antd";
import { useRoomStore } from "../../../stores/roomStore";
import { ApiError } from "../../../types/error";
import { describeError } from "../../../utils/error/errorMap";
import { promptDouyinAuthorization } from "../utils/douyinAuthorization";

interface BatchAddRoomsModalProps {
  open: boolean;
  onClose: () => void;
}

export default function BatchAddRoomsModal({
  open,
  onClose,
}: BatchAddRoomsModalProps) {
  const { message } = App.useApp();
  const batchAddRooms = useRoomStore((state) => state.batchAddRooms);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [batchResult, setBatchResult] = useState<Awaited<
    ReturnType<typeof batchAddRooms>
  > | null>(null);

  const submitBatch = async () => {
    const urls = batchText
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (urls.length === 0) {
      message.warning("请粘贴至少一行直播链接");
      return;
    }
    setBatchBusy(true);
    setBatchResult(null);
    try {
      const res = await batchAddRooms(urls);
      setBatchResult(res);
      message.success(
        `成功 ${res.succeeded.length} 条，失败 ${res.failed.length} 条`,
      );
      if (res.succeeded.some((r) => r.platform === "douyin"))
        void promptDouyinAuthorization(message);
    } catch (e) {
      message.error(
        e instanceof ApiError
          ? describeError(e.code, e.message)
          : "批量添加失败",
      );
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <Modal
      title="批量添加直播间"
      open={open}
      onCancel={() => {
        onClose();
        setBatchResult(null);
        setBatchText("");
      }}
      onOk={() => void submitBatch()}
      confirmLoading={batchBusy}
      okText="批量添加"
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        每行一个直播链接，支持 B站 / 抖音 / 小红书 / YouTube 混排，最多 100
        条。自动去重（含已存在直播间与批内重复）。
      </Typography.Paragraph>
      <Input.TextArea
        rows={6}
        placeholder={
          "https://live.bilibili.com/...\nhttps://live.douyin.com/...\nhttps://www.xiaohongshu.com/livestream/...\nhttps://www.youtube.com/@频道名\nhttps://www.youtube.com/watch?v=视频ID"
        }
        value={batchText}
        onChange={(e) => setBatchText(e.target.value)}
      />
      {batchResult ? (
        <div style={{ marginTop: 12 }}>
          {batchResult.failed.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`失败 ${batchResult.failed.length} 条`}
              description={
                <List
                  size="small"
                  dataSource={batchResult.failed}
                  renderItem={(f) => (
                    <List.Item>
                      <Typography.Text
                        type="secondary"
                        ellipsis
                        style={{ maxWidth: 260 }}
                      >
                        {f.url}
                      </Typography.Text>
                      <Typography.Text type="danger">
                        {f.reason}
                      </Typography.Text>
                    </List.Item>
                  )}
                />
              }
            />
          ) : (
            <Alert
              type="success"
              showIcon
              message={`全部成功（${batchResult.succeeded.length} 条）`}
            />
          )}
        </div>
      ) : null}
    </Modal>
  );
}
