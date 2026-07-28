import { useRef, type ReactNode } from 'react';
import { ChevronRight, ExternalLink } from 'lucide-react';
import type { ButlerSource } from '../lib/butlerContext';
import { openButlerSource as openSource } from '../lib/butlerSourceNavigation';

export default function ButlerSources({
  sources,
  children,
}: {
  sources?: ButlerSource[];
  children?: (marker: ReactNode) => ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const sourceRefs = useRef<Array<HTMLButtonElement | null>>([]);
  if (!sources?.length) return children?.(null) ?? null;

  const revealSources = () => {
    if (detailsRef.current) detailsRef.current.open = true;
    requestAnimationFrame(() => sourceRefs.current[0]?.focus());
  };
  const markerText = sources.length === 1 ? '1' : `1–${sources.length}`;
  const marker = (
    <button
      type="button"
      aria-label={`查看 ${sources.length} 条参考来源`}
      title={`展开 ${sources.length} 条参考来源`}
      onClick={revealSources}
      className="ml-1 inline-flex h-4 items-center rounded-sm px-0.5 text-[11px] font-medium leading-none text-primary underline decoration-primary/35 underline-offset-2 hover:bg-primary-light hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
    >
      <sup>{markerText}</sup>
    </button>
  );

  return (
    <div role="group" aria-label="回答引用" className="contents">
      {children ? children(marker) : <span aria-label="正文引用">{marker}</span>}

      <details ref={detailsRef} className="group mt-1.5 block border-t border-line/80 pt-1.5">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[11px] text-ink-3 hover:text-ink-2">
          <ChevronRight
            size={12}
            aria-hidden="true"
            className="transition-transform motion-reduce:transition-none group-open:rotate-90"
          />
          <span>参考来源（{sources.length}）</span>
        </summary>
        <ol className="mt-1.5 space-y-0.5 border-l border-line pl-2.5">
          {sources.map((source, index) => (
            <li key={`${source.kind}:${source.id}`}>
              <button
                ref={(node) => {
                  sourceRefs.current[index] = node;
                }}
                type="button"
                title={`打开来源：${source.label}`}
                onClick={() => void openSource(source)}
                className="grid w-full max-w-full grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-1 rounded-sm px-1 py-1 text-left text-xs text-ink-2 hover:bg-fill-hover hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
              >
                <span className="font-medium text-primary">[{index + 1}]</span>
                <span className="min-w-0 break-words">{source.label}</span>
                <ExternalLink size={12} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-3" />
              </button>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
