import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { tsMs, type RcMessage, type RcRoom, type RcUser } from '@rcx/rc-client';
import { BriefcaseBusiness, CalendarDays, FileText, Hash, ListTodo, Search, SlidersHorizontal } from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { displayName, personName, useAliases } from '../stores/aliases';
import { useUI } from '../stores/ui';
import { openExternal, realtime, rest } from '../lib/client';
import { fmtConvTime, fmtSize } from '../lib/format';
import { highlightText } from '../lib/highlight';
import { pinyinMatch, pinyinScore, usePinyinReady } from '../lib/pinyin';
import {
  chooseAvailableSearchTab,
  QUICK_SEARCH_RESULT_SECTIONS,
  QUICK_SEARCH_TABS,
  searchMessagesGlobal,
  searchesSettledFor,
  type QuickSearchTab,
} from '../lib/quickSearch';
import { mergeUserSearchResults } from '../lib/userSearch';
import { commandCenterConversations } from '../lib/conversationView';
import { searchWork, type WorkSearchResult } from '../lib/workSearch';
import { useTodos } from '../stores/todos';
import { useCalendar } from '../stores/calendar';
import { useWorkbench } from '../stores/workbench';
import { useFileIndex } from '../stores/fileIndex';
import { canSearchIndexedRoom, searchIndexedFiles, type IndexedFileResult } from '../lib/fileIndex';
import {
  filterFileResults,
  filterMessageResults,
  type SearchFileType,
  type SearchResultFilters,
  type SearchTimeRange,
} from '../lib/searchFilters';
import Avatar from './Avatar';
import { useDialogBehavior } from './Dialog';

type Tab = QuickSearchTab;
type ResultTab = Exclude<Tab, 'all'>;

interface OverviewItem {
  section: ResultTab;
  key: string;
  title: string;
  detail: string;
  avatar?: { name: string; username?: string; roomId?: string };
  icon?: ReactNode;
  action: () => void;
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'convs', label: '会话' },
  { key: 'messages', label: '消息' },
  { key: 'files', label: '文件' },
  { key: 'contacts', label: '联系人/频道' },
  { key: 'work', label: '工作' },
];

const RESULT_LABELS: Record<ResultTab, string> = {
  convs: '会话',
  messages: '消息',
  files: '文件',
  contacts: '联系人/频道',
  work: '工作',
};

