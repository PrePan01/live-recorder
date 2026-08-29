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
