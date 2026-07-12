import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  onClick: () => void;
}

/** 飞书式右键菜单：跟随鼠标位置，自动避开视口边缘 */
export default function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { innerWidth, innerHeight } = window;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.min(x, innerWidth - rect.width - 8),
      top: Math.min(y, innerHeight - rect.height - 8),
    });
  }, [x, y]);

  useEffect(() => {
    const close = () => onClose();
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 用 mousedown 而不是 click：点击菜单项本身由按钮 onClick 先处理
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onEsc);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onEsc);
      document.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-36 rounded-lg border border-line bg-white py-1 shadow-[0_4px_16px_rgba(31,35,41,0.16)]"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map(({ label, icon: Icon, danger, onClick }) => (
        <button
          key={label}
          onClick={() => {
            onClick();
            onClose();
          }}
          className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] transition hover:bg-fill-hover ${
            danger ? 'text-danger' : 'text-ink'
          }`}
        >
          {Icon && <Icon size={15} className={danger ? 'text-danger' : 'text-ink-2'} />}
          {label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
