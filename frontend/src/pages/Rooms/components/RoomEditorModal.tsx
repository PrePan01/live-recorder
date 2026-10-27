import { useCallback, useEffect, useRef, useState } from "react";
import { App, Button, Form, Input, Modal, Spin, Typography } from "antd";
import { SnippetsOutlined } from "@ant-design/icons";
import { useRoomStore } from "../../../stores/roomStore";
import type { Room } from "../../../types/room";
import { ApiError } from "../../../types/error";
import { describeError } from "../../../utils/error/errorMap";
import { guessPlatform, PLATFORM_LABEL } from "../../../utils/room/roomPlatform";
import { promptDouyinAuthorization } from "../utils/douyinAuthorization";
import TagSelect from "./TagSelect";

// Form.Item supplies the controlled props after mounting the field.
function RoomTagField({
  value = [],
  onChange,
}: {
  value?: string[];
  onChange?: (value: string[]) => void;
}) {
  return <TagSelect value={value} onChange={(next) => onChange?.(next)} />;
}

interface RoomEditorModalProps {
  open: boolean;
  room: Room | null;
  onClose: () => void;
}

export default function RoomEditorModal({
  open,
  room: editing,
  onClose,
}: RoomEditorModalProps) {
  const { message } = App.useApp();
  const { addRoom, editRoom, updateRoomTags, checkRoomNow } = useRoomStore();
  const [submitting, setSubmitting] = useState(false);
  // 慢路径（解析耗时秒级）才出等待说明；快路径（缓存命中约 1.5s）不允许闪现，故阈值取 2s。
  const [submitHint, setSubmitHint] = useState(false);
  const submitHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSubmitHintTimer = useCallback(() => {
    if (submitHintTimer.current !== null) {
      clearTimeout(submitHintTimer.current);
      submitHintTimer.current = null;
    }
  }, []);
  useEffect(() => () => clearSubmitHintTimer(), [clearSubmitHintTimer]);
  const [form] = Form.useForm<{
    url: string;
    displayName?: string;
    tagIds: string[];
  }>();

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) {
      form.setFieldsValue({ url: editing.url, displayName: editing.displayName });
    }
    form.setFieldValue("tagIds", editing?.tags.map((tag) => tag.id) ?? []);
  }, [open, editing, form]);

  const submit = async () => {
    let fields: { url: string; displayName?: string; tagIds: string[] };
    try {
      fields = await form.validateFields();
    } catch {
      return;
    }
    const { tagIds, ...values } = fields;
    const platform = guessPlatform(values.url);
    if (!platform) {
      message.error("支持 B站、抖音、小红书、YouTube 直播链接");
      return;
    }
    setSubmitting(true);
    if (!editing) {
      clearSubmitHintTimer();
      submitHintTimer.current = setTimeout(() => setSubmitHint(true), 2000);
    }
    try {
      if (editing) {
        await editRoom(editing.id, values);
        if (tagIds.length > 0 || editing.tags.length > 0) {
          await updateRoomTags(editing.id, tagIds);
        }
        message.success("直播间已更新");
      } else {
        const room = await addRoom({ ...values, platform });
        if (tagIds.length > 0) {
          await updateRoomTags(room.id, tagIds);
        }
        message.success("直播间已添加");
        // 添加后立即检测，让显示名/直播状态即时解析（不必等调度器最长 120s）。
        void checkRoomNow(room.id).catch(() => undefined);
        if (platform === "douyin") void promptDouyinAuthorization(message);
      }
      onClose();
    } catch (e) {
      message.error(
        e instanceof ApiError ? describeError(e.code, e.message) : "保存失败",
      );
    } finally {
      clearSubmitHintTimer();
      setSubmitHint(false);
      setSubmitting(false);
    }
  };

  const urlValue = Form.useWatch("url", form);

  const pasteRoomUrl = async () => {
    try {
      const url = await navigator.clipboard.readText();
      if (!url.trim()) {
        message.warning("剪贴板中没有可粘贴的内容");
        return;
      }
      form.setFieldValue("url", url.trim());
    } catch {
      message.error("无法读取剪贴板，请检查系统剪贴板权限");
    }
  };

  return (
    <Modal
      title={editing ? "编辑直播间" : "添加直播间"}
      open={open}
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={submitting}
      destroyOnHidden
      width={700}
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="url"
          label="直播间链接"
          rules={[
            { required: true, message: "请输入直播间链接" },
            {
              validator: (_, v: string) =>
                !v || guessPlatform(v)
                  ? Promise.resolve()
                  : Promise.reject(
                      new Error(
                        "支持 B站 / 抖音直播链接、小红书主页或直播分享链接、YouTube 频道或直播视频链接",
                      ),
                    ),
            },
          ]}
          extra={
            urlValue && guessPlatform(urlValue)
              ? `识别为：${PLATFORM_LABEL[guessPlatform(urlValue)!]}`
              : undefined
          }
        >
          <Input
            placeholder="B站、抖音、小红书直播链接或 YouTube 频道/直播视频链接"
            addonAfter={
              <Button
                className="lr-room-url-paste"
                type="text"
                size="small"
                icon={<SnippetsOutlined />}
                onClick={() => void pasteRoomUrl()}
              >
                粘贴
              </Button>
            }
          />
        </Form.Item>
        <Form.Item name="displayName" label="显示名（可选，留空自动解析）">
          <Input placeholder="主播昵称" />
        </Form.Item>
        <Form.Item name="tagIds" label="标签">
          <RoomTagField />
        </Form.Item>
      </Form>
      {submitting && submitHint && !editing ? (
        <div className="lr-room-submit-pending" role="status" aria-live="polite">
          <Spin size="small" />
          <Typography.Text type="secondary">
            正在解析直播间信息，约需 10 秒…
          </Typography.Text>
        </div>
      ) : null}
    </Modal>
  );
}
