import { Loader2, RefreshCw } from 'lucide-react';
import { renderMarkdown } from '../lib/markdown';
import type { ButlerLine } from '../stores/butler';
import ButlerSources from './ButlerSources';

export default function ButlerInlineExchange({
  lines,
  running,
  activity,
  error,
  onRetry,
}: {
  lines: readonly ButlerLine[];
  running: boolean;
  activity?: string | null;
  error?: string | null;
  onRetry?: () => void;
}) {
  let questionIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].role === 'user') {
      questionIndex = index;
      break;
    }
  }
  if (questionIndex === -1) return null;

  const question = lines[questionIndex];
  const answer = lines.slice(questionIndex + 1).find((line) => line.role === 'assistant');

  return (
    <div className="border-l border-primary/45 pl-4" aria-label="纸上问答">
      <div className="text-xs leading-5 text-ink-3">你：{question.text}</div>
      {answer ? (
        <div className="mt-1.5 text-sm leading-6 text-ink">
          <ButlerSources sources={answer.sources} text={answer.text}>
            {(renderLink) => renderMarkdown(answer.text, undefined, renderLink)}
          </ButlerSources>
        </div>
      ) : running || activity ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-ink-3">
          <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
          {activity ?? '正在处理请求…'}
        </div>
      ) : null}
      {error && !running ? (
        <div role="alert" className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-danger">
          <span>{error}</span>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              aria-label="重新发送临时问答"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-primary transition-colors hover:bg-fill-hover hover:text-primary-hover"
            >
              <RefreshCw size={12} aria-hidden="true" />
              再试一次
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
