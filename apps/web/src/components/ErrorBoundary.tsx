import { Component, useState, type ErrorInfo, type ReactNode } from 'react';
import { useT } from '../i18n';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

function ErrorFallback({ error }: { error: Error }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const details = `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ''}`;
    const writer = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText(details) : undefined;
    if (writer) {
      void writer.then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }).catch(() => {});
    }
  };

  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 bg-fill-2 px-6 text-center">
      <div className="text-lg font-medium text-ink">{t('nav.errorBoundary.title')}</div>
      <div className="max-w-md text-sm text-ink-3">
        {t('nav.errorBoundary.description')}
      </div>
      <pre className="max-h-40 max-w-md overflow-auto rounded-md border border-line bg-code-bg p-3 text-left font-mono text-xs text-code-ink">
        {error.message}
      </pre>
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        <button
          type="button"
          onClick={handleCopy}
          className="h-10 rounded-md border border-line bg-surface-3 px-4 text-sm font-medium text-ink-2 transition hover:bg-fill-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {t(copied ? 'nav.errorBoundary.copiedDetails' : 'nav.errorBoundary.copyDetails')}
        </button>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-white transition hover:bg-primary-hover active:bg-primary-active focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {t('nav.errorBoundary.reload')}
        </button>
      </div>
    </div>
  );
}

/**
 * 全局渲染兜底。在此之前项目里没有任何 ErrorBoundary，渲染期一旦抛错就是整页白屏、
 * 控制台一行红字，用户完全无法自救（例：localStorage 写爆时同步调用的
 * saveWorkbenchConfig 抛出、某条消息触发渲染异常）。这里把崩溃收敛成一个可读的
 * 错误屏 + 重新加载入口。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留控制台栈，方便排查；未来可在此上报审计/日志服务
    console.error('[RocketX] 渲染崩溃：', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <ErrorFallback error={error} />;
  }
}
