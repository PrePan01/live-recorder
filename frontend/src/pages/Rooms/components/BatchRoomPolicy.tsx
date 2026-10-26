import { useState } from "react";
import { Alert, Button, Drawer } from "antd";
import { useRoomStore } from "../../../stores/roomStore";
import { useSettingsStore } from "../../../stores/settingsStore";
import { applyRoomBatch, type RoomPolicy } from "../utils/roomPolicy";
import RoomPolicyFields from "./RoomPolicyFields";

export default function BatchRoomPolicy({
  ids,
  onClose,
}: {
  ids: string[];
  onClose: () => void;
}) {
  const settings = useSettingsStore((s) => s.settings);
  const editRoom = useRoomStore((s) => s.editRoom);
  const [patch, setPatch] = useState<RoomPolicy>({});
  const [valid, setValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    succeeded: number;
    failed: string[];
  } | null>(null);
  const changed = Object.values(patch).some((value) => value !== undefined);
  const run = async (targets: string[]) => {
    setBusy(true);
    try {
      const next = await applyRoomBatch(targets, { ...patch }, editRoom);
      setResult((previous) => ({
        succeeded: (previous?.succeeded ?? 0) + next.succeeded,
        failed: next.failed,
      }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      className="lr-room-policy-drawer"
      title={`批量设置 ${ids.length} 个直播间`}
      open
      onClose={onClose}
      closable={!busy}
      maskClosable={!busy}
      keyboard={!busy}
      size={640}
      footer={
        <div className="lr-room-policy-actions">
          <Button disabled={busy} onClick={onClose}>
            关闭
          </Button>
          {result?.failed.length ? (
            <Button
              type="primary"
              loading={busy}
              onClick={() => void run(result.failed)}
            >
              仅重试失败项
            </Button>
          ) : (
            <Button
              type="primary"
              disabled={!changed || !valid || Boolean(result)}
              loading={busy}
              onClick={() => void run(ids)}
            >
              应用到所选直播间
            </Button>
          )}
        </div>
      }
    >
      <p className="lr-room-policy-intro">选择“不修改”将保留各直播间原有设置</p>
      <div className="lr-room-policy-editor">
        <RoomPolicyFields
          value={patch}
          settings={settings}
          batch
          onValidityChange={setValid}
          disabled={busy || Boolean(result)}
          onChange={(next) => setPatch((value) => ({ ...value, ...next }))}
        />
      </div>
      {result && (
        <Alert
          style={{ marginTop: 20 }}
          type={result.failed.length ? "warning" : "success"}
          showIcon
          title={`成功 ${result.succeeded} 个，失败 ${result.failed.length} 个`}
          description={
            result.failed.length
              ? "已保存成功项，可重试失败项。"
              : "所有设置已保存。"
          }
        />
      )}
    </Drawer>
  );
}
