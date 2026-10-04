import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { BrowserRouter } from 'react-router-dom';
import 'dayjs/locale/zh-cn';
import dayjs from 'dayjs';
import App from './App';
import { AppThemeProvider } from './theme';
import AppErrorBoundary from './components/AppErrorBoundary';
import ReactMountedMarker from './components/ReactMountedMarker';
import './styles/tokens.css';
import './styles/layout.css';
import './styles/antd-overrides.css';
import './styles/patterns.css';
import './styles/recording-track.css';
import './styles/motion.css';
import './styles/legacy.css';

dayjs.locale('zh-cn');

console.log('[live-recorder] main.tsx executing, rendering React root...');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ReactMountedMarker />
    <ConfigProvider locale={zhCN}>
      <AppThemeProvider>
        <AntdApp>
          <AppErrorBoundary>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </AppErrorBoundary>
        </AntdApp>
      </AppThemeProvider>
    </ConfigProvider>
  </StrictMode>,
);
