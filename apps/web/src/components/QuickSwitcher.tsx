import { useEffect, useMemo, useRef, useState } from 'react';
import { tsMs, type RcMessage, type RcRoom, type RcUser } from '@rcx/rc-client';
import { Hash, Search } from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { displayName, personName, useAliases } from '../stores/aliases';
import { useUI } from '../stores/ui';
import { realtime, rest } from '../lib/client';
import { fmtConvTime } from '../lib/format';
import { highlightText } from '../lib/highlight';
import { pinyinMatch, pinyinScore, usePinyinReady } from '../lib/pinyin';
import {
  chooseAvailableSearchTab,
  searchMessagesGlobal,
  searchesSettledFor,
  type QuickSearchTab,
} from '../lib/quickSearch';
import { mergeUserSearchResults } from '../lib/userSearch';
import { commandCenterConversations } from '../lib/conversationView';
import Avatar from './Avatar';
import { useDialogBehavior } from './Dialog';

type Tab = QuickSearchTab;

const TABS: { key: Tab; label: string }[] = [
  { key: 'convs', label: '会话' },
  { key: 'messages', label: '消息' },
  { key: 'contacts', label: '联系人/频道' },
];

/** 全局搜索（Ctrl/Cmd+K）：会话跳转 + 跨会话消息 + 联系人/频道 */
export default function QuickSwitcher({
  onClose,
  initialTab,
  commandCenter = false,
}: {
  onClose: () => void;
  initialTab?: Tab;
  commandCenter?: boolean;
}) {
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const openRoom = useChat((s) => s.openRoom);
  const startDM = useChat((s) => s.startDM);
  const setModule = useUI((s) => s.setModule);
  const setConvFilter = useUI((s) => s.setConvFilter);
  const retainUnread = useUI((s) => s.retainUnread);
  const me = useAuth((s) => s.user?.username);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'convs');
  const [keyword, setKeyword] = useState('');
  const [index, setIndex] = useState(0);
  const [messages, setMessages] = useState<RcMessage[]>([]);
  const [contacts, setContacts] = useState<{ users: RcUser[]; rooms: RcRoom[] }>({
    users: [],
    rooms: [],
  });
  const [contactRoster, setContactRoster] = useState<RcUser[]>([]);
  const [messageSearching, setMessageSearching] = useState(false);
  const [contactSearching, setContactSearching] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);
  const [messageSettledKeyword, setMessageSettledKeyword] = useState('');
  const [contactSettledKeyword, setContactSettledKeyword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabRef = useRef(tab);
  const dialogRef = useDialogBehavior(onClose);

  const conversations = useMemo(
    () => buildConversations(subscriptions, rooms),
    [subscriptions, rooms],
  );
  // 会话名多为中文，支持拼音全拼与首字母（「核心项目」← hxxm / hexinxiangmu）。
  // 备注名也参与匹配，否则「给人起了备注却搜不到」。
  const pinyinReady = usePinyinReady();
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const filteredConvs = useMemo(
    () =>
      (keyword
        ? conversations
            .filter((c) => pinyinMatch(keyword, displayName(aliases, c, nameFormat), c.name))
            .sort(
              (a, b) =>
                pinyinScore(keyword, displayName(aliases, a, nameFormat)) -
                pinyinScore(keyword, displayName(aliases, b, nameFormat)),
            )
        : commandCenter
          ? commandCenterConversations(conversations)
          : conversations
      ).slice(0, 8),
    [conversations, keyword, aliases, nameFormat, pinyinReady, commandCenter],
  );
  const contactUsers = useMemo(
    () =>
      keyword.trim()
        ? mergeUserSearchResults(
            keyword,
            contactRoster,
            contacts.users,
            (user) => personName(aliases, user.username, user.name || user.username, nameFormat),
          )
        : [],
    [keyword, contactRoster, contacts.users, aliases, nameFormat, pinyinReady],
  );
  const conversationScope = useMemo(
    () => [...new Set(conversations.map((conversation) => conversation.rid))].sort().join('\0'),
    [conversations],
  );
  const conversationRidsRef = useRef<string[]>([]);
  conversationRidsRef.current = conversations.map((conversation) => conversation.rid);

  useEffect(() => inputRef.current?.focus(), [tab]);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  useEffect(() => setIndex(0), [keyword, tab]);
  useEffect(() => {
    let cancelled = false;
    void rest
      .searchUsers('', 100)
      .then(({ users }) => {
        if (!cancelled) setContactRoster(users.filter((user) => user.username !== me));
      })
      .catch(() => {
        if (!cancelled) setContactRoster([]);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);

  useEffect(() => {
    if (
      messageSearching ||
      contactSearching ||
      !searchesSettledFor(keyword, messageSettledKeyword, contactSettledKeyword)
    ) {
      return;
    }
    const next = chooseAvailableSearchTab(tabRef.current, {
      convs: filteredConvs.length,
      messages: messages.length,
      contacts: contactUsers.length + contacts.rooms.length,
    });
    if (next !== tabRef.current) setTab(next);
  }, [
    keyword,
    messageSearching,
    contactSearching,
    filteredConvs.length,
    messages.length,
    contactUsers.length,
    contacts.rooms.length,
    messageSettledKeyword,
    contactSettledKeyword,
  ]);

  // 三个范围一起搜索；停稳后当前范围为空时，自动切到第一个有结果的范围（issue #24）。
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = keyword.trim();
    if (!q) {
      setMessages([]);
      setContacts({ users: [], rooms: [] });
      setMessageSearching(false);
      setContactSearching(false);
      setMessageError(null);
      setContactError(null);
      setMessageSettledKeyword('');
      setContactSettledKeyword('');
      return;
    }
    let cancelled = false;
    setMessages([]);
    setContacts({ users: [], rooms: [] });
    setMessageSearching(true);
    setContactSearching(true);
    setMessageError(null);
    setContactError(null);
    timer.current = setTimeout(() => {
      void searchMessagesGlobal(
        q,
        conversationRidsRef.current,
        {
          global: (keyword) => realtime.call('rocketchatSearch.search', keyword, { rid: undefined }),
          room: (rid, keyword) => rest.searchMessages(rid, keyword, 5),
        },
        () => !cancelled,
      )
        .then((messageDocs) => {
          if (cancelled) return;
          const nextMessages = messageDocs
            .sort((a, b) => tsMs(b.ts) - tsMs(a.ts))
            .slice(0, 20);
          setMessages(nextMessages);
          setMessageSearching(false);
          setMessageSettledKeyword(q);
        })
        .catch(() => {
          if (cancelled) return;
          setMessageSearching(false);
          setMessageError('消息搜索暂时不可用，请稍后重试');
          setMessageSettledKeyword(q);
        });

      void rest
        .spotlight(q)
        .then((found) => {
          if (cancelled) return;
          const nextContacts = {
            users: (found.users ?? []).filter((user) => user.username !== me),
            rooms: found.rooms ?? [],
          };
          setContacts(nextContacts);
          setContactSearching(false);
          setContactSettledKeyword(q);
        })
        .catch(() => {
          if (cancelled) return;
          setContactSearching(false);
          setContactError('联系人和频道搜索暂时不可用，请稍后重试');
          setContactSettledKeyword(q);
        });
    }, 300);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [keyword, conversationScope, me]);

  const jumpToMessage = useChat((s) => s.jumpToMessage);

  const pickConv = (rid: string) => {
    const conversation = conversations.find((item) => item.rid === rid);
    if (commandCenter && conversation && (conversation.unread > 0 || conversation.alert)) {
      setConvFilter('unread');
      retainUnread(rid);
    }
    void openRoom(rid);
    setModule('messages'); // 从通讯录/工作台等模块跳转时切回消息
    onClose();
  };

  /** 消息结果：跳转到该消息并高亮 */
  const pickMessage = (m: RcMessage) => {
    setModule('messages');
    void jumpToMessage(m._id, m.rid);
    onClose();
  };

  /** 统一的键盘导航：三个 tab 都能用方向键 + Enter */
  const currentItems: (() => void)[] =
    tab === 'convs'
      ? filteredConvs.map((c) => () => pickConv(c.rid))
      : tab === 'messages'
        ? messages.map((m) => () => pickMessage(m))
        : [
            ...contactUsers.map((u) => () => {
              void startDM(u.username).then(() => {
                setModule('messages');
                onClose();
              });
            }),
            ...contacts.rooms.map((r) => () => void openSpotlightRoom(r)),
          ];

  const roomName = (rid: string) =>
    subscriptions[rid]?.fname || subscriptions[rid]?.name || rooms[rid]?.fname || rooms[rid]?.name || '会话';

  const openSpotlightRoom = async (room: RcRoom) => {
    if (!subscriptions[room._id]) {
      await rest.joinChannel(room._id).catch(() => {});
    }
    setModule('messages');
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
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={commandCenter ? '全局指令中心' : '全局搜索'}
        tabIndex={-1}
        className="flex h-fit max-h-[70vh] w-[540px] flex-col overflow-hidden rounded-xl bg-surface-4 shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
          <Search size={16} className="text-ink-3" />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              const n = currentItems.length;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => (n ? (i + 1) % n : 0));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => (n ? (i - 1 + n) % n : 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                currentItems[index]?.();
              } else if (e.key === 'Escape') {
                onClose();
              } else if (e.key === 'Tab') {
                e.preventDefault();
                const order: Tab[] = ['convs', 'messages', 'contacts'];
                const dir = e.shiftKey ? -1 : 1;
                setTab(order[(order.indexOf(tab) + dir + order.length) % order.length]);
              }
            }}
            placeholder={
              commandCenter
                ? '直接回车打开下一条未读，或输入内容搜索'
                : '搜索会话、消息、联系人（Tab 切换范围）'
            }
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded border border-line px-1.5 py-0.5 text-2xs text-ink-3">Esc</kbd>
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
          {commandCenter && tab === 'convs' && !keyword.trim() && (
            <div className="px-4 py-1.5 text-2xs text-ink-3">
              {conversations.some((item) => item.unread > 0 || item.alert)
                ? '未读会话 · 回车打开第一条'
                : '暂无未读 · 显示最近会话'}
            </div>
          )}
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
                <Avatar name={displayName(aliases, c, nameFormat)} username={c.avatarUsername} size={28} />
                <span className="truncate text-sm text-ink">{displayName(aliases, c, nameFormat)}</span>
                {c.isDiscussion && (
                  <span className="rounded bg-fill-1 px-1 text-2xs text-ink-3">讨论</span>
                )}
                {c.unread > 0 && (
                  <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-2xs text-white">
                    {c.unread}
                  </span>
                )}
                {c.unread === 0 && c.alert && (
                  <span className="ml-auto h-2 w-2 rounded-full bg-danger" />
                )}
              </button>
            ))}
          {tab === 'convs' && filteredConvs.length === 0 && (
            <div className="py-8 text-center text-sm text-ink-3">
              {messageSearching || contactSearching ? '正在搜索其它范围…' : '未找到匹配的会话'}
            </div>
          )}

          {tab === 'messages' && (
            <>
              {messageSearching && <div className="py-8 text-center text-sm text-ink-3">搜索中…</div>}
              {!messageSearching && messageError && (
                <div className="py-8 text-center text-sm text-danger">{messageError}</div>
              )}
              {!messageSearching && !messageError && keyword.trim() && messages.length === 0 && (
                <div className="py-8 text-center text-sm text-ink-3">没有找到相关消息</div>
              )}
              {!messageSearching && !messageError && !keyword.trim() && (
                <div className="py-8 text-center text-sm text-ink-3">输入关键词，搜索所有会话的消息</div>
              )}
              {messages.map((m, i) => (
                <button
                  key={m._id}
                  onClick={() => pickMessage(m)}
                  onMouseEnter={() => setIndex(i)}
                  className={`flex w-full items-start gap-3 px-4 py-2 text-left ${
                    i === index ? 'bg-primary-light' : 'hover:bg-fill-hover'
                  }`}
                >
                  <Avatar name={m.u.name || m.u.username} username={m.u.username} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="text-xs font-medium text-ink">{m.u.name || m.u.username}</span>
                      <span className="flex items-center gap-0.5 text-2xs text-ink-3">
                        <Hash size={10} />
                        {roomName(m.rid)}
                      </span>
                      <span className="ml-auto shrink-0 text-2xs text-ink-3">
                        {fmtConvTime(tsMs(m.ts))}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-sm break-words text-ink-2">
                      {highlightText(m.msg ?? '', keyword)}
                    </span>
                  </span>
                </button>
              ))}
            </>
          )}

          {tab === 'contacts' && (
            <>
              {contactSearching && <div className="py-8 text-center text-sm text-ink-3">搜索中…</div>}
              {!contactSearching &&
                contactError &&
                contactUsers.length === 0 &&
                contacts.rooms.length === 0 && (
                  <div className="py-8 text-center text-sm text-danger">{contactError}</div>
                )}
              {!contactSearching && !contactError && !keyword.trim() && (
                <div className="py-8 text-center text-sm text-ink-3">输入用户名或频道名搜索</div>
              )}
              {contactUsers.length > 0 && (
                <div className="px-4 pt-2 pb-1 text-2xs text-ink-3">联系人</div>
              )}
              {contactUsers.map((u, i) => {
                const shown = personName(aliases, u.username, u.name || u.username, nameFormat);
                return (
                <button
                  key={u._id}
                  onClick={() => {
                    void startDM(u.username).then(() => {
                      setModule('messages');
                      onClose();
                    });
                  }}
                  onMouseEnter={() => setIndex(i)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                    i === index ? 'bg-primary-light' : 'hover:bg-fill-hover'
                  }`}
                >
                  <Avatar name={shown} username={u.username} size={28} />
                  <span className="truncate text-sm text-ink">{shown}</span>
                  <span className="text-xs text-ink-3">@{u.username}</span>
                </button>
                );
              })}
              {contacts.rooms.length > 0 && (
                <div className="px-4 pt-2 pb-1 text-2xs text-ink-3">频道</div>
              )}
              {contacts.rooms.map((r, i) => {
                const idx = contactUsers.length + i;
                return (
                <button
                  key={r._id}
                  onClick={() => void openSpotlightRoom(r)}
                  onMouseEnter={() => setIndex(idx)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                    idx === index ? 'bg-primary-light' : 'hover:bg-fill-hover'
                  }`}
                >
                  <Avatar name={r.fname || r.name || '频道'} size={28} />
                  <span className="truncate text-sm text-ink">{r.fname || r.name}</span>
                  {!subscriptions[r._id] && (
                    <span className="ml-auto text-2xs text-primary">点击加入</span>
                  )}
                </button>
                );
              })}
              {!contactSearching &&
                !contactError &&
                keyword.trim() &&
                contactUsers.length === 0 &&
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
