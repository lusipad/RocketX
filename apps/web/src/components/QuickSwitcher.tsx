import { useEffect, useMemo, useRef, useState } from 'react';
import { tsMs, type RcMessage, type RcRoom, type RcUser } from '@rcx/rc-client';
import { Hash, Search } from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import { useUI } from '../stores/ui';
import { realtime, rest } from '../lib/client';
import { fmtConvTime } from '../lib/format';
import Avatar from './Avatar';

type Tab = 'convs' | 'messages' | 'contacts';

const TABS: { key: Tab; label: string }[] = [
  { key: 'convs', label: '会话' },
  { key: 'messages', label: '消息' },
  { key: 'contacts', label: '联系人/频道' },
];

/** 跨会话全局搜索消息：优先服务端全局搜索，失败时回退逐会话搜索 */
async function searchMessagesGlobal(
  keyword: string,
  recentRids: string[],
): Promise<RcMessage[]> {
  try {
    const result = (await realtime.call('rocketchatSearch.search', keyword, {
      rid: undefined,
    })) as { message?: { docs?: RcMessage[] } };
    const docs = result?.message?.docs ?? [];
    if (docs.length > 0) return docs;
  } catch {
    /* 服务器未开全局搜索时回退 */
  }
  const lists = await Promise.all(
    recentRids.slice(0, 8).map((rid) => rest.searchMessages(rid, keyword, 5).catch(() => [])),
  );
  return lists.flat();
}

