import { ChevronRight, ExternalLink } from 'lucide-react';
import { useCallback, useMemo, useRef, type ReactNode } from 'react';
import type { ButlerSource } from '../lib/butlerContext';
import type { MarkdownLinkRenderer } from '../lib/markdown';
import { openButlerSource as openSource } from '../lib/butlerSourceNavigation';

const MARKDOWN_CITATION = /\[来源\]\((https?:\/\/[^\s)]+)\)/g;
const NO_SOURCE_LINK: MarkdownLinkRenderer = () => undefined;

function citedSources(text: string, sources: readonly ButlerSource[]): ButlerSource[] {
  const byUrl = new Map(
    sources.flatMap((source) => source.webUrl ? [[source.webUrl, source] as const] : []),
  );
  const seen = new Set<string>();
  const cited: ButlerSource[] = [];
  for (const match of text.matchAll(MARKDOWN_CITATION)) {
    const source = byUrl.get(match[1]);
    if (!source) continue;
    const key = `${source.kind}:${source.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cited.push(source);
  }
  return cited;
}

export default function ButlerSources({
  sources,
  text,
  children,
}: {
  sources?: ButlerSource[];
  text: string;
  children?: (renderLink: MarkdownLinkRenderer) => ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const sourceRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const matchedSources = useMemo(
    () => sources?.length ? citedSources(text, sources) : [],
    [sources, text],
  );
  const visibleSources = useMemo(
    () => matchedSources.length ? matchedSources : sources ?? [],
    [matchedSources, sources],
  );
  const citationNumbers = useMemo(() => new Map(
    visibleSources.flatMap((source, index) => (
      source.webUrl ? [[source.webUrl, index + 1] as const] : []
    )),
  ), [visibleSources]);
  if (!sources?.length) return children?.(NO_SOURCE_LINK) ?? null;

  const revealSources = useCallback((index: number): void => {
    if (detailsRef.current) detailsRef.current.open = true;
    requestAnimationFrame(() => sourceRefs.current[index]?.focus());
  }, []);
  const renderLink = useCallback<MarkdownLinkRenderer>((label, href) => {
    if (label.trim() !== '来源') return undefined;
    const number = citationNumbers.get(href);
    if (!number || matchedSources.length === 0) return undefined;
    return (
      <button
        type="button"
        aria-label={`查看参考来源 ${number}`}
        title={`查看参考来源 ${number}`}
        onClick={() => revealSources(number - 1)}
        className="ml-0.5 inline-flex h-4 items-center rounded-sm px-0.5 text-xs font-medium leading-none text-primary underline decoration-primary/35 underline-offset-2 hover:bg-primary-light hover:decoration-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
      >
        <sup>{number}</sup>
      </button>
    );
  }, [citationNumbers, matchedSources.length, revealSources]);

  return (
    <div role="group" aria-label="回答引用" className="contents">
      {children?.(renderLink)}

      <details ref={detailsRef} className="group mt-1.5 block border-t border-line/80 pt-1.5">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-ink-3 hover:text-ink-2">
          <ChevronRight
            size={12}
            aria-hidden="true"
            className="transition-transform motion-reduce:transition-none group-open:rotate-90"
          />
          <span>参考来源（{visibleSources.length}）</span>
        </summary>
        <ol className="mt-1.5 space-y-0.5 border-l border-line pl-2.5">
          {visibleSources.map((source, index) => (
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
