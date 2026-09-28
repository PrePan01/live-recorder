import { SettingOutlined } from "@ant-design/icons";
import { Button, Drawer, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import PipelineTimeline from "./PipelineTimeline";
import UploadStatus from "./UploadStatus";
import type { Recording } from "../../../types/recording";
import "./PipelineDrawer.css";

export default function PipelineDrawer({
  pipelineRec,
  onClose,
}: {
  pipelineRec: Recording | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();

  const openPipelineSettings = () => {
    onClose();
    navigate("/settings#pipeline");
  };

  return (
    <Drawer
      title={
        <span className="pipeline-drawer-title">管线详情</span>
      }
      open={pipelineRec !== null}
      size={620}
      onClose={onClose}
      className="pipeline-drawer"
      extra={
        <Button
          size="small"
          icon={<SettingOutlined />}
          onClick={openPipelineSettings}
        >
          管线设置
        </Button>
      }
    >
      {pipelineRec ? (
        <div className="pipeline-drawer-content">
          <header className="pipeline-recording-header">
            <Typography.Title level={4} className="pipeline-recording-title">
              {pipelineRec.streamTitle || pipelineRec.id}
            </Typography.Title>
          </header>
          <PipelineTimeline recordingId={pipelineRec.id} />
          <section className="pipeline-section pipeline-upload-section">
            <div className="pipeline-section-heading">
              <Typography.Title level={5}>云端上传</Typography.Title>
            </div>
            <UploadStatus recordingId={pipelineRec.id} />
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
