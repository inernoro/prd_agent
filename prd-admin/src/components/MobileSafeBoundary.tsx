import React from 'react';
import { RefreshCw, Home, Copy, ChevronDown, ChevronUp } from 'lucide-react';
import { recordClientError } from '@/lib/clientErrorReporter';

interface Props {
  children: React.ReactNode;
  /** 触发 resetKey 变化时自动清掉错误状态（路由切换后重新渲染） */
  resetKey?: string | number;
}

interface State {
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  expanded: boolean;
}

/**
 * 全局错误边界 —— 专门防止「某个页面渲染抛错 → 整个 App 卸载 → 黑屏」。
 *
 * 触发时展示：错误标题 + 一键重试 / 回首页 / 展开技术细节 / 复制堆栈。
 * 同时把错误转发给 clientErrorReporter，进入 sessionStorage 环形缓冲（供 /_dev/mobile-audit 读取）。
 */
export class MobileSafeBoundary extends React.Component<Props, State> {
  state: State = { error: null, errorInfo: null, expanded: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ errorInfo });
    recordClientError({
      kind: 'render',
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack ?? undefined,
      url: window.location.href,
      userAgent: navigator.userAgent,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    });
  }

  componentDidUpdate(prevProps: Props): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null, errorInfo: null, expanded: false });
    }
  }

  reset = () => {
    this.setState({ error: null, errorInfo: null, expanded: false });
  };

  goHome = () => {
    this.reset();
    window.location.hash = '';
    window.location.pathname = '/';
  };

  copyStack = async () => {
    const { error, errorInfo } = this.state;
    const text = [
      `URL: ${window.location.href}`,
      `UA: ${navigator.userAgent}`,
      `Viewport: ${window.innerWidth}x${window.innerHeight}`,
      `Error: ${error?.message}`,
      '',
      'Stack:',
      error?.stack ?? '(无)',
      '',
      'Component Stack:',
      errorInfo?.componentStack ?? '(无)',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // fallback: 选中文本区供手动复制
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    const { error, errorInfo, expanded } = this.state;
    return (
      <div
        className="h-full w-full flex items-center justify-center overflow-auto"
        style={{ background: 'var(--bg-base, #141418)', padding: 16 }}
      >
        <div
          className="w-full max-w-lg rounded-2xl p-5"
          style={{
            background: 'rgba(24, 24, 30, 0.9)',
            border: '1px solid rgba(255, 80, 80, 0.25)',
            color: 'var(--text-primary, #f7f7fb)',
          }}
        >
          <div className="flex items-start gap-3 mb-3">
            <div
              className="h-10 w-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: 'rgba(248, 113, 113, 0.18)' }}
            >
              <span style={{ color: '#f87171', fontSize: 20 }}>!</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold mb-1">页面渲染出错</div>
              <div className="text-[13px] opacity-70 break-all">
                {error.message || '未知错误'}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 mb-3">
            <button
              type="button"
              onClick={this.reset}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] transition-all active:scale-95"
              style={{ background: 'rgba(129, 140, 248, 0.18)', color: '#c7d2fe' }}
            >
              <RefreshCw size={14} /> 重试
            </button>
            <button
              type="button"
              onClick={this.goHome}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] transition-all active:scale-95"
              style={{ background: 'rgba(255, 255, 255, 0.08)', color: 'var(--text-primary)' }}
            >
              <Home size={14} /> 回首页
            </button>
            <button
              type="button"
              onClick={this.copyStack}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] transition-all active:scale-95"
              style={{ background: 'rgba(255, 255, 255, 0.06)', color: 'var(--text-secondary, #cfd0d7)' }}
            >
              <Copy size={14} /> 复制错误
            </button>
            <button
              type="button"
              onClick={() => this.setState({ expanded: !expanded })}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] transition-all active:scale-95"
              style={{ background: 'rgba(255, 255, 255, 0.04)', color: 'var(--text-muted, #8c8d99)' }}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {expanded ? '收起细节' : '展开细节'}
            </button>
          </div>

          {expanded && (
            <pre
              className="text-[11px] leading-[1.5] rounded-lg p-3 overflow-auto"
              style={{
                background: 'rgba(0, 0, 0, 0.35)',
                maxHeight: 280,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--text-muted, #8c8d99)',
              }}
            >
              {error.stack ?? '(无 stack)'}
              {errorInfo?.componentStack ? `\n\n-- Component stack --${errorInfo.componentStack}` : ''}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
