import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import Avatar from './Avatar';

/** Ctrl/Cmd + K 快速切换会话（飞书习惯） */
export default function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const openRoom = useChat((s) => s.openRoom);
  const [keyword, setKeyword] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const conversations = useMemo(
    () => buildConversations(subscriptions, rooms),
    [subscriptions, rooms],
  );
  const filtered = useMemo(
    () =>
      (keyword
        ? conversations.filter((c) => c.name.toLowerCase().includes(keyword.toLowerCase()))
        : conversations
      ).slice(0, 8),
    [conversations, keyword],
  );

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [keyword]);

  const pick = (rid: string) => {
    void openRoom(rid);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/30 pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="h-fit w-[480px] overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex h-12 items-center gap-2.5 border-b border-line px-4">
          <Search size={16} className="text-ink-3" />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => (i + 1) % Math.max(filtered.length, 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => (i - 1 + filtered.length) % Math.max(filtered.length, 1));
              } else if (e.key === 'Enter' && filtered[index]) {
                pick(filtered[index].rid);
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
            placeholder="输入会话名称，Enter 跳转"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-3">Esc</kbd>
        </div>
        <div className="max-h-80 overflow-y-auto py-1">
          {filtered.map((c, i) => (
            <button
              key={c.rid}
              onClick={() => pick(c.rid)}
              onMouseEnter={() => setIndex(i)}
              className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                i === index ? 'bg-primary-light' : ''
              }`}
            >
              <Avatar name={c.name} username={c.avatarUsername} size={28} />
              <span className="truncate text-sm text-ink">{c.name}</span>
              {c.unread > 0 && (
                <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] text-white">
                  {c.unread}
                </span>
              )}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="py-8 text-center text-sm text-ink-3">未找到匹配的会话</div>
          )}
        </div>
      </div>
    </div>
  );
}