/** 全局搜索（Ctrl/Cmd+K）：会话、消息、联系人/频道与本机已有的工作数据。 */
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
  const todos = useTodos((s) => s.todos);
  const events = useCalendar((s) => s.events);
  const workItems = useWorkbench((s) => s.workItems);
  const fileIndex = useFileIndex((s) => s.index);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'all');
  const [keyword, setKeyword] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [senderFilter, setSenderFilter] = useState('');
  const [timeFilter, setTimeFilter] = useState<SearchTimeRange>('any');
  const [fileTypeFilter, setFileTypeFilter] = useState<SearchFileType>('any');
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
  const workResults = useMemo(
    () => searchWork(keyword, todos, events, workItems),
    [keyword, todos, events, workItems],
  );
  const filters = useMemo<SearchResultFilters>(() => ({
    sender: senderFilter,
    timeRange: timeFilter,
    fileType: fileTypeFilter,
  }), [fileTypeFilter, senderFilter, timeFilter]);
  const filteredMessages = useMemo(
    () => filterMessageResults(messages, filters),
    [filters, messages],
  );
  const rawFileResults = useMemo(
    () => searchIndexedFiles(fileIndex, keyword).filter((result) =>
      canSearchIndexedRoom(!!subscriptions[result.rid], rooms[result.rid]?.t),
    ),
    [fileIndex, keyword, rooms, subscriptions],
  );
  const fileResults = useMemo(
    () => filterFileResults(rawFileResults, filters),
    [filters, rawFileResults],
  );
  const activeFilterCount = (senderFilter.trim() ? 1 : 0) +
    (timeFilter === 'any' ? 0 : 1) +
    (fileTypeFilter === 'any' ? 0 : 1);
  const searchCounts: Record<Tab, number> = {
    all: filteredConvs.length + filteredMessages.length + fileResults.length + contactUsers.length + contacts.rooms.length + workResults.length,
    convs: filteredConvs.length,
    messages: filteredMessages.length,
    files: fileResults.length,
    contacts: contactUsers.length + contacts.rooms.length,
    work: workResults.length,
  };
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
      all: searchCounts.all,
      convs: filteredConvs.length,
      messages: filteredMessages.length,
      files: fileResults.length,
      contacts: contactUsers.length + contacts.rooms.length,
      work: workResults.length,
    });
    if (next !== tabRef.current) setTab(next);
  }, [
    keyword,
    messageSearching,
    contactSearching,
    filteredConvs.length,
    filteredMessages.length,
    fileResults.length,
    contactUsers.length,
    contacts.rooms.length,
    workResults.length,
    messageSettledKeyword,
    contactSettledKeyword,
  ]);

  // 所有范围一起搜索；远端搜索停稳后，当前范围为空时自动切到第一个有结果的范围（issue #24）。
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

  const pickFile = (result: IndexedFileResult) => {
    setModule('messages');
    void openRoom(result.rid).then(() => {
      useChat.getState().setPanel({ kind: 'files', fileId: result.file._id });
    });
    onClose();
  };

  const pickWork = (result: WorkSearchResult) => {
    if (result.kind === 'todo') {
      setModule('messages');
      void openRoom(result.item.rid).then(() => jumpToMessage(result.item.mid, result.item.rid));
    } else if (result.kind === 'event') {
      const calendar = useCalendar.getState();
      calendar.setCursor(result.item.date);
      calendar.setSelectedDate(result.item.date);
      calendar.setView('day');
      setModule('calendar');
    } else {
      const ui = useUI.getState();
      ui.setWorkbenchTab('workitems');
      ui.setModule('workbench');
      void openExternal(result.item.webUrl);
    }
    onClose();
  };

  const overviewItems: OverviewItem[] = keyword.trim()
    ? [
        ...contactUsers.slice(0, 3).map((user) => ({
          section: 'contacts' as const,
          key: `user:${user._id}`,
          title: personName(aliases, user.username, user.name || user.username, nameFormat),
          detail: `联系人 · @${user.username}`,
          avatar: {
            name: personName(aliases, user.username, user.name || user.username, nameFormat),
            username: user.username,
          },
          action: () => {
            void startDM(user.username).then(() => {
              setModule('messages');
              onClose();
            });
          },
        })),
        ...contacts.rooms.slice(0, Math.max(0, 3 - contactUsers.length)).map((room) => ({
          section: 'contacts' as const,
          key: `room:${room._id}`,
          title: room.fname || room.name || '频道',
          detail: subscriptions[room._id] ? '频道' : '频道 · 点击加入',
          avatar: { name: room.fname || room.name || '频道', roomId: room._id },
          action: () => void openSpotlightRoom(room),
        })),
        ...filteredConvs.slice(0, 3).map((conversation) => ({
          section: 'convs' as const,
          key: `conv:${conversation.rid}`,
          title: displayName(aliases, conversation, nameFormat),
          detail: conversation.unread > 0 ? `${conversation.unread} 条未读` : '会话',
          avatar: {
            name: displayName(aliases, conversation, nameFormat),
            username: conversation.avatarUsername,
            roomId: conversation.avatarUsername ? undefined : conversation.rid,
          },
          action: () => pickConv(conversation.rid),
        })),
        ...filteredMessages.slice(0, 3).map((message) => ({
          section: 'messages' as const,
          key: `message:${message._id}`,
          title: message.msg || '无文字消息',
          detail: `${message.u.name || message.u.username} · ${roomName(message.rid)}`,
          avatar: { name: message.u.name || message.u.username, username: message.u.username },
          action: () => pickMessage(message),
        })),
        ...fileResults.slice(0, 3).map((result) => ({
          section: 'files' as const,
          key: `file:${result.rid}:${result.file._id}`,
          title: result.file.name,
          detail: `文件 · ${result.roomName}${result.file.size ? ` · ${fmtSize(result.file.size)}` : ''}`,
          icon: <FileText size={16} />,
          action: () => pickFile(result),
        })),
        ...workResults.slice(0, 3).map((result) => ({
          section: 'work' as const,
          key: `${result.kind}:${result.item.id}`,
          title: result.kind === 'todo'
            ? result.item.note || result.item.excerpt
            : result.kind === 'event'
              ? result.item.title
              : `#${result.item.id} ${result.item.title}`,
          detail: result.kind === 'todo'
            ? `待办 · ${result.item.roomName}`
            : result.kind === 'event'
              ? `日程 · ${result.item.date}`
              : `工作项 · ${result.item.project} · ${result.item.state}`,
          icon: result.kind === 'todo'
            ? <ListTodo size={16} />
            : result.kind === 'event'
              ? <CalendarDays size={16} />
              : <BriefcaseBusiness size={16} />,
          action: () => pickWork(result),
        })),
      ]
    : filteredConvs.map((conversation) => ({
        section: 'convs' as const,
        key: `conv:${conversation.rid}`,
        title: displayName(aliases, conversation, nameFormat),
        detail: conversation.unread > 0 ? `${conversation.unread} 条未读` : '最近会话',
        avatar: {
          name: displayName(aliases, conversation, nameFormat),
          username: conversation.avatarUsername,
          roomId: conversation.avatarUsername ? undefined : conversation.rid,
        },
        action: () => pickConv(conversation.rid),
      }));

  /** 统一的键盘导航：所有 tab 都能用方向键 + Enter */
  const currentItems: (() => void)[] =
    tab === 'all'
      ? overviewItems.map((item) => item.action)
      : tab === 'convs'
        ? filteredConvs.map((c) => () => pickConv(c.rid))
        : tab === 'messages'
          ? filteredMessages.map((m) => () => pickMessage(m))
          : tab === 'files'
            ? fileResults.map((result) => () => pickFile(result))
            : tab === 'contacts'
              ? [
                  ...contactUsers.map((u) => () => {
                    void startDM(u.username).then(() => {
                      setModule('messages');
                      onClose();
                    });
                  }),
                  ...contacts.rooms.map((r) => () => void openSpotlightRoom(r)),
                ]
              : workResults.map((result) => () => pickWork(result));

  function roomName(rid: string): string {
    return subscriptions[rid]?.fname || subscriptions[rid]?.name || rooms[rid]?.fname || rooms[rid]?.name || '会话';
  }

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
                const order = QUICK_SEARCH_TABS;
                const dir = e.shiftKey ? -1 : 1;
                setTab(order[(order.indexOf(tab) + dir + order.length) % order.length]);
              }
            }}
            placeholder={
              commandCenter
                ? '直接回车打开下一条未读，或输入内容搜索'
                : '搜索会话、消息、文件、联系人和工作（Tab 切换范围）'
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
              {!!keyword.trim() && !messageSearching && !contactSearching && (
                <span className="ml-1 text-2xs opacity-70">{searchCounts[key]}</span>
              )}
            </button>
          ))}
          <button
            onClick={() => setFiltersOpen((open) => !open)}
            className={`ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs transition ${
              filtersOpen || activeFilterCount > 0
                ? 'bg-primary-light font-medium text-primary'
                : 'text-ink-2 hover:bg-fill-hover'
            }`}
          >
            <SlidersHorizontal size={13} />
            筛选{activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}
          </button>
        </div>

        {filtersOpen && (
          <div className="grid shrink-0 grid-cols-[1fr_auto_auto_auto] items-end gap-2 border-b border-line bg-fill-1/50 px-4 py-2.5">
            <label className="text-2xs text-ink-3">
              发送人
              <input
                value={senderFilter}
                onChange={(event) => setSenderFilter(event.target.value)}
                placeholder="姓名或用户名"
                className="mt-1 block h-7 w-full rounded border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
              />
            </label>
            <label className="text-2xs text-ink-3">
              时间
              <select
                value={timeFilter}
                onChange={(event) => setTimeFilter(event.target.value as SearchTimeRange)}
                className="mt-1 block h-7 rounded border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
              >
                <option value="any">不限</option>
                <option value="7d">近 7 天</option>
                <option value="30d">近 30 天</option>
                <option value="365d">近一年</option>
              </select>
            </label>
            <label className="text-2xs text-ink-3">
              文件类型
              <select
                value={fileTypeFilter}
                onChange={(event) => setFileTypeFilter(event.target.value as SearchFileType)}
                className="mt-1 block h-7 rounded border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
              >
                <option value="any">不限</option>
                <option value="image">图片</option>
                <option value="document">文档</option>
                <option value="archive">压缩包</option>
                <option value="other">其他</option>
              </select>
            </label>
            <button
              onClick={() => {
                setSenderFilter('');
                setTimeFilter('any');
                setFileTypeFilter('any');
              }}
              disabled={activeFilterCount === 0}
              className="h-7 rounded px-2 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-40"
            >
              清除
            </button>
            <div className="col-span-4 text-2xs text-ink-3">
              筛选当前命中的消息和已索引文件，不会扩大服务器搜索范围
            </div>
          </div>
        )}

        <div className="min-h-40 flex-1 overflow-y-auto py-1">
          {tab === 'all' && (
            <>
              {!keyword.trim() && commandCenter && (
                <div className="px-4 py-1.5 text-2xs text-ink-3">
                  {conversations.some((item) => item.unread > 0 || item.alert)
                    ? '未读会话 · 回车打开第一条'
                    : '暂无未读 · 显示最近会话'}
                </div>
              )}
              {keyword.trim() && (messageSearching || contactSearching) && (
                <div className="px-4 py-1.5 text-2xs text-ink-3">正在补全远端结果…</div>
              )}
              {QUICK_SEARCH_RESULT_SECTIONS.map((section) => {
                const items = overviewItems.filter((item) => item.section === section);
                if (items.length === 0) return null;
                return (
                  <div key={section}>
                    <div className="flex items-center justify-between px-4 pt-2 pb-1 text-2xs text-ink-3">
                      <span>{RESULT_LABELS[section]}</span>
                      {!!keyword.trim() && searchCounts[section] > items.length && (
                        <button className="text-primary hover:underline" onClick={() => setTab(section)}>
                          查看全部 {searchCounts[section]}
                        </button>
                      )}
                    </div>
                    {items.map((item) => {
                      const idx = overviewItems.indexOf(item);
                      return (
                        <button
                          key={item.key}
                          onClick={item.action}
                          onMouseEnter={() => setIndex(idx)}
                          className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                            idx === index ? 'bg-primary-light' : 'hover:bg-fill-hover'
                          }`}
                        >
                          {item.avatar ? (
                            <Avatar
                              name={item.avatar.name}
                              username={item.avatar.username}
                              roomId={item.avatar.roomId}
                              size={28}
                            />
                          ) : (
                            <span className="flex h-7 w-7 items-center justify-center text-ink-3">{item.icon}</span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-ink">
                              {highlightText(item.title, keyword)}
                            </span>
                            <span className="block truncate text-2xs text-ink-3">{item.detail}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {keyword.trim() &&
                !messageSearching &&
                !contactSearching &&
                !messageError &&
                !contactError &&
                overviewItems.length === 0 && (
                  <div className="py-8 text-center text-sm text-ink-3">未找到匹配结果</div>
                )}
              {keyword.trim() && !messageSearching && !contactSearching && (messageError || contactError) && (
                <div className="px-4 py-2 text-2xs text-warning">部分远端结果暂时不可用</div>
              )}
            </>
          )}
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
                <Avatar
                  name={displayName(aliases, c, nameFormat)}
                  username={c.avatarUsername}
                  roomId={c.avatarUsername ? undefined : c.rid}
                  size={28}
                />
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
              {!messageSearching && !messageError && keyword.trim() && filteredMessages.length === 0 && (
                <div className="py-8 text-center text-sm text-ink-3">
                  {messages.length > 0 && activeFilterCount > 0 ? '当前筛选条件下没有消息' : '没有找到相关消息'}
                </div>
              )}
              {!messageSearching && !messageError && !keyword.trim() && (
                <div className="py-8 text-center text-sm text-ink-3">输入关键词，搜索所有会话的消息</div>
              )}
              {filteredMessages.map((m, i) => (
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

          {tab === 'files' && (
            <>
              <div className="px-4 py-1.5 text-2xs text-ink-3">
                已索引最近打开过文件面板的 {fileIndex.rooms.length} 个会话
              </div>
              {!keyword.trim() && (
                <div className="py-8 text-center text-sm text-ink-3">输入文件名搜索已索引文件</div>
              )}
              {keyword.trim() && fileResults.length === 0 && (
                <div className="py-8 text-center text-sm text-ink-3">
                  {fileIndex.rooms.length === 0
                    ? '先在会话中打开文件面板，文件会自动加入本机索引'
                    : rawFileResults.length > 0 && activeFilterCount > 0
                      ? '当前筛选条件下没有文件'
                      : '已索引的文件中没有匹配结果'}
                </div>
              )}
              {fileResults.map((result, i) => (
                <button
                  key={`${result.rid}:${result.file._id}`}
                  onClick={() => pickFile(result)}
                  onMouseEnter={() => setIndex(i)}
                  className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                    i === index ? 'bg-primary-light' : 'hover:bg-fill-hover'
                  }`}
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-fill-1 text-ink-3">
                    <FileText size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">
                      {highlightText(result.file.name, keyword)}
                    </span>
                    <span className="block truncate text-2xs text-ink-3">
                      {[
                        result.roomName,
                        result.file.user?.name || result.file.user?.username,
                        fmtSize(result.file.size),
                        result.file.uploadedAt ? fmtConvTime(tsMs(result.file.uploadedAt)) : '',
                      ].filter(Boolean).join(' · ')}
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
                  <Avatar name={r.fname || r.name || '频道'} roomId={r._id} size={28} />
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

          {tab === 'work' && (
            <>
              {!keyword.trim() && (
                <div className="py-8 text-center text-sm text-ink-3">输入关键词，搜索待办、日程和工作项</div>
              )}
              {keyword.trim() && workResults.length === 0 && (
                <div className="py-8 text-center text-sm text-ink-3">未找到匹配的工作内容</div>
              )}
              {workResults.map((result, i) => {
                const icon = result.kind === 'todo'
                  ? <ListTodo size={16} />
                  : result.kind === 'event'
                    ? <CalendarDays size={16} />
                    : <BriefcaseBusiness size={16} />;
                const title = result.kind === 'todo'
                  ? result.item.note || result.item.excerpt
                  : result.kind === 'event'
                    ? result.item.title
                    : `#${result.item.id} ${result.item.title}`;
                const detail = result.kind === 'todo'
                  ? `待办 · ${result.item.roomName}`
                  : result.kind === 'event'
                    ? `日程 · ${result.item.date}`
                    : `工作项 · ${result.item.project} · ${result.item.state}`;
                return (
                  <button
                    key={`${result.kind}:${result.item.id}`}
                    onClick={() => pickWork(result)}
                    onMouseEnter={() => setIndex(i)}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                      i === index ? 'bg-primary-light' : 'hover:bg-fill-hover'
                    }`}
                  >
                    <span className="text-ink-3">{icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">{highlightText(title, keyword)}</span>
                      <span className="block truncate text-2xs text-ink-3">{detail}</span>
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
