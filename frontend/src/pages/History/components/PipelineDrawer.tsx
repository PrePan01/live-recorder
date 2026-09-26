import { Drawer, Space, Typography } from "antd";
import PipelineTimeline from "./PipelineTimeline";
import UploadStatus from "./UploadStatus";
import type { Recording } from "../../../types/recording";

export default function PipelineDrawer({
  pipelineRec,
  onClose,
}: {
  pipelineRec: Recording | null;
  onClose: () => void;
}) {
  return (
    <Drawer
      title={`管线：${pipelineRec?.streamTitle || pipelineRec?.id || ""}`}
      open={pipelineRec !== null}
      size={520}
      onClose={onClose}
    >
      {pipelineRec ? (
        <Space orientation="vertical" style={{ width: "100%" }} size={20}>
          <PipelineTimeline recordingId={pipelineRec.id} />
          <Typography.Title level={5} style={{ marginBottom: 0 }}>
            上传
          </Typography.Title>
          <UploadStatus recordingId={pipelineRec.id} />
        </Space>
      ) : null}
    </Drawer>
  );
}
