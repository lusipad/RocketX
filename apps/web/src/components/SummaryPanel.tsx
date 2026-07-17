import { AlertTriangle, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { useAiAssistant } from '../stores/aiAssistant';
import { useChat } from '../stores/chat';

export default function SummaryPanel() {
  const summary = useAiAssistant();
  const setPanel = useChat((state) => state.setPanel);

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-line bg-surface">
      <header className="flex h-14 items-center gap-2 border-b border-line px-4">
        <Sparkles size={17} className="text-primary" />
        <span className="font-medium text-ink">AI 会话总结</span>
        <button onClick={() => setPanel(null)} className="ml-auto rounded p-1.5 text-ink-3 hover:bg-fill-hover"><X size={16} /></button>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        {summary.status === 'loading' && !summary.content && (
          <div className="flex items-center gap-2 py-8 text-sm text-ink-3"><Loader2 size={16} className="animate-spin" />正在读取历史并调用模型…</div>
        )}
        {summary.messageCount > 0 && (
          <div className="mb-3 text-xs text-ink-3">
            已纳入 {summary.messageCount} 条消息{summary.truncated ? '；历史达到 1000 条上限，结果已明确截断' : ''}
          </div>
        )}
        {summary.truncated && (
          <div className="mb-3 flex gap-2 rounded-md border border-warning/30 bg-warning/5 p-3 text-xs text-warning"><AlertTriangle size={15} className="shrink-0" />摘要不包含上限之外的更早未读消息。</div>
        )}
        {summary.error && (
          <div className="rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger">{summary.error}</div>
        )}
        {summary.content && <div className="whitespace-pre-wrap text-sm leading-7 text-ink">{summary.content}</div>}
        {summary.status === 'loading' && summary.content && <Loader2 size={14} className="mt-3 animate-spin text-primary" />}
      </div>
      {summary.rid && summary.status !== 'loading' && (
        <div className="border-t border-line p-3">
          <button onClick={() => void summary.summarize(summary.rid!)} className="flex h-8 w-full items-center justify-center gap-2 rounded-md border border-line text-sm text-ink hover:bg-fill-hover"><RefreshCw size={14} />重新总结</button>
        </div>
      )}
    </aside>
  );
}
