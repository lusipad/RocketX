import { useEffect, useMemo, useRef, useState, type ReactNode, type UIEvent } from 'react';
import { tsMs, type RcMessage, type RcRoom, type RcUser } from '@rcx/rc-client';
import { BriefcaseBusiness, CalendarDays, FileText, Hash, ListTodo, Search, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useI18n, type MessageKey } from '../i18n';
import { buildConversations, useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { displayName, personName, useAliases } from '../stores/aliases';
import { useUI } from '../stores/ui';
import { getServerBase, openExternal, realtime, rest } from '../lib/client';
import { fmtConvTime, fmtSize } from '../lib/format';
import { highlightText } from '../lib/highlight';
import { pinyinMatch, pinyinScore, usePinyinReady } from '../lib/pinyin';
import {
  chooseAvailableSearchTab,
  MESSAGE_SEARCH_PAGE_SIZE,
  QUICK_SEARCH_RESULT_SECTIONS,
  QUICK_SEARCH_TABS,
  mergeMessageSearchResults,
  searchMessagesCached,
  searchMessagesGlobal,
  searchMoreMessages,
  searchLoadedMessages,
  resolveMatchedMemberName,
  searchesSettledFor,
  type MessageSearchSource,
  type QuickSearchTab,
} from '../lib/quickSearch';
import { loadUserSearchRoster, mergeUserSearchResults } from '../lib/userSearch';
import { commandCenterConversations } from '../lib/conversationView';
import { searchWork, type WorkSearchResult } from '../lib/workSearch';
import { useTodos } from '../stores/todos';
import { useCalendar } from '../stores/calendar';
import { useWorkbench } from '../stores/workbench';
import { useFileIndex } from '../stores/fileIndex';
import { canSearchIndexedRoom, searchIndexedFiles, type IndexedFileResult } from '../lib/fileIndex';
import { stripAgentSessionMarker } from '../agent/card';
import {
  filterFileResults,
  filterMessageResults,
  type SearchFileType,
  type SearchResultFilters,
  type SearchTimeRange,
} from '../lib/searchFilters';
import { focusComposerInput } from '../lib/focus';
import { handoffToButlerTask } from '../lib/butlerTaskHandoff';
import { runtimeFeatures } from '../lib/runtimeMode';
import { toast } from '../stores/toast';
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

const TAB_LABEL_KEYS: Record<Tab, MessageKey> = {
  all: 'nav.search.tab.all',
  convs: 'nav.search.tab.convs',
  messages: 'nav.search.tab.messages',
  files: 'nav.search.tab.files',
  contacts: 'nav.search.tab.contacts',
  work: 'nav.search.tab.work',
};

const RESULT_LABEL_KEYS: Record<ResultTab, MessageKey> = {
  convs: 'nav.search.tab.convs',
  messages: 'nav.search.tab.messages',
  files: 'nav.search.tab.files',
  contacts: 'nav.search.tab.contacts',
  work: 'nav.search.tab.work',
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
  const { t, tp } = useI18n();
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const activeRid = useChat((s) => s.activeRid);
  const openRoom = useChat((s) => s.openRoom);
  const startDM = useChat((s) => s.startDM);
  const setModule = useUI((s) => s.setModule);
  const setConvFilter = useUI((s) => s.setConvFilter);
  const retainUnread = useUI((s) => s.retainUnread);
  const me = useAuth((s) => s.user?.username);
  const myId = useAuth((s) => s.user?._id);
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
  const [contactRosterWarning, setContactRosterWarning] = useState<string | null>(null);
  const [messageSearching, setMessageSearching] = useState(false);
  const [messageLoadingMore, setMessageLoadingMore] = useState(false);
  const [messageHasMore, setMessageHasMore] = useState(false);
  const [messageLoadMoreError, setMessageLoadMoreError] = useState(false);
  const [visibleMessageCount, setVisibleMessageCount] = useState(MESSAGE_SEARCH_PAGE_SIZE);
  const [contactSearching, setContactSearching] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);
  const [messageSettledKeyword, setMessageSettledKeyword] = useState('');
  const [contactSettledKeyword, setContactSettledKeyword] = useState('');
  const [messageSearchAllKeyword, setMessageSearchAllKeyword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchProviderRef = useRef<Promise<unknown> | null>(null);
  const messageSearchSourceRef = useRef<MessageSearchSource | null>(null);
  const messageSearchPageRef = useRef(0);
  const messageSearchRequestRef = useRef('');
  const tabRef = useRef(tab);
  const dialogRef = useDialogBehavior(onClose);
  const shouldLoadContactRoster = tab === 'contacts' || !!keyword.trim();

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
    [keyword, todos, events, workItems, pinyinReady],
  );
  const filters = useMemo<SearchResultFilters>(() => ({
    sender: senderFilter,
    timeRange: timeFilter,
    fileType: fileTypeFilter,
  }), [fileTypeFilter, senderFilter, timeFilter]);
  const filteredMessages = useMemo(
    () => filterMessageResults(messages, filters),
    [filters, messages, pinyinReady],
  );
  const shownMessages = useMemo(
    () => filteredMessages.slice(0, visibleMessageCount),
    [filteredMessages, visibleMessageCount],
  );
  const rawFileResults = useMemo(
    () => searchIndexedFiles(fileIndex, keyword).filter((result) =>
      canSearchIndexedRoom(!!subscriptions[result.rid], rooms[result.rid]?.t),
    ),
    [fileIndex, keyword, rooms, subscriptions, pinyinReady],
  );
  const fileResults = useMemo(
    () => filterFileResults(rawFileResults, filters),
    [filters, rawFileResults, pinyinReady],
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
  const messageSearchRids = useMemo(() => {
    const recent = conversations.map((conversation) => conversation.rid);
    const seen = new Set(recent);
    return [
      ...recent,
      ...Object.keys(subscriptions).filter((rid) => !seen.has(rid)).sort(),
    ];
  }, [conversations, subscriptions]);
  const conversationScope = useMemo(
    () => Object.keys(subscriptions).sort().join('\0'),
    [subscriptions],
  );
  const conversationRidsRef = useRef<string[]>([]);
  conversationRidsRef.current = messageSearchRids;

  const messageSearchBackend = () => ({
    provider: () => {
      searchProviderRef.current ??= realtime.call('rocketchatSearch.getProvider');
      return searchProviderRef.current;
    },
    global: (searchKeyword: string, limit: number, searchAll: boolean) =>
      realtime.call(
        'rocketchatSearch.search',
        searchKeyword,
        { uid: myId, rid: activeRid ?? conversationRidsRef.current[0] ?? '' },
        { limit, searchAll },
      ),
    room: (rid: string, searchKeyword: string, offset: number, count: number) =>
      rest.searchMessages(rid, searchKeyword, count, offset),
  });

  useEffect(() => inputRef.current?.focus(), [tab]);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  useEffect(() => setIndex(0), [keyword, tab]);
  useEffect(() => {
    if (!shouldLoadContactRoster) return;
    let cancelled = false;
    void loadUserSearchRoster(
      (offset) => rest.searchUsers('', 100, offset),
      {
        cacheKey: `${getServerBase()}\0${me ?? ''}`,
        isCurrent: () => !cancelled,
        onFirstPage: (users) => {
          setContactRoster(users.filter((user) => user.username !== me));
        },
      },
    )
      .then((result) => {
        if (!cancelled) {
          setContactRoster(result.users.filter((user) => user.username !== me));
          setContactRosterWarning(result.warning ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContactRoster([]);
          setContactRosterWarning(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [me, shouldLoadContactRoster]);

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
      messageSearchRequestRef.current = '';
      messageSearchSourceRef.current = null;
      messageSearchPageRef.current = 0;
      setMessages([]);
      setContacts({ users: [], rooms: [] });
      setMessageSearching(false);
      setMessageLoadingMore(false);
      setMessageHasMore(false);
      setMessageLoadMoreError(false);
      setVisibleMessageCount(MESSAGE_SEARCH_PAGE_SIZE);
      setContactSearching(false);
      setMessageError(null);
      setContactError(null);
      setMessageSettledKeyword('');
      setContactSettledKeyword('');
      return;
    }
    let cancelled = false;
    const searchAllMessages = messageSearchAllKeyword === q;
    const requestKey = `${q}\0${searchAllMessages ? 'all' : 'current'}`;
    messageSearchRequestRef.current = requestKey;
    messageSearchSourceRef.current = null;
    messageSearchPageRef.current = 0;
    const currentRid = activeRid ?? conversationRidsRef.current[0];
    const searchRids = searchAllMessages
      ? conversationRidsRef.current
      : currentRid
        ? [currentRid]
        : [];
    const localMessages = searchLoadedMessages(
      q,
      useChat.getState().messages,
      (rid) => canSearchIndexedRoom(!!subscriptions[rid], rooms[rid]?.t),
    );
    setMessages(localMessages);
    setVisibleMessageCount(MESSAGE_SEARCH_PAGE_SIZE);
    setContacts({ users: [], rooms: [] });
    setMessageSearching(true);
    setMessageLoadingMore(false);
    setMessageHasMore(false);
    setMessageLoadMoreError(false);
    setContactSearching(true);
    setMessageError(null);
    setContactError(null);
    timer.current = setTimeout(() => {
      const searchScope = searchAllMessages ? `all:${conversationScope}` : `room:${currentRid ?? ''}`;
      const cacheKey = `${getServerBase()}\0${myId ?? ''}\0${searchScope}\0${q}`;
      void searchMessagesCached(
        cacheKey,
        () =>
          searchMessagesGlobal(
            q,
            searchRids,
            messageSearchBackend(),
            () => !cancelled && messageSearchRequestRef.current === requestKey,
            (partialResult) => {
              if (!cancelled && messageSearchRequestRef.current === requestKey) {
                messageSearchSourceRef.current = partialResult.source;
                messageSearchPageRef.current = partialResult.page;
                setMessageHasMore(partialResult.hasMore);
                setMessages(mergeMessageSearchResults(localMessages, partialResult.messages));
              }
            },
            { searchAll: searchAllMessages },
          ),
        () => !cancelled && messageSearchRequestRef.current === requestKey,
      )
        .then((result) => {
          if (cancelled || messageSearchRequestRef.current !== requestKey) return;
          messageSearchSourceRef.current = result.source;
          messageSearchPageRef.current = result.page;
          setMessageHasMore(result.hasMore);
          const nextMessages = mergeMessageSearchResults(localMessages, result.messages);
          setMessages(nextMessages);
          setMessageSearching(false);
          setMessageSettledKeyword(q);
        })
        .catch(() => {
          if (cancelled || messageSearchRequestRef.current !== requestKey) return;
          setMessageSearching(false);
          setMessageError(t('nav.search.messageSearchUnavailable'));
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
          setContactError(t('nav.search.contactSearchUnavailable'));
          setContactSettledKeyword(q);
        });
    }, 300);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [keyword, conversationScope, me, myId, activeRid, messageSearchAllKeyword]);

  const loadMoreMessages = () => {
    if (tab !== 'messages') return;
    if (visibleMessageCount < filteredMessages.length) {
      setVisibleMessageCount((count) =>
        Math.min(count + MESSAGE_SEARCH_PAGE_SIZE, filteredMessages.length),
      );
      return;
    }

    const q = keyword.trim();
    const searchAllMessages = messageSearchAllKeyword === q;
    const requestKey = `${q}\0${searchAllMessages ? 'all' : 'current'}`;
    const source = messageSearchSourceRef.current;
    if (
      !q ||
      !source ||
      messageSearchRequestRef.current !== requestKey ||
      messageSearching ||
      messageLoadingMore ||
      !messageHasMore
    ) return;

    const nextPage = messageSearchPageRef.current + 1;
    const currentRid = activeRid ?? conversationRidsRef.current[0];
    const searchRids = searchAllMessages
      ? conversationRidsRef.current
      : currentRid
        ? [currentRid]
        : [];
    setMessageLoadingMore(true);
    setMessageLoadMoreError(false);
    void searchMoreMessages(
      q,
      searchRids,
      source,
      nextPage,
      messageSearchBackend(),
      () => messageSearchRequestRef.current === requestKey,
      (partialResult) => {
        if (messageSearchRequestRef.current !== requestKey) return;
        setMessages((current) => mergeMessageSearchResults(current, partialResult.messages));
        setMessageHasMore(partialResult.hasMore);
      },
      { searchAll: searchAllMessages },
    )
      .then((result) => {
        if (messageSearchRequestRef.current !== requestKey) return;
        messageSearchSourceRef.current = result.source;
        messageSearchPageRef.current = result.page;
        setMessages((current) => mergeMessageSearchResults(current, result.messages));
        setMessageHasMore(result.hasMore);
        setVisibleMessageCount((count) => count + MESSAGE_SEARCH_PAGE_SIZE);
        setMessageLoadingMore(false);
      })
      .catch(() => {
        if (messageSearchRequestRef.current !== requestKey) return;
        setMessageLoadingMore(false);
        setMessageLoadMoreError(true);
      });
  };

  const requestFullMessageSearch = () => {
    const q = keyword.trim();
    if (!q || messageSearchAllKeyword === q) return;
    setMessageSearchAllKeyword(q);
    setTab('messages');
  };

  const handleResultsScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollHeight - target.scrollTop - target.clientHeight <= 48) {
      loadMoreMessages();
    }
  };

  const jumpToMessage = useChat((s) => s.jumpToMessage);

  /** 语义提问进入当前启动选择的 AI 管家。 */
  const askButlerFromSearch = () => {
    const query = keyword.trim();
    if (!query) return;
    onClose();
    void handoffToButlerTask(query, t('nav.search.butlerHandoffTitle', { query }))
      .catch((error) => toast.error(error, t('nav.search.butlerHandoffFailed')));
  };

  const pickConv = (rid: string) => {
    const conversation = conversations.find((item) => item.rid === rid);
    const subscription = subscriptions[rid];
    const room = rooms[rid];
    if (commandCenter && conversation && (conversation.unread > 0 || conversation.alert)) {
      setConvFilter('unread');
      retainUnread(rid);
    }
    // 多人会话的会话名由成员名拼成：名字命中搜索词时，进会话后在成员面板里
    // 定位并高亮该成员，否则用户看不出这个会话为什么命中（issue #364）
    const highlightName = keyword.trim() && conversation?.isMultiDM
      ? resolveMatchedMemberName(
        keyword,
        displayName(aliases, conversation, nameFormat),
        conversation.name,
        subscription?.fname,
        subscription?.name,
        room?.fname,
        room?.name,
      )
      : undefined;
    // openRoom 会重置右侧面板，必须等它完成后再 setPanel（同 pickFile 的 fileId）
    void openRoom(rid).then(() => {
      if (highlightName) {
        useChat.getState().setPanel({ kind: 'members', highlightName });
      }
    });
    setModule('messages'); // 从通讯录/工作台等模块跳转时切回消息
    onClose();
    focusComposerInput(); // 选中会话后光标直接进输入框（issue #87）
  };

  /** 联系人结果：发起/打开直聊，光标进输入框直接可以打字（issue #87） */
  const pickContact = (username: string) => {
    void startDM(username).then(() => {
      setModule('messages');
      onClose();
      focusComposerInput();
    });
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
      const { rid, mid } = result.item;
      if (rid && mid) {
        setModule('messages');
        void jumpToMessage(mid, rid);
      } else {
        // 手动新建的待办没有来源消息，直接去待办模块
        setModule('todos');
      }
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
          detail: t('nav.search.overview.contactDetail', { username: user.username }),
          avatar: {
            name: personName(aliases, user.username, user.name || user.username, nameFormat),
            username: user.username,
          },
          action: () => pickContact(user.username),
        })),
        ...contacts.rooms.slice(0, Math.max(0, 3 - contactUsers.length)).map((room) => ({
          section: 'contacts' as const,
          key: `room:${room._id}`,
          title: room.fname || room.name || t('nav.search.channelFallback'),
          detail: subscriptions[room._id] ? t('nav.search.channel') : t('nav.search.channelJoin'),
          avatar: { name: room.fname || room.name || t('nav.search.channelFallback'), roomId: room._id },
          action: () => void openSpotlightRoom(room),
        })),
        ...filteredConvs.slice(0, 3).map((conversation) => ({
          section: 'convs' as const,
          key: `conv:${conversation.rid}`,
          title: displayName(aliases, conversation, nameFormat),
          detail: conversation.unread > 0
            ? tp(conversation.unread, 'nav.search.unreadOne', 'nav.search.unreadOther')
            : t('nav.search.conversation'),
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
          title: stripAgentSessionMarker(message.msg ?? '') || t('nav.search.emptyMessage'),
          detail: `${message.u.name || message.u.username} · ${roomName(message.rid)}`,
          avatar: { name: message.u.name || message.u.username, username: message.u.username },
          action: () => pickMessage(message),
        })),
        ...fileResults.slice(0, 3).map((result) => ({
          section: 'files' as const,
          key: `file:${result.rid}:${result.file._id}`,
          title: result.file.name,
          detail: `${t('nav.search.filePrefix')} · ${result.roomName}${result.file.size ? ` · ${fmtSize(result.file.size)}` : ''}`,
          icon: <FileText size={16} />,
          action: () => pickFile(result),
        })),
        ...workResults.slice(0, 3).map((result) => ({
          section: 'work' as const,
          key: `${result.kind}:${result.item.id}`,
          title: result.kind === 'todo'
            ? result.item.note || result.item.excerpt || t('nav.search.emptyContent')
            : result.kind === 'event'
              ? result.item.title
              : `#${result.item.id} ${result.item.title}`,
          detail: result.kind === 'todo'
            ? result.item.roomName ? t('nav.search.todoWithRoom', { roomName: result.item.roomName }) : t('nav.search.todo')
            : result.kind === 'event'
              ? t('nav.search.eventWithDate', { date: result.item.date })
              : t('nav.search.workItemDetail', { project: result.item.project, state: result.item.state }),
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
        detail: conversation.unread > 0
          ? tp(conversation.unread, 'nav.search.unreadOne', 'nav.search.unreadOther')
          : t('nav.search.recentConversation'),
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
          ? shownMessages.map((m) => () => pickMessage(m))
          : tab === 'files'
            ? fileResults.map((result) => () => pickFile(result))
            : tab === 'contacts'
              ? [
                  ...contactUsers.map((u) => () => pickContact(u.username)),
                  ...contacts.rooms.map((r) => () => void openSpotlightRoom(r)),
                ]
              : workResults.map((result) => () => pickWork(result));

  function roomName(rid: string): string {
    return subscriptions[rid]?.fname || subscriptions[rid]?.name || rooms[rid]?.fname || rooms[rid]?.name || t('nav.search.roomFallback');
  }

  const openSpotlightRoom = async (room: RcRoom) => {
    if (!subscriptions[room._id]) {
      await rest.joinChannel(room._id).catch(() => {});
    }
    setModule('messages');
    void openRoom(room._id);
    onClose();
    focusComposerInput(); // 选中频道后同样把光标送进输入框（issue #87）
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
        aria-label={commandCenter ? t('nav.search.commandCenterAria') : t('nav.search.globalSearchAria')}
        tabIndex={-1}
        className="flex h-fit max-h-[70vh] w-[540px] flex-col overflow-hidden rounded-xl bg-surface-4 shadow-2xl"
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
          <Search size={16} className="text-ink-3" />
          <input
            ref={inputRef}
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              setMessageSearchAllKeyword('');
            }}
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
                ? t('nav.search.commandCenterPlaceholder')
                : t('nav.search.globalSearchPlaceholder')
            }
            className="w-full bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
          {!!keyword.trim() && runtimeFeatures().butler && (
            <button
              title={t('nav.search.createButlerTaskTitle')}
              onClick={askButlerFromSearch}
              className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-ink-3 transition hover:bg-fill-hover hover:text-ink"
            >
              <Sparkles size={14} />{t('nav.search.createButlerTask')}
            </button>
          )}
          <kbd className="rounded border border-line px-1.5 py-0.5 text-2xs text-ink-3">Esc</kbd>
        </div>

        <div className="flex shrink-0 gap-1 border-b border-line px-3 py-1.5">
          {QUICK_SEARCH_TABS.map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-md px-2.5 py-1 text-xs transition ${
                tab === key ? 'bg-primary-light font-medium text-primary' : 'text-ink-2 hover:bg-fill-hover'
              }`}
            >
              {t(TAB_LABEL_KEYS[key])}
              {!!keyword.trim() && !messageSearching && !contactSearching && (
                <span className="ml-1 text-xs opacity-70">{searchCounts[key]}</span>
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
            <SlidersHorizontal size={14} />
            {t('nav.search.filters')}{activeFilterCount > 0 ? ` ${activeFilterCount}` : ''}
          </button>
        </div>

        {filtersOpen && (
          <div className="grid shrink-0 grid-cols-[1fr_auto_auto_auto] items-end gap-2 border-b border-line bg-fill-1/50 px-4 py-2.5">
            <label className="text-xs text-ink-3">
              {t('nav.search.filter.sender')}
              <input
                value={senderFilter}
                onChange={(event) => setSenderFilter(event.target.value)}
                placeholder={t('nav.search.filter.senderPlaceholder')}
                className="mt-1 block h-7 w-full rounded border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
              />
            </label>
            <label className="text-xs text-ink-3">
              {t('nav.search.filter.time')}
              <select
                value={timeFilter}
                onChange={(event) => setTimeFilter(event.target.value as SearchTimeRange)}
                className="mt-1 block h-7 rounded border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
              >
                <option value="any">{t('nav.search.filter.any')}</option>
                <option value="7d">{t('nav.search.filter.7d')}</option>
                <option value="30d">{t('nav.search.filter.30d')}</option>
                <option value="365d">{t('nav.search.filter.365d')}</option>
              </select>
            </label>
            <label className="text-xs text-ink-3">
              {t('nav.search.filter.fileType')}
              <select
                value={fileTypeFilter}
                onChange={(event) => setFileTypeFilter(event.target.value as SearchFileType)}
                className="mt-1 block h-7 rounded border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
              >
                <option value="any">{t('nav.search.filter.any')}</option>
                <option value="image">{t('nav.search.filter.image')}</option>
                <option value="document">{t('nav.search.filter.document')}</option>
                <option value="archive">{t('nav.search.filter.archive')}</option>
                <option value="other">{t('nav.search.filter.other')}</option>
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
              {t('nav.search.filter.clear')}
            </button>
            <div className="col-span-4 text-xs text-ink-3">
              {t('nav.search.filter.scopeHint')}
            </div>
          </div>
        )}

        {!!keyword.trim() && (
          <div className="flex shrink-0 items-center justify-between border-b border-line bg-fill-1/40 px-4 py-2 text-xs text-ink-3">
            <span>
              {messageSearchAllKeyword === keyword.trim()
                ? messageSearching
                  ? t('nav.search.scope.searchingAll')
                  : t('nav.search.scope.all')
                : t(activeRid ? 'nav.search.scope.defaultCurrent' : 'nav.search.scope.defaultRecent')}
            </span>
            {messageSearchAllKeyword !== keyword.trim() && (
              <button
                className="rounded px-2 py-1 font-medium text-primary hover:bg-primary-light"
                onClick={requestFullMessageSearch}
              >
                {t('nav.search.searchAll')}
              </button>
            )}
          </div>
        )}

        <div className="min-h-40 flex-1 overflow-y-auto py-1" onScroll={handleResultsScroll}>
          {tab === 'all' && (
            <>
              {!keyword.trim() && commandCenter && (
                <div className="px-4 py-1.5 text-xs text-ink-3">
                  {conversations.some((item) => item.unread > 0 || item.alert)
                    ? t('nav.search.commandCenterUnreadHint')
                    : t('nav.search.commandCenterRecentHint')}
                </div>
              )}
              {keyword.trim() && contactSearching && (
                <div className="px-4 py-1.5 text-xs text-ink-3">{t('nav.search.loadingContacts')}</div>
              )}
              {keyword.trim() && contactRosterWarning && (
                <div className="px-4 py-1.5 text-xs text-warning">{contactRosterWarning}</div>
              )}
              {keyword.trim() && messageSearching && (
                <div className="px-4 py-1.5 text-xs text-ink-3">
                  {messages.length > 0
                    ? messageSearchAllKeyword === keyword.trim()
                      ? t('nav.search.searchingAllWithLocal')
                      : t('nav.search.searchingCurrentWithLocal')
                    : messageSearchAllKeyword === keyword.trim()
                      ? t('nav.search.searchingAllBg')
                      : t('nav.search.searchingCurrent')}
                </div>
              )}
              {QUICK_SEARCH_RESULT_SECTIONS.map((section) => {
                const items = overviewItems.filter((item) => item.section === section);
                if (items.length === 0) return null;
                return (
                  <div key={section}>
                    <div className="flex items-center justify-between px-4 pt-2 pb-1 text-xs text-ink-3">
                      <span>{t(RESULT_LABEL_KEYS[section])}</span>
                      {!!keyword.trim() && searchCounts[section] > items.length && (
                        <button className="text-primary hover:underline" onClick={() => setTab(section)}>
                          {t('nav.search.viewAll', { count: searchCounts[section] })}
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
                            <span className="block truncate text-xs text-ink-3">{item.detail}</span>
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
                  <div className="py-8 text-center text-sm text-ink-3">{t('nav.search.noResults')}</div>
                )}
              {keyword.trim() && !messageSearching && !contactSearching && (messageError || contactError) && (
                <div className="px-4 py-2 text-xs text-warning">{t('nav.search.partialRemoteUnavailable')}</div>
              )}
            </>
          )}
          {commandCenter && tab === 'convs' && !keyword.trim() && (
            <div className="px-4 py-1.5 text-xs text-ink-3">
              {conversations.some((item) => item.unread > 0 || item.alert)
                ? t('nav.search.commandCenterUnreadHint')
                : t('nav.search.commandCenterRecentHint')}
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
                  <span className="rounded bg-fill-1 px-1 text-xs text-ink-3">{t('nav.search.discussionBadge')}</span>
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
              {messageSearching || contactSearching ? t('nav.search.searchingOtherTabs') : t('nav.search.noMatchingConversations')}
            </div>
          )}

          {tab === 'messages' && (
            <>
              {messageSearching && (
                <div className={messages.length > 0
                  ? 'px-4 py-1.5 text-xs text-ink-3'
                  : 'py-8 text-center text-sm text-ink-3'}
                >
                  {messages.length > 0
                    ? messageSearchAllKeyword === keyword.trim()
                      ? t('nav.search.searchingAllWithPartial')
                      : t('nav.search.searchingCurrentWithLocal')
                    : messageSearchAllKeyword === keyword.trim()
                      ? t('nav.search.searchingAll')
                      : t('nav.search.searchingCurrent')}
                </div>
              )}
              {!messageSearching && messageError && (
                <div className={messages.length > 0
                  ? 'px-4 py-1.5 text-xs text-warning'
                  : 'py-8 text-center text-sm text-danger'}
                >
                  {messages.length > 0
                    ? t('nav.search.partialHistoryUnavailable')
                    : messageError}
                </div>
              )}
              {!messageSearching && !messageError && keyword.trim() && filteredMessages.length === 0 && (
                <div className="py-8 text-center text-sm text-ink-3">
                  {messages.length > 0 && activeFilterCount > 0
                    ? t('nav.search.noFilteredMessages')
                    : messageSearchAllKeyword === keyword.trim()
                      ? t('nav.search.noMessagesAll')
                      : t('nav.search.noMessagesDefault')}
                </div>
              )}
              {!messageSearching && !messageError && !keyword.trim() && (
                <div className="py-8 text-center text-sm text-ink-3">
                  {t('nav.search.emptyMessagesPrompt')}
                </div>
              )}
              {!messageSearching && !messageError && keyword.trim() && messages.length > 0 && (
                <div className="px-4 py-1.5 text-xs text-ink-3">
                  {(shownMessages.length < filteredMessages.length || messageHasMore)
                    ? tp(shownMessages.length, 'nav.search.messagesStatusMoreOne', 'nav.search.messagesStatusMoreOther')
                    : messageSearchAllKeyword === keyword.trim()
                      ? tp(shownMessages.length, 'nav.search.messagesStatusAllLoadedOne', 'nav.search.messagesStatusAllLoadedOther')
                      : tp(shownMessages.length, 'nav.search.messagesStatusScopeLoadedOne', 'nav.search.messagesStatusScopeLoadedOther')}
                </div>
              )}
              {shownMessages.map((m, i) => (
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
                      <span className="flex items-center gap-0.5 text-xs text-ink-3">
                        <Hash size={12} />
                        {roomName(m.rid)}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-ink-3">
                        {fmtConvTime(tsMs(m.ts))}
                      </span>
                    </span>
                    <span className="line-clamp-2 text-sm break-words text-ink-2">
                      {highlightText(stripAgentSessionMarker(m.msg ?? ''), keyword)}
                    </span>
                  </span>
                </button>
              ))}
              {messageLoadingMore && (
                <div className="px-4 py-3 text-center text-xs text-ink-3">
                  {t('nav.search.loadingMoreMessages')}
                </div>
              )}
              {!messageLoadingMore &&
                keyword.trim() &&
                shownMessages.length > 0 &&
                (shownMessages.length < filteredMessages.length ||
                  (!messageSearching && messageHasMore)) && (
                  <button
                    className="w-full px-4 py-3 text-center text-xs text-primary hover:bg-fill-hover"
                    onClick={loadMoreMessages}
                  >
                    {messageLoadMoreError ? t('nav.search.loadMoreRetry') : t('nav.search.scrollToLoadMore')}
                  </button>
                )}
            </>
          )}

          {tab === 'files' && (
            <>
              <div className="px-4 py-1.5 text-xs text-ink-3">
                {tp(fileIndex.rooms.length, 'nav.search.indexedRoomsOne', 'nav.search.indexedRoomsOther')}
              </div>
              {!keyword.trim() && (
                <div className="py-8 text-center text-sm text-ink-3">{t('nav.search.emptyFilesPrompt')}</div>
              )}
              {keyword.trim() && fileResults.length === 0 && (
                <div className="py-8 text-center text-sm text-ink-3">
                  {fileIndex.rooms.length === 0
                    ? t('nav.search.noIndexedRooms')
                    : rawFileResults.length > 0 && activeFilterCount > 0
                      ? t('nav.search.noFilteredFiles')
                      : t('nav.search.noMatchingFiles')}
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
                    <FileText size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">
                      {highlightText(result.file.name, keyword)}
                    </span>
                    <span className="block truncate text-xs text-ink-3">
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
              {contactRosterWarning && (
                <div className="px-4 py-1.5 text-xs text-warning">{contactRosterWarning}</div>
              )}
              {contactSearching && <div className="py-8 text-center text-sm text-ink-3">{t('nav.search.searching')}</div>}
              {!contactSearching &&
                contactError &&
                contactUsers.length === 0 &&
                contacts.rooms.length === 0 && (
                  <div className="py-8 text-center text-sm text-danger">{contactError}</div>
                )}
              {!contactSearching && !contactError && !keyword.trim() && (
                <div className="py-8 text-center text-sm text-ink-3">{t('nav.search.emptyContactsPrompt')}</div>
              )}
              {contactUsers.length > 0 && (
                <div className="px-4 pt-2 pb-1 text-xs text-ink-3">{t('nav.search.contactsHeading')}</div>
              )}
              {contactUsers.map((u, i) => {
                const shown = personName(aliases, u.username, u.name || u.username, nameFormat);
                return (
                <button
                  key={u._id}
                  onClick={() => pickContact(u.username)}
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
                <div className="px-4 pt-2 pb-1 text-xs text-ink-3">{t('nav.search.channelsHeading')}</div>
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
                  <Avatar name={r.fname || r.name || t('nav.search.channelFallback')} roomId={r._id} size={28} />
                  <span className="truncate text-sm text-ink">{r.fname || r.name}</span>
                  {!subscriptions[r._id] && (
                    <span className="ml-auto text-xs text-primary">{t('nav.search.clickToJoin')}</span>
                  )}
                </button>
                );
              })}
              {!contactSearching &&
                !contactError &&
                keyword.trim() &&
                contactUsers.length === 0 &&
                contacts.rooms.length === 0 && (
                  <div className="py-8 text-center text-sm text-ink-3">{t('nav.search.noResults')}</div>
                )}
            </>
          )}

          {tab === 'work' && (
            <>
              {!keyword.trim() && (
                <div className="py-8 text-center text-sm text-ink-3">{t('nav.search.emptyWorkPrompt')}</div>
              )}
              {keyword.trim() && workResults.length === 0 && (
                <div className="py-8 text-center text-sm text-ink-3">{t('nav.search.noMatchingWork')}</div>
              )}
              {workResults.map((result, i) => {
                const icon = result.kind === 'todo'
                  ? <ListTodo size={16} />
                  : result.kind === 'event'
                    ? <CalendarDays size={16} />
                    : <BriefcaseBusiness size={16} />;
                const title = result.kind === 'todo'
                  ? result.item.note || result.item.excerpt || t('nav.search.emptyContent')
                  : result.kind === 'event'
                    ? result.item.title
                    : `#${result.item.id} ${result.item.title}`;
                const detail = result.kind === 'todo'
                  ? result.item.roomName ? t('nav.search.todoWithRoom', { roomName: result.item.roomName }) : t('nav.search.todo')
                  : result.kind === 'event'
                    ? t('nav.search.eventWithDate', { date: result.item.date })
                    : t('nav.search.workItemDetail', { project: result.item.project, state: result.item.state });
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
                      <span className="block truncate text-xs text-ink-3">{detail}</span>
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
