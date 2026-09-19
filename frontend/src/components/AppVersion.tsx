import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Tooltip, Typography } from "antd";
import { bridge } from "../stores/bootStore";
import { useRoomStore } from "../stores/roomStore";
import { useServiceStore } from "../stores/serviceStore";
import { startUpdateMonitoring, useUpdateStore } from "../stores/updateStore";
import type { UpdateState } from "../types/update";

export default function AppVersion() {
  const { message, modal } = App.useApp();
  const state = useUpdateStore((s) => s.state);
  const checking = useUpdateStore((s) => s.checking);
  const browserVersion = useServiceStore((s) => s.status?.version);
  const rooms = useRoomStore((s) => s.rooms);
  const [installedVersion, setInstalledVersion] = useState("");
  const dialogOpen = useRef(false);
  const recordingNames = useMemo(
    () =>
      rooms
        .filter((room) => room.monitorState === "recording")
        .map((room) => room.displayName),
    [rooms],
  );
  useEffect(() => {
    if (bridge.isDesktop)
      void import("@tauri-apps/api/app")
        .then(({ getVersion }) => getVersion())
        .then(setInstalledVersion)
        .catch(() => {});
    return startUpdateMonitoring();
  }, []);
  const showInstall = useCallback(
    (snapshot: UpdateState) => {
      if (!snapshot.update || dialogOpen.current) return;
      dialogOpen.current = true;
      modal.confirm({
        title: `更新 ${snapshot.update.version} 已下载完成`,
        content: (
          <div>
            <p>安装时会显示安装进度，完成后应用会自动重启。</p>
            {snapshot.update.notes.length > 0 && (
              <div>
                <strong>本次更新</strong>
                <ul>
                  {snapshot.update.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
            {recordingNames.length > 0 && (
              <Typography.Text type="danger">
                {recordingNames.join("、")} 正在录制，开始安装会结束录制
              </Typography.Text>
            )}
          </div>
        ),
        okText: "立即安装",
        cancelText: "稍后",
        afterClose: () => {
          dialogOpen.current = false;
        },
        onOk: () =>
          useUpdateStore
            .getState()
            .install()
            .catch((error) => {
              void message.error(String(error));
            }),
      });
    },
    [modal, message, recordingNames],
  );
  const previous = useRef(state?.phase);
  useEffect(() => {
    if (previous.current === "downloading" && state?.phase === "ready")
      showInstall(state);
    previous.current = state?.phase;
  }, [state, showInstall]);
  const percent = state?.update
    ? Math.min(
        100,
        Math.floor((state.downloaded / state.update.asset.size) * 100),
      )
    : 0;
  const showDownload = (snapshot: UpdateState) => {
    if (!snapshot.update || dialogOpen.current) return;
    dialogOpen.current = true;
    modal.confirm({
      title: `发现新版本 ${snapshot.update.version}`,
      content: (
        <div>
          <p>当前版本 {snapshot.currentVersion}，下载完成后可选择立即安装。</p>
          {snapshot.update.notes.length > 0 && (
            <div>
              <strong>本次更新</strong>
              <ul>
                {snapshot.update.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ),
      okText: "下载更新",
      cancelText: "稍后",
      afterClose: () => {
        dialogOpen.current = false;
      },
      onOk: () => {
        void useUpdateStore
          .getState()
          .download()
          .catch((error) => {
            void message.error(String(error));
          });
      },
    });
  };
  const click = async () => {
    if (!bridge.isDesktop) {
      void message.info("更新功能仅限桌面客户端");
      return;
    }
    if (checking || dialogOpen.current) return;
    try {
      const latest = useUpdateStore.getState().state;
      if (latest?.phase === "downloading") {
        void message.info(`正在下载安装包：${percent}%`);
        return;
      }
      if (latest?.phase === "ready") {
        showInstall(latest);
        return;
      }
      if (latest?.update) {
        showDownload(latest);
        return;
      }
      const result = await useUpdateStore.getState().check();
      if (result?.update) showDownload(result);
      else void message.success("当前已是最新版本");
    } catch (error) {
      void message.error(String(error));
    }
  };
  const title = checking
    ? "正在检查更新…"
    : state?.phase === "downloading"
      ? `正在下载 ${percent}%`
      : state?.phase === "ready"
        ? "更新已就绪，点击安装"
        : state?.update
          ? `发现新版本 ${state.update.version}，点击下载`
          : "点击检查更新";
  return (
    <div className="lr-app-version">
      <Tooltip title={title}>
        <button
          className="lr-version-button"
          type="button"
          onClick={() => void click()}
          aria-label={title}
          aria-busy={checking}
        >
          {state?.update
            ? "有新版本！"
            : bridge.isDesktop
              ? state?.currentVersion || installedVersion
              : (browserVersion ?? "")}
          {state?.update && (
            <span
              className="lr-version-track"
              role={state.phase === "downloading" ? "progressbar" : undefined}
              aria-label="安装包下载进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={
                state.phase === "downloading" ? percent : undefined
              }
            >
              <span
                style={{
                  width: `${state.phase === "downloading" ? percent : 100}%`,
                }}
              />
            </span>
          )}
        </button>
      </Tooltip>
    </div>
  );
}
