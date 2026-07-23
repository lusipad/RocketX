import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { EMOJI_MAP, loadEmojiSections, type EmojiEntry, type EmojiSection } from '../lib/emoji';

const RECENT_KEY = 'rcx-recent-emojis';

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function pushRecentEmoji(code: string): void {
  const recent = [code, ...loadRecent().filter((c) => c !== code)].slice(0, 16);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  } catch {
    /* ignore */
  }
}

/**
 * 表情选择器：最近使用 + 搜索。
 * 传 pos 则用 portal 固定定位（不会被滚动容器裁剪）；否则内联渲染。
 */
export default function EmojiPicker({
  onPick,
  onClose,
  pos,
  className = '',
}: {
  onPick: (emoji: EmojiEntry) => void;
  onClose: () => void;
  pos?: { x: number; y: number };
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [keyword, setKeyword] = useState('');
  const [place, setPlace] = useState(pos ?? { x: 0, y: 0 });
  const [sections, setSections] = useState<EmojiSection[]>([]);

  // 分类数据是独立 chunk，打开选择器时才拉（首次约几十毫秒）
  useEffect(() => {
    let alive = true;
    void loadEmojiSections().then((s) => {
      if (alive) setSections(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onEsc);
    };
  }, [onClose]);

  // 贴边时自动翻转，避免超出视口
  useLayoutEffect(() => {
    if (!pos || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setPlace({
      x: Math.max(8, Math.min(pos.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(pos.y, window.innerHeight - rect.height - 8)),
    });
  }, [keyword, pos, sections]);

  const recent = useMemo(
    () =>
      loadRecent()
        .map((c) => (EMOJI_MAP[c] ? { code: c, char: EMOJI_MAP[c] } : null))
        .filter((e): e is EmojiEntry => !!e),
    [],
  );

  /** 搜索命中的平铺结果；不搜索时返回 null，改按分类分区渲染。命中上限 120 个，够用且不卡。 */
  const results = useMemo(() => {
    const q = keyword.trim().toLowerCase().replace(/:/g, '');
    if (!q) return null;
    const hits: EmojiEntry[] = [];
    for (const [code, char] of Object.entries(EMOJI_MAP)) {
      if (code.includes(q)) hits.push({ code, char });
      if (hits.length >= 120) break;
    }
    // 前缀命中的排前面（搜 cat 先给 cat 而不是 bobcat）
    return hits.sort(
      (a, b) => Number(b.code.startsWith(q)) - Number(a.code.startsWith(q)),
    );
  }, [keyword]);

  const pick = (e: EmojiEntry) => {
    pushRecentEmoji(e.code);
    onPick(e);
  };

  const body = (
    <div
      ref={ref}
      style={pos ? { position: 'fixed', left: place.x, top: place.y } : undefined}
      className={`z-50 w-[272px] rounded-lg border border-line bg-surface-4 p-2 shadow-[0_4px_16px_rgba(0,0,0,0.16)] ${className}`}
    >
      <div className="mb-2 flex h-7 items-center gap-1.5 rounded-md bg-fill-1 px-2">
        <Search size={12} className="text-ink-3" />
        <input
          autoFocus
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索表情"
          className="w-full bg-transparent text-xs outline-none placeholder:text-ink-3"
        />
      </div>

      {!keyword && recent.length > 0 && (
        <>
          <div className="px-1 pb-1 text-2xs text-ink-3">最近使用</div>
          <div className="mb-1.5 grid grid-cols-8 gap-0.5 border-b border-line pb-1.5">
            {recent.map((e) => (
              <button
                key={`r-${e.code}`}
                title={`:${e.code}:`}
                onClick={() => pick(e)}
                className="flex h-7 w-7 items-center justify-center rounded text-lg leading-none transition hover:bg-fill-hover"
              >
                {e.char}
              </button>
            ))}
          </div>
        </>
      )}

      <div ref={scrollRef} className="max-h-52 overflow-y-auto">
        {results ? (
          <div className="grid grid-cols-8 gap-0.5">
            {results.map((e) => (
              <button
                key={e.code}
                title={`:${e.code}:`}
                onClick={() => pick(e)}
                className="flex h-7 w-7 items-center justify-center rounded text-lg leading-none transition hover:bg-fill-hover"
              >
                {e.char}
              </button>
            ))}
            {results.length === 0 && (
              <div className="col-span-8 py-4 text-center text-xs text-ink-3">
                没有匹配的表情
              </div>
            )}
          </div>
        ) : (
          sections.map((section) => (
            <div key={section.label} data-emoji-section={section.label}>
              <div className="sticky top-0 bg-surface-4 px-1 py-1 text-2xs text-ink-3">
                {section.label}
              </div>
              <div className="grid grid-cols-8 gap-0.5">
                {section.items.map((e) => (
                  <button
                    key={e.code}
                    title={`:${e.code}:`}
                    onClick={() => pick(e)}
                    className="flex h-7 w-7 items-center justify-center rounded text-lg leading-none transition hover:bg-fill-hover"
                  >
                    {e.char}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* 分类跳转：3000+ 个表情，没有这个只能一路滚 */}
      {!keyword && (
        <div className="mt-1.5 flex items-center justify-between border-t border-line pt-1.5">
          {sections.map((s) => (
            <button
              key={s.label}
              title={s.label}
              onClick={() => {
                scrollRef.current
                  ?.querySelector(`[data-emoji-section="${s.label}"]`)
                  ?.scrollIntoView({ block: 'start' });
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-sm leading-none transition hover:bg-fill-hover"
            >
              {s.items[0]?.char}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  return pos ? createPortal(body, document.body) : body;
}
