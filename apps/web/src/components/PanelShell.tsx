import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useChat } from '../stores/chat';

/** 右侧面板统一外壳：标题 + 关闭按钮 */
export default function PanelShell({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  const setPanel = useChat((s) => s.setPanel);
  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-line bg-surface-3">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
        <span className="text-[15px] font-semibold text-ink">{title}</span>
        <button
          onClick={() => setPanel(null)}
          className="flex h-8 w-8 items-center justify-center rounded-md text-ink-2 transition hover:bg-fill-hover"
        >
          <X size={17} />
        </button>
      </header>
      {children}
    </aside>
  );
}
