import { useEffect, useRef, useState } from 'react';
import { App, Tooltip } from 'antd';
import { bridge } from '../stores/bootStore';
import { useServiceStore } from '../stores/serviceStore';
import { startUpdateMonitoring, useUpdateStore } from '../stores/updateStore';
import type { UpdateState } from '../types/update';

export default function AppVersion() {
  const { message, modal } = App.useApp();
  const state = useUpdateStore((s) => s.state);
  const checking = useUpdateStore((s) => s.checking);
  const browserVersion = useServiceStore((s) => s.status?.version);
  const [installedVersion, setInstalledVersion] = useState('');
  const dialogOpen = useRef(false);
  useEffect(() => {
    if (bridge.isDesktop) void import('@tauri-apps/api/app').then(({ getVersion }) => getVersion()).then(setInstalledVersion).catch(() => {});
    return startUpdateMonitoring();
  }, []);
  const previous = useRef(state?.phase);
  useEffect(() => {
    if (previous.current === 'downloading' && state?.phase === 'ready') {
      void message.success('下载完成，点击版本号打开安装包');
    }
    previous.current = state?.phase;
  }, [state?.phase, message]);
  const percent = state?.update ? Math.min(100, Math.floor(state.downloaded / state.update.asset.size * 100)) : 0;
  const showDownload = (snapshot: UpdateState) => {
    if (!snapshot.update || dialogOpen.current) return;
    dialogOpen.current = true;
    modal.confirm({
      title: `发现新版本 ${snapshot.update.version}`,
      content: `当前版本 ${snapshot.currentVersion}，是否下载安装包？下载完成后需手动安装。`,
      okText: '下载更新', cancelText: '稍后',
      afterClose: () => { dialogOpen.current = false; },
      onOk: () => {
        void useUpdateStore.getState().download().catch((error) => { void message.error(String(error)); });
      },
    });
  };
  const click = async () => {
    if (!bridge.isDesktop) { void message.info('更新功能仅限桌面客户端'); return; }
    if (checking || dialogOpen.current) return;
    try {
      const latest = useUpdateStore.getState().state;
      if (latest?.phase === 'downloading') { void message.info(`正在下载安装包：${percent}%`); return; }
      if (latest?.phase === 'ready') { await bridge.openUpdate(); return; }
      if (latest?.update) { showDownload(latest); return; }
      const result = await useUpdateStore.getState().check();
      if (result?.update) showDownload(result);
      else void message.success('当前已是最新版本');
    } catch (error) { void message.error(String(error)); }
  };
  const title = checking ? '正在检查更新…' : state?.phase === 'downloading' ? `正在下载 ${percent}%`
    : state?.phase === 'ready' ? '下载完成，点击打开安装包'
    : state?.update ? `发现新版本 ${state.update.version}，点击下载` : '点击检查更新';
  return (
    <div className="lr-app-version">
      <Tooltip title={title}>
        <button className="lr-version-button" type="button" onClick={() => void click()} aria-label={title} aria-busy={checking}>
          {bridge.isDesktop ? state?.currentVersion || installedVersion : browserVersion ?? ''}
          {state?.update && <span className="lr-version-track" role={state.phase === 'downloading' ? 'progressbar' : undefined}
            aria-label="安装包下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.phase === 'downloading' ? percent : undefined}>
            <span style={{ width: `${state.phase === 'downloading' ? percent : 100}%` }} />
          </span>}
        </button>
      </Tooltip>
    </div>
  );
}
