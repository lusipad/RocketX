import { Loader2 } from 'lucide-react';
import { renderMarkdown } from '../lib/markdown';
import type { ButlerLine } from '../stores/butler';
import ButlerSources from './ButlerSources';

export default function ButlerInlineExchange({
  lines,
  running,
  activity,
}: {
  lines: readonly ButlerLine[];
  running: boolean;
  activity?: string | null;
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
          {answer.text.startsWith('📌') ? answer.text : renderMarkdown(answer.text)}
          <ButlerSources sources={answer.sources} />
        </div>
      ) : running || activity ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-ink-3">
          <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
          {activity ?? '正在处理请求…'}
        </div>
      ) : null}
    </div>
  );
}
