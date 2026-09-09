import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Result } from 'antd';
import { reportError } from '../utils/errorDiagnostics';

interface State { failed: boolean }

/** Only a failure of the application root reaches this recovery screen. */
export default class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError('react.root', new Error(`${error.message}\n${info.componentStack ?? ''}`));
  }

  render(): ReactNode {
    if (this.state.failed) return <Result status="error" title="界面无法继续渲染" subTitle="后台录制服务仍会继续运行。重新加载仅重建界面。" extra={<Button type="primary" onClick={() => window.location.reload()}>重新加载界面</Button>} />;
    return this.props.children;
  }
}
