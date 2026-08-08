import { useEffect, useState } from 'react';
import type { ButlerSlashOption } from '../lib/butlerPrompts';

/**
 * 输入框里打 `/` 唤起的能力菜单。
 *
 * 选中只把例句**填进输入框**，不直接发送——例句里的人名与编号是占位符，
 * 直接发出去必然查空（找文件场景还会被追问发送人和日期）。
 */
export default function ButlerSlashMenu({
  options,
  activeIndex,
  onPick,
  onHover,
}: {
  options: readonly ButlerSlashOption[];
  activeIndex: number;
  onPick: (option: ButlerSlashOption) => void;
  onHover: (index: number) => void;
}) {
  if (options.length === 0) return null;
  return (
    <div
      role="listbox"
      aria-label="管家能做什么"
      className="absolute right-0 bottom-[calc(100%+6px)] left-0 z-10 rounded-lg bg-surface shadow-raise p-1.5 shadow-[var(--shadow-pop)]"
    >
      {options.map((option, index) => (
        <button
          key={option.scene}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => {
            // 用 mouseDown：click 会先触发输入框 blur 把菜单关掉
            event.preventDefault();
            onPick(option);
          }}
          onMouseEnter={() => onHover(index)}
          className={`flex w-full items-baseline gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
            index === activeIndex ? 'bg-fill-hover' : ''
          }`}
        >
          <span className="shrink-0 text-xs font-medium text-ink">{option.scene}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{option.prompt}</span>
        </button>
      ))}
    </div>
  );
}

/** 菜单的键盘与选中态：上下移动、回车选中、Esc 关闭 */
export function useSlashMenu<T>(options: readonly T[]) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  // 候选变了就把选中重置回第一条，否则筛完之后高亮会停在越界的位置
  useEffect(() => {
    setActiveIndex(0);
  }, [options.length]);

  const open = options.length > 0 && !dismissed;

  return {
    open,
    activeIndex,
    setActiveIndex,
    /** 输入内容变化时调用：重新打开（用户又打了 /） */
    reopen: () => setDismissed(false),
    dismiss: () => setDismissed(true),
    /** 返回 true 表示按键已被菜单消费，调用方不要再处理 */
    handleKeyDown: (event: { key: string; preventDefault: () => void }, onPick: (option: T) => void): boolean => {
      if (!open) return false;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % options.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + options.length) % options.length);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const option = options[activeIndex];
        if (!option) return false;
        event.preventDefault();
        onPick(option);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return true;
      }
      return false;
    },
  };
}
