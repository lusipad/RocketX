import { useEffect, useRef } from 'react';
import { EMOJI_LIST, type EmojiEntry } from '../lib/emoji';

/** 表情选择弹层：点击外部自动关闭 */
export default function EmojiPicker({
  onPick,
  onClose,
  className = '',
}: {
  onPick: (emoji: EmojiEntry) => void;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

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

  return (
    <div
      ref={ref}
      className={`z-30 grid w-[264px] grid-cols-8 gap-0.5 rounded-lg border border-line bg-surface-4 p-2 shadow-[0_4px_16px_rgba(31,35,41,0.12)] ${className}`}
    >
      {EMOJI_LIST.map((e) => (
        <button
          key={e.code}
          title={`:${e.code}:`}
          onClick={() => onPick(e)}
          className="flex h-7 w-7 items-center justify-center rounded text-lg leading-none transition hover:bg-fill-hover"
        >
          {e.char}
        </button>
      ))}
    </div>
  );
}
