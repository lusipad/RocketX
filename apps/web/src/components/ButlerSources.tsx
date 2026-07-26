import { ExternalLink } from 'lucide-react';
import type { ButlerSource } from '../lib/butlerContext';
import { openButlerSource as openSource } from '../lib/butlerSourceNavigation';

export default function ButlerSources({ sources }: { sources?: ButlerSource[] }) {
  if (!sources?.length) return null;
  return (
    <div className="mt-2 flex max-w-full flex-wrap gap-1.5" aria-label="回答来源">
      {sources.map((source) => (
        <button
          key={`${source.kind}:${source.id}`}
          type="button"
          title={`打开来源：${source.label}`}
          onClick={() => void openSource(source)}
          className="flex max-w-full items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-left text-2xs text-ink-2 hover:border-primary/40 hover:text-primary"
        >
          <ExternalLink size={12} className="shrink-0" />
          <span className="truncate">{source.label}</span>
        </button>
      ))}
    </div>
  );
}
