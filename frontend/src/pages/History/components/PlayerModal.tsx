// 拆分（task #62）：录制播放浮层——自 index.tsx 原样迁移，props 显式。
import { Modal } from "antd";
import FilePlayer from "../../../components/FilePlayer";
import { recordingFileUrl } from "../../../api/client";
import type { Recording } from "../../../types/recording";

export default function PlayerModal({
  playing,
  onClose,
}: {
  playing: Recording | null;
  onClose: () => void;
}) {
  return (
      <Modal
        title={`播放：${playing?.streamTitle || playing?.id || ""}`}
        open={playing !== null}
        footer={null}
        width={820}
        destroyOnHidden
        onCancel={onClose}
      >
        {playing ? (
          <FilePlayer
            url={recordingFileUrl(playing.id)}
            filePath={playing.filePath}
          />
        ) : null}
      </Modal>

  );
}
