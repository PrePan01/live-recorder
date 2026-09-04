import { Component, type ReactNode } from 'react';
import { Button, Result } from 'antd';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  /** 区分 chunk 加载失败（可重试）与其他渲染错误 */
  isChunkError: boolean;
}

/**
 * 路由懒加载错误边界：动态 import chunk 偶发失败/渲染异常时，
 * 显示可重试的错误页而非永久「加载中…」（PrePan：客户端偶现卡加载中+卡死）。
 * chunk 加载失败是动态 import 的 rejection，Suspense 不捕获，必须用错误边界拦截。
 */
export default class LazyRouteErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, isChunkError: false };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return {
      hasError: true,
      // 动态 import 失败、脚本加载错误、SyntaxError/ChunkLoadError 均属可重试。
      isChunkError: /loading chunk|importing module|failed to fetch|ChunkLoadError|dynamic import|unexpected token|script error/i.test(message),
    };
  }

  private retry = () => {
    this.setState({ hasError: false, isChunkError: false });
  };

  componentDidCatch(error: unknown): void {
    console.error('[LazyRoute] 页面加载或渲染失败', error);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <Result
          status="error"
          title={this.state.isChunkError ? '页面加载失败' : '页面渲染出错'}
          subTitle={this.state.isChunkError ? '本地页面资源加载中断，请重试。' : '页面发生异常，请重试；若持续出现请反馈。'}
          extra={
            <Button type="primary" onClick={this.retry}>
              重试
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}
