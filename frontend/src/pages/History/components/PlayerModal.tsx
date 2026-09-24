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