/** 全局搜索（Ctrl/Cmd+K）：会话跳转 + 跨会话消息 + 联系人/频道 */
export default function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const openRoom = useChat((s) => s.openRoom);
  const startDM = useChat((s) => s.startDM);
  const setModule = useUI((s) => s.setModule);
  const [tab, setTab] = useState<Tab>('convs');
  const [keyword, setKeyword] = useState('');
  const [index, setIndex] = useState(0);
  const [messages, setMessages] = useState<RcMessage[]>([]);
  const [contacts, setContacts] = useState<{ users: RcUser[]; rooms: RcRoom[] }>({
    users: [],
    rooms: [],
  });
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const conversations = useMemo(
    () => buildConversations(subscriptions, rooms),
    [subscriptions, rooms],
  );
  const filteredConvs = useMemo(
    () =>
      (keyword
        ? conversations.filter((c) => c.name.toLowerCase().includes(keyword.toLowerCase()))
        : conversations
      ).slice(0, 8),
    [conversations, keyword],
  );

  useEffect(() => inputRef.current?.focus(), [tab]);
  useEffect(() => setIndex(0), [keyword, tab]);

  // 消息 / 联系人搜索（防抖）
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = keyword.trim();
    if (!q || tab === 'convs') {
      setMessages([]);
      setContacts({ users: [], rooms: [] });
      return;
    }
    timer.current = setTimeout(() => {
      setSearching(true);
      if (tab === 'messages') {
        void searchMessagesGlobal(
          q,
          conversations.map((c) => c.rid),
        )
          .then((docs) => setMessages(docs.sort((a, b) => tsMs(b.ts) - tsMs(a.ts)).slice(0, 20)))
          .finally(() => setSearching(false));
      } else {
        void rest
          .spotlight(q)
          .then((r) => setContacts({ users: r.users ?? [], rooms: r.rooms ?? [] }))
          .catch(() => setContacts({ users: [], rooms: [] }))
          .finally(() => setSearching(false));
      }
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [keyword, tab, conversations]);

  const pickConv = (rid: string) => {
    void openRoom(rid);
    setModule('messages'); // 从通讯录/工作台等模块跳转时切回消息
    onClose();
  };

  const roomName = (rid: string) =>
    subscriptions[rid]?.fname || subscriptions[rid]?.name || rooms[rid]?.fname || rooms[rid]?.name || '会话';

  const openSpotlightRoom = async (room: RcRoom) => {
    if (!subscriptions[room._id]) {
      await rest.joinChannel(room._id).catch(() => {});
    }
    void openRoom(room._id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/30 pt-[12vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-fit max-h-[70vh] w-[540px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
          <Search size={16} className="text-ink-3" />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (tab === 'convs') {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setIndex((i) => (i + 1) % Math.max(filteredConvs.length, 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setIndex((i) => (i - 1 + filteredConvs.length) % Math.max(filteredConvs.length, 1));
                } else if (e.key === 'Enter' && filteredConvs[index]) {
                  pickConv(filteredConvs[index].rid);
                }
              }
              if (e.key === 'Escape') onClose();
              if (e.key === 'Tab') {
                e.preventDefault();
                const order: Tab[] = ['convs', 'messages', 'contacts'];
                const next = order[(order.indexOf(tab) + 1) % order.length];
                setTab(next);
              }
            }}
            placeholder="搜索会话、消息、联系人（Tab 切换范围）"
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-3">Esc</kbd>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-line px-3 py-1.5">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-md px-2.5 py-1 text-xs transition ${
                tab === key ? 'bg-primary-light font-medium text-primary' : 'text-ink-2 hover:bg-fill-hover'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-40 flex-1 overflow-y-auto py-1">
          {tab === 'convs' &&
            filteredConvs.map((c, i) => (
              <button
                key={c.rid}
                onClick={() => pickConv(c.rid)}
                onMouseEnter={() => setIndex(i)}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                  i === index ? 'bg-primary-light' : ''
                }`}
              >
                <Avatar name={c.name} username={c.avatarUsername} size={28} />
                <span className="truncate text-sm text-ink">{c.name}</span>
                {c.isDiscussion && (
                  <span className="rounded bg-fill-1 px-1 text-[10px] text-ink-3">讨论</span>
                )}
                {c.unread > 0 && (
                  <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] text-white">
                    {c.unread}
                  </span>
                )}
              </button>
            ))}
          {tab === 'convs' && filteredConvs.length === 0 && (
            <div className="py-8 text-center text-sm text-ink-3">未找到匹配的会话</div>
          )}

          {tab === 'messages' && (
            <>
              {searching && <div className="py-8 text-center text-sm text-ink-3">搜索中…</div>}
              {!searching && keyword.trim() && messages.length === 0 && (
                <div className="py-8 text-center text-sm text-ink-3">没有找到相关消息</div>
              )}
              {!searching && !keyword.trim() && (
                <div className="py-8 text-center text-sm text-ink-3">输入关键词，搜索所有会话的消息</div>
              )}
              {messages.map((m) => (
                <button
                  key={m._id}
                  onClick={() => pickConv(m.rid)}
                  className="flex w-full items-start gap-3 px-4 py-2 text-left hover:bg-fill-hover"
                >
                  <Avatar name={m.u.name || m.u.username} username={m.u.username} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-ink">{m.u.name || m.u.username}</span>
                      <span className="flex items-center gap-0.5 text-[11px] text-ink-3">
                        <Hash size={10} />
                        {roomName(m.rid)}
                      </span>
                      <span className="ml-auto shrink-0 text-[11px] text-ink-3">
                        {fmtConvTime(tsMs(m.ts))}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-sm break-words text-ink-2">{m.msg}</span>
                  </span>
                </button>
              ))}
            </>
          )}

          {tab === 'contacts' && (
            <>
              {searching && <div className="py-8 text-center text-sm text-ink-3">搜索中…</div>}
              {!searching && !keyword.trim() && (
                <div className="py-8 text-center text-sm text-ink-3">输入用户名或频道名搜索</div>
              )}
              {contacts.users.length > 0 && (
                <div className="px-4 pt-2 pb-1 text-[11px] text-ink-3">联系人</div>
              )}
              {contacts.users.map((u) => (
                <button
                  key={u._id}
                  onClick={() => {
                    void startDM(u.username).then(() => {
                      setModule('messages');
                      onClose();
                    });
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-fill-hover"
                >
                  <Avatar name={u.name || u.username} username={u.username} size={28} />
                  <span className="truncate text-sm text-ink">{u.name || u.username}</span>
                  <span className="text-xs text-ink-3">@{u.username}</span>
                </button>
              ))}
              {contacts.rooms.length > 0 && (
                <div className="px-4 pt-2 pb-1 text-[11px] text-ink-3">频道</div>
              )}
              {contacts.rooms.map((r) => (
                <button
                  key={r._id}
                  onClick={() => void openSpotlightRoom(r)}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-fill-hover"
                >
                  <Avatar name={r.fname || r.name || '频道'} size={28} />
                  <span className="truncate text-sm text-ink">{r.fname || r.name}</span>
                  {!subscriptions[r._id] && (
                    <span className="ml-auto text-[11px] text-primary">点击加入</span>
                  )}
                </button>
              ))}
              {!searching &&
                keyword.trim() &&
                contacts.users.length === 0 &&
                contacts.rooms.length === 0 && (
                  <div className="py-8 text-center text-sm text-ink-3">未找到匹配结果</div>
                )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
