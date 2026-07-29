import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import {
  loadStickerCatalog,
  searchStickerEntries,
  stickerEntryKey,
} from '../lib/stickerLoader';
import type { StickerCatalog, StickerEntry } from '../lib/stickerManifest';

const RECENT_KEY = 'rcx-recent-stickers';

function recentStorageKey(): string {
  try {
    return `${RECENT_KEY}#${localStorage.getItem('rcx-owner') ?? 'anonymous'}`;
  } catch {
    return RECENT_KEY;
  }
}

function loadRecentStickerIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(recentStorageKey()) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function pushRecentSticker(sticker: StickerEntry): string[] {
  const key = stickerEntryKey(sticker);
  const next = [key, ...loadRecentStickerIds().filter((item) => item !== key)].slice(0, 16);
  try {
    localStorage.setItem(recentStorageKey(), JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export default function StickerPicker({
  onPick,
  onClose,
  className = '',
}: {
  onPick: (sticker: StickerEntry) => void;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [catalog, setCatalog] = useState<StickerCatalog>({ groups: [], entries: [] });
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>(() => loadRecentStickerIds());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void loadStickerCatalog()
      .then((nextCatalog) => {
        if (!alive) return;
        setCatalog(nextCatalog);
        setLoadError(null);
      })
      .catch((error) => {
        if (!alive) return;
        setCatalog({ groups: [], entries: [] });
        setLoadError(error instanceof Error ? error.message : '加载贴纸失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  const recent = useMemo(
    () =>
      recentIds
        .map((id) => catalog.entries.find((entry) => stickerEntryKey(entry) === id) ?? null)
        .filter((entry): entry is StickerEntry => !!entry),
    [catalog.entries, recentIds],
  );
  const results = useMemo(() => searchStickerEntries(catalog, keyword), [catalog, keyword]);

  const pick = (sticker: StickerEntry) => {
    setRecentIds(pushRecentSticker(sticker));
    onPick(sticker);
  };

  return (
    <div
      ref={ref}
      className={`z-50 w-[320px] rounded-lg bg-surface-4 p-2 shadow-[0_4px_16px_rgba(0,0,0,0.16)] ${className}`}
    >
      <div className="mb-2 flex h-8 items-center gap-1.5 rounded-md bg-fill-1 px-2">
        <Search size={12} className="text-ink-3" />
        <input
          autoFocus
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索贴纸"
          className="w-full bg-transparent text-xs outline-none placeholder:text-ink-3"
        />
      </div>

      {!keyword && recent.length > 0 && (
        <>
          <div className="px-1 pb-1 text-xs text-ink-3">最近使用</div>
          <div className="mb-1.5 grid grid-cols-3 gap-2 border-b border-line pb-2">
            {recent.map((sticker) => (
              <button
                key={`recent-${sticker.id}`}
                aria-label={`发送贴纸 ${sticker.title}`}
                title={sticker.title}
                onClick={() => pick(sticker)}
                className="flex min-h-24 flex-col items-center justify-center rounded-md bg-fill-1 px-2 py-2 text-center transition hover:bg-fill-hover"
              >
                <img src={sticker.src} alt={sticker.title} className="mb-2 h-12 w-12 object-contain" />
                <span className="line-clamp-2 text-[11px] text-ink">{sticker.title}</span>
              </button>
            ))}
          </div>
        </>
      )}

      <div ref={scrollRef} className="max-h-72 overflow-y-auto">
        {loading ? (
          <div className="py-8 text-center text-xs text-ink-3">正在加载贴纸…</div>
        ) : loadError ? (
          <div className="py-8 text-center text-xs text-danger">{loadError}</div>
        ) : results ? (
          results.length > 0 ? (
            <div className="grid grid-cols-3 gap-2">
              {results.map((sticker) => (
                <button
                  key={sticker.id}
                  aria-label={`发送贴纸 ${sticker.title}`}
                  title={sticker.title}
                  onClick={() => pick(sticker)}
                  className="flex min-h-24 flex-col items-center justify-center rounded-md bg-fill-1 px-2 py-2 text-center transition hover:bg-fill-hover"
                >
                  <img src={sticker.src} alt={sticker.title} className="mb-2 h-12 w-12 object-contain" />
                  <span className="line-clamp-2 text-[11px] text-ink">{sticker.title}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="py-8 text-center text-xs text-ink-3">没有匹配的贴纸</div>
          )
        ) : catalog.groups.length > 0 ? (
          catalog.groups.map((group) => (
            <div key={`${group.packageId}:${group.id}`} data-sticker-group={group.title}>
              <div className="sticky top-0 bg-surface-4 px-1 py-1 text-xs text-ink-3">
                {group.title}
              </div>
              <div className="grid grid-cols-3 gap-2 pb-2">
                {group.items.map((sticker) => (
                  <button
                    key={sticker.id}
                    aria-label={`发送贴纸 ${sticker.title}`}
                    title={sticker.title}
                    onClick={() => pick(sticker)}
                    className="flex min-h-24 flex-col items-center justify-center rounded-md bg-fill-1 px-2 py-2 text-center transition hover:bg-fill-hover"
                  >
                    <img src={sticker.src} alt={sticker.title} className="mb-2 h-12 w-12 object-contain" />
                    <span className="line-clamp-2 text-[11px] text-ink">{sticker.title}</span>
                  </button>
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="py-8 text-center text-xs text-ink-3">暂无可用贴纸</div>
        )}
      </div>

      {!keyword && catalog.groups.length > 1 && (
        <div className="mt-1.5 flex flex-wrap gap-1 border-t border-line pt-1.5">
          {catalog.groups.map((group) => (
            <button
              key={`${group.packageId}:${group.id}:jump`}
              onClick={() => {
                scrollRef.current
                  ?.querySelector(`[data-sticker-group="${group.title}"]`)
                  ?.scrollIntoView({ block: 'start' });
              }}
              className="rounded bg-fill-1 px-2 py-1 text-[11px] text-ink-2 transition hover:bg-fill-hover"
            >
              {group.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
