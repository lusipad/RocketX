import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  danger?: boolean;
  onClick: () => void;
}

/**
 * 挂「用户主动关闭」监听：点击菜单外、Esc、用户主动滚动（滚轮/触摸滑动）。
 * 故意不监听 scroll 事件：会话列表因 presence/未读刷新、scrollIntoView 等产生的
 * 程序化滚动同样派发（且 isTrusted 的）scroll 事件，会把刚弹出的菜单瞬关
 * （live 复现：菜单弹出毫秒级即被列表自滚的 trailing scroll 关掉）。
 * wheel/touchmove 只来自用户输入手势，保持「用户滚动关菜单」的原语义。
 */
export function listenUserDismiss(
  target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
  onClose: () => void,
): () => void {
  const close = () => onClose();
  const onEsc = (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape') onClose();
  };
  // 用 mousedown 而不是 click：点击菜单项本身由按钮 onClick 先处理
  target.addEventListener('mousedown', close);
  target.addEventListener('keydown', onEsc);
  target.addEventListener('wheel', close, true);
  target.addEventListener('touchmove', close, true);
  return () => {
    target.removeEventListener('mousedown', close);
    target.removeEventListener('keydown', onEsc);
    target.removeEventListener('wheel', close, true);
    target.removeEventListener('touchmove', close, true);
  };
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

  useEffect(() => listenUserDismiss(document, onClose), [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 min-w-36 rounded-lg bg-surface-4 shadow-raise py-1 shadow-[0_4px_16px_rgba(31,35,41,0.16)]"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map(({ label, icon: Icon, danger, onClick }) => (
        <button
          key={label}
          onClick={(e) => {
            // portal 渲染但 React 事件仍沿组件树冒泡：
            // 不阻止的话点菜单项会触发宿主（会话项/消息）的 onClick
            e.stopPropagation();
            onClick();
            onClose();
          }}
          className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs transition hover:bg-fill-hover ${
            danger ? 'text-danger' : 'text-ink'
          }`}
        >
          {Icon && <Icon size={14} className={danger ? 'text-danger' : 'text-ink-2'} />}
          {label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
