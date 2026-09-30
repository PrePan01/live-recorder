import { Button, Input, Modal, Space, Typography } from "antd";

type Props = {
  open: boolean;
  /** 确认对象的可读名（房间名）。 */
  name: string;
  /** 结束原因文案；null 不显示该行。 */
  endReasonText: string | null;
  interruptedEnd: boolean;
  fileName: string;
  onFileNameChange: (value: string) => void;
  confirming: boolean;
  onKeep: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  /** 整段结束确认不给退路（维持原行为）；片段导出确认允许关框=取消导出。 */
  closable?: boolean;
};

/** 录制片段「保留/不保留」确认框（整段结束与导出选区共用同一套 UI）。 */
export default function RecordingKeepConfirmModal({
  open,
  name,
  endReasonText,
  interruptedEnd,
  fileName,
  onFileNameChange,
  confirming,
  onKeep,
  onDiscard,
  onCancel,
  closable = false,
}: Props) {
  return (
    <Modal
      centered
      open={open}
      title="录制完成"
      closable={closable}
      maskClosable={false}
      zIndex={1200}
      footer={null}
      onCancel={onCancel}
    >
      <p>
        {interruptedEnd
          ? "录制已中断，是否保留已录到的部分？"
          : "录制已完成，是否保留此片段？"}
        <br />
        <span style={{ fontWeight: 600 }}>{name}</span>
      </p>
      {/* 中断结束不能只显示"录制完成"：要让用户知道这次是为什么停的。 */}
      {endReasonText ? (
        <p style={{ marginTop: 0, marginBottom: 12 }}>
          <Typography.Text type={interruptedEnd ? "warning" : "secondary"}>
            结束原因：{endReasonText}
          </Typography.Text>
        </p>
      ) : null}
      <Input
        size="small"
        value={fileName}
        onChange={(event) => onFileNameChange(event.target.value)}
        placeholder="录像文件名（不含扩展名）"
        addonBefore="文件名"
        disabled={confirming}
        maxLength={120}
      />
      <Space
        style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}
      >
        <Button danger loading={confirming} onClick={onDiscard}>
          不保留（删除）
        </Button>
        <Button type="primary" loading={confirming} onClick={onKeep}>
          保留
        </Button>
      </Space>
    </Modal>
  );
}
