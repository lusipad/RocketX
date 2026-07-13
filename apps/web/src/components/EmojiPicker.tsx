import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search } from 'lucide-react';
import { EMOJI_LIST, type EmojiEntry } from '../lib/emoji';

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
  const [keyword, setKeyword] = useState('');
  const [place, setPlace] = useState(pos ?? { x: 0, y: 0 });

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
      x: Math.min(pos.x, window.innerWidth - rect.width - 8),
      y: Math.min(pos.y, window.innerHeight - rect.height - 8),
    });
  }, [pos]);

  const recent = useMemo(() => {
    const codes = loadRecent();
    return codes
      .map((c) => EMOJI_LIST.find((e) => e.code === c))
      .filter((e): e is EmojiEntry => !!e);
  }, []);

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return q ? EMOJI_LIST.filter((e) => e.code.includes(q)) : EMOJI_LIST;
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
          <div className="px-1 pb-1 text-[10px] text-ink-3">最近使用</div>
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

      <div className="grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto">
        {filtered.map((e) => (
          <button
            key={e.code}
            title={`:${e.code}:`}
            onClick={() => pick(e)}
            className="flex h-7 w-7 items-center justify-center rounded text-lg leading-none transition hover:bg-fill-hover"
          >
            {e.char}
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="col-span-8 py-4 text-center text-xs text-ink-3">没有匹配的表情</div>
        )}
      </div>
    </div>
  );

  return pos ? createPortal(body, document.body) : body;
}
