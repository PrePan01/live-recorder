import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { BrowserRouter } from 'react-router-dom';
import 'dayjs/locale/zh-cn';
import dayjs from 'dayjs';
import App from './App';
import { AppThemeProvider } from './theme';
import './index.css';

dayjs.locale('zh-cn');

// 全局错误捕获：打包 WebView 白屏诊断用——错误显示在页面覆盖层并写 localStorage。
// AbortError 为媒体播放/请求中止的正常生命周期信号（如视频播完/组件卸载），
// 不应触发致命覆盖层（否则表现为「播放完视频应用卡死」）。仅记录不阻断。
function isBenignError(reason: unknown): boolean {
  if (reason instanceof DOMException) return reason.name === 'AbortError';
  if (reason instanceof Error) return reason.name === 'AbortError';
  const s = String(reason);
  return s.includes('AbortError') || s.includes('The operation was aborted');
}

window.addEventListener('error', (e) => {
  const msg = `[error] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`;
  console.error('[live-recorder]', msg);
  if (isBenignError(e.error)) return;
  showFatalError(msg);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = `[unhandledrejection] ${String(e.reason)}`;
  console.error('[live-recorder]', msg);
  if (isBenignError(e.reason)) return;
  showFatalError(msg);
});
function showFatalError(msg: string) {
  try {
    localStorage.setItem('lr-fatal-error', msg);
    let el = document.getElementById('fatal-error-overlay');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fatal-error-overlay';
      el.style.cssText =
        'position:fixed;inset:0;z-index:9999;background:#fff;color:#c00;padding:24px;font:12px/1.5 monospace;white-space:pre-wrap;overflow:auto';
      document.body.appendChild(el);
    }
    el.textContent += `\n${msg}`;
  } catch {
    /* 忽略 */
  }
}

console.log('[live-recorder] main.tsx executing, rendering React root...');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider locale={zhCN}>
      <AppThemeProvider>
        <AntdApp>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AntdApp>
      </AppThemeProvider>
    </ConfigProvider>
  </StrictMode>,
);

// 渲染自检：React 挂载后移除加载提示并写入标记，便于诊断打包 WebView 是否执行前端 JS。
requestAnimationFrame(() => {
  document.getElementById('boot-hint')?.remove();
  document.documentElement.dataset.reactReady = '1';
  localStorage.setItem('lr-react-mounted', String(Date.now()));
  console.log('[live-recorder] react mounted, boot-hint removed');
});
