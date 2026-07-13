import { create } from 'zustand';
import {
  tsMs,
  type RcMessage,
  type RcMessageAttachment,
  type RcRoom,
  type RcSubscription,
  type RcUser,
  type RealtimeStatus,
} from '@rcx/rc-client';
import { ensureSiteUrl, loadStoredAuth, realtime, rest, siteUrlSync } from '../lib/client';
import { emojify } from '../lib/emoji';
import { useAuth } from './auth';
import { usePrefs } from './prefs';
import { humanError, toast } from './toast';

export interface Conversation {
  rid: string;
  name: string;
  type: RcSubscription['t'];
  unread: number;
  alert: boolean;
  /** 被 @ 我的次数 */
  userMentions: number;
  /** 置顶会话 */
  favorite: boolean;
  /** 免打扰 */
  muted: boolean;
  /** 讨论（Discussion，父房间的子会话） */
  isDiscussion: boolean;
  /** 多人直聊：RC 里 t 仍是 'd'，但成员多于两人——对用户来说是群聊 */
  isMultiDM: boolean;
  /** 讨论所属的父会话名 */
  parentName?: string;
  /** Team 主频道 */
  isTeam: boolean;
  /** 属于某个 Team 的子频道 */
  teamId?: string;
  lastTs: number;
  lastPreview: string;
  /** DM 用对方用户名取头像 */
  avatarUsername?: string;
}

/** 侧栏分区（对齐 Rocket.Chat 官方的 sidebarSectionsOrder） */
export type SectionKey =
  | 'unread'
  | 'favorites'
  | 'teams'
  | 'discussions'
  | 'channels'
  | 'direct';

export const SECTION_LABELS: Record<SectionKey, string> = {
  unread: '未读',
  favorites: '收藏',
  teams: '团队',
  discussions: '讨论',
  channels: '频道与群组',
  direct: '私聊',
};

/** 右侧面板：话题 / Pin 列表 / 标记 / 群成员 / 消息搜索，同一时刻只开一个 */
export type RightPanel =
  | { kind: 'thread'; mid: string }
  | { kind: 'pins' }
  | { kind: 'starred' }
  | { kind: 'members' }
  | { kind: 'search' }
  | { kind: 'info' }
  | null;

const HISTORY_PAGE = 50;
const DRAFTS_KEY = 'rcx-drafts';

function loadDrafts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

interface ChatState {
  ready: boolean;
  connection: RealtimeStatus;
  subscriptions: Record<string, RcSubscription>;
  rooms: Record<string, RcRoom>;
  messages: Record<string, RcMessage[]>;
  historyLoaded: Record<string, boolean>;
  hasMore: Record<string, boolean>;
  members: Record<string, RcUser[]>;
  activeRid: string | null;
  rightPanel: RightPanel;
  /** 自己发送消息后递增，MessageList 据此强制滚到底部 */
  scrollNonce: number;
  uploading: number;
  /** 每个会话的输入草稿（持久化） */
  drafts: Record<string, string>;
  /** 「以下为新消息」分割线时间戳（打开有未读的会话时记录） */
  unreadMarkTs: Record<string, number>;
  /** 待确认发送的文件（粘贴/拖拽后进入预览确认） */
  pendingFiles: File[] | null;
  /** 正在引用回复的消息 */
  replyTo: RcMessage | null;
  /** 被跳转定位的消息 id（短暂高亮） */
  highlightMid: string | null;
  /** 正在输入的用户：rid -> username -> 过期时间戳 */
  typing: Record<string, Record<string, number>>;
  /** 已读回执：rid -> { mid: 最后一条自己消息, users: 已读的其他人 } */
  readReceipts: Record<string, { mid: string; users: { username: string; name?: string }[] }>;

  init: () => Promise<void>;
  openRoom: (rid: string) => Promise<void>;
  openThread: (mid: string) => Promise<void>;
  setPanel: (panel: RightPanel) => void;
  loadOlder: () => Promise<number>;
  loadMembers: (rid: string) => Promise<RcUser[]>;
  send: (text: string, opts?: { tmid?: string; quote?: RcMessage }) => Promise<void>;
  /** 重发失败的消息 */
  resendMessage: (tempId: string) => Promise<void>;
  /** 丢弃失败的本地消息 */
  discardMessage: (tempId: string) => void;
  setReplyTo: (msg: RcMessage | null) => void;
  /** 跳转到某条消息（必要时向上加载历史），并高亮 2 秒 */
  jumpToMessage: (mid: string, rid?: string) => Promise<void>;
  /** 输入中广播（内部已节流） */
  emitTyping: () => void;
  refreshReceipts: (rid: string) => Promise<void>;
  inviteMembers: (rid: string, users: RcUser[]) => Promise<void>;
  editMessage: (msgId: string, text: string) => Promise<void>;
  deleteMessage: (msgId: string) => Promise<void>;
  toggleReaction: (messageId: string, emoji: string) => Promise<void>;
  togglePin: (msg: RcMessage) => Promise<void>;
  toggleStar: (msg: RcMessage) => Promise<void>;
  toggleFavorite: (conv: Conversation) => Promise<void>;
  toggleMute: (conv: Conversation) => Promise<void>;
  markConvRead: (rid: string) => Promise<void>;
  hideConv: (conv: Conversation) => Promise<void>;
  /** 改群设置（话题/公告/描述/名称）；无权限时会抛出 */
  saveRoomSettings: (
    rid: string,
    settings: { topic?: string; announcement?: string; description?: string; roomName?: string },
  ) => Promise<void>;
  /** 退出群组（DM 只能隐藏） */
  leaveConv: (conv: Conversation) => Promise<void>;
  forwardMessage: (msg: RcMessage, rids: string[]) => Promise<void>;
  setDraft: (rid: string, text: string) => void;
  /** 发起私聊：创建/打开 DM 并跳转，返回房间 id */
  startDM: (username: string) => Promise<string>;
  /** 创建群组并跳转，返回房间 id */
  createGroup: (name: string, members: string[], priv: boolean) => Promise<string>;
  /** 创建团队（Team = 主频道 + 子频道）并跳转 */
  createTeam: (name: string, members: string[], priv: boolean) => Promise<string>;
  /** 从消息创建讨论（RC Discussion）并跳转 */
  createDiscussionFrom: (msg: RcMessage) => Promise<void>;
  requestUpload: (files: File[]) => void;
  confirmUpload: () => Promise<void>;
  cancelUpload: () => void;
  uploadFiles: (files: File[], tmid?: string) => Promise<void>;
}

function upsertMessage(list: RcMessage[], msg: RcMessage): RcMessage[] {
  const idx = list.findIndex((m) => m._id === msg._id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = msg;
    return next;
  }
  return [...list, msg];
}

function messagePreview(msg: RcMessage | undefined): string {
  if (!msg) return '';
  const who = msg.u?.name || msg.u?.username || '';
  if (msg.t) return '[系统消息]';
  // 预览是纯文本，不走 markdown 渲染，所以 :smile: 得在这里换成表情
  const text = emojify((msg.msg ?? '').replace(QUOTE_LINK_RE, ''));
  if (text) return who ? `${who}: ${text}` : text;
  if (msg.file?.name) return who ? `${who}: [文件] ${msg.file.name}` : `[文件] ${msg.file.name}`;
  if (msg.attachments?.length) return who ? `${who}: [图片/附件]` : '[图片/附件]';
  return '';
}

/** 新建 DM/群组后刷新订阅与房间（新条目要出现在会话列表里） */
async function refreshSubsAndRooms(
  set: (partial: Partial<ChatState>) => void,
): Promise<void> {
  const [subs, rooms] = await Promise.all([rest.getSubscriptions(), rest.getRooms()]);
  const subMap: Record<string, RcSubscription> = {};
  for (const s of subs) subMap[s.rid] = s;
  const roomMap: Record<string, RcRoom> = {};
  for (const r of rooms) roomMap[r._id] = r;
  set({ subscriptions: subMap, rooms: roomMap });
}

const subscribedRooms = new Set<string>();
let markReadTimer: ReturnType<typeof setTimeout> | null = null;
let receiptTimer: ReturnType<typeof setTimeout> | null = null;
let lastTypingEmit = 0;
/** 已读回执是 RC 企业版功能：社区版首次失败后不再请求（避免每次打开会话都报 400） */
let receiptsSupported = true;

function scheduleMarkRead(rid: string) {
  if (markReadTimer) clearTimeout(markReadTimer);
  markReadTimer = setTimeout(() => {
    rest.markRead(rid).catch(() => {});
  }, 600);
}

function scheduleReceiptRefresh(rid: string) {
  if (!receiptsSupported) return;
  if (receiptTimer) clearTimeout(receiptTimer);
  receiptTimer = setTimeout(() => {
    void useChat.getState().refreshReceipts(rid);
  }, 1200);
}

function subscribeRoomStreams(rid: string) {
  if (subscribedRooms.has(rid)) return;
  subscribedRooms.add(rid);
  realtime.subscribe('stream-room-messages', rid);
  realtime.subscribe('stream-notify-room', `${rid}/deleteMessage`);
  realtime.subscribe('stream-notify-room', `${rid}/user-activity`);
}

function roomPath(rid: string, subs: Record<string, RcSubscription>): string {
  const sub = subs[rid];
  return sub?.t === 'c'
    ? `channel/${sub.name}`
    : sub?.t === 'p'
      ? `group/${sub.name}`
      : `direct/${rid}`;
}

/**
 * 引用回复走 RC 官方机制：消息文本以 `[ ](Site_Url 消息链接) ` 开头，
 * 服务端自动展开为引用附件（REST 直接发 message_link 附件会被服务端清洗）。
 */
function quoteLinkPrefix(quoted: RcMessage, subs: Record<string, RcSubscription>): string {
  return `[ ](${siteUrlSync()}/${roomPath(quoted.rid, subs)}?msg=${quoted._id}) `;
}

/** 本地乐观展示用的引用附件（服务器确认后会被展开后的正式附件替换） */
function localQuoteAttachment(quoted: RcMessage): RcMessageAttachment {
  return {
    message_link: `local-quote`,
    author_name: quoted.u.name || quoted.u.username,
    text: stripQuotePrefix(quoted.msg) || quoted.attachments?.[0]?.title || '[卡片消息]',
    ts: quoted.ts,
  };
}

/** 消息文本开头的引用链接（渲染与预览时隐藏） */
export const QUOTE_LINK_RE = /^(\s*\[ \]\((?:https?:\/\/|\/)[^)\s]*\)\s*)+/;

/** 去掉消息文本开头的引用链接前缀（编辑/复制/引用展示都用可见文本） */
export function stripQuotePrefix(text: string): string {
  return text.replace(QUOTE_LINK_RE, '');
}

// 开发调试：控制台可通过 window.__chat 检查 store 状态
declare global {
  interface Window {
    __chat?: typeof useChat;
  }
}

function notifyIfNeeded(msg: RcMessage, rid: string, state: ChatState) {
  const auth = loadStoredAuth();
  if (!auth || msg.u._id === auth.userId || msg.t) return;
  // 免打扰会话不弹通知
  if (state.subscriptions[rid]?.disableNotifications) return;

  const prefs = usePrefs.getState().prefs;
  if (prefs.desktopNotifications === 'nothing') return;
  // 「仅 @我」：消息里没提到我就不弹
  if (prefs.desktopNotifications === 'mentions') {
    const me = useAuth.getState().user?.username;
    const mentioned =
      !!me && new RegExp(`@(${me}|all|here)\\b`).test(msg.msg ?? '');
    if (!mentioned) return;
  }

  const focused = state.activeRid === rid && !document.hidden;
  // 关闭「当前会话不打扰」时，正在看的会话也会弹通知
  if (focused && (prefs.muteFocusedConversations ?? true)) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const title = msg.u.name || msg.u.username;
  const body = msg.msg || (msg.attachments?.length ? '[卡片/文件]' : '');
  const n = new Notification(title, { body: body.slice(0, 120), tag: msg._id });
  n.onclick = () => {
    window.focus();
    void useChat.getState().openRoom(rid);
    n.close();
  };
}

export const useChat = create<ChatState>((set, get) => ({
  ready: false,
  connection: 'idle',
  subscriptions: {},
  rooms: {},
  messages: {},
  historyLoaded: {},
  hasMore: {},
  members: {},
  activeRid: null,
  rightPanel: null,
  scrollNonce: 0,
  uploading: 0,
  drafts: loadDrafts(),
  unreadMarkTs: {},
  pendingFiles: null,
  replyTo: null,
  highlightMid: null,
  typing: {},
  readReceipts: {},

  init: async () => {
    const auth = loadStoredAuth();
    if (!auth) return;
    // 预热 Site_Url 缓存（引用回复的链接前缀需要）
    void ensureSiteUrl();

    const [subs, rooms] = await Promise.all([rest.getSubscriptions(), rest.getRooms()]);
    const subMap: Record<string, RcSubscription> = {};
    for (const s of subs) subMap[s.rid] = s;
    const roomMap: Record<string, RcRoom> = {};
    for (const r of rooms) roomMap[r._id] = r;
    set({ subscriptions: subMap, rooms: roomMap, ready: true });

    // 防止重复注册（StrictMode 双执行 / 开发时 HMR 重建 store）
    realtime.clearStreamHandlers();
    // 断线/恢复给出可见提示（顶部横幅 + toast 各司其职：横幅表状态，toast 表变化）
    let offlineToastId: string | null = null;
    realtime.onStatus = (s) => {
      const prev = get().connection;
      set({ connection: s });
      if (s === 'reconnecting' && prev === 'connected') {
        offlineToastId = toast.show({
          kind: 'error',
          message: '与服务器断开连接，正在重连…',
          duration: 0,
        });
      } else if (s === 'connected' && offlineToastId) {
        toast.update(offlineToastId, { kind: 'success', message: '已重新连接' });
        offlineToastId = null;
      }
    };
    await realtime.connect();
    await realtime.login(auth.authToken);

    realtime.onStream('stream-room-messages', (rid, args) => {
      const msg = args[0] as RcMessage | undefined;
      if (!msg?._id) return;
      const state = get();
      set({ messages: { ...state.messages, [rid]: upsertMessage(state.messages[rid] ?? [], msg) } });
      const room = state.rooms[rid];
      if (room && !msg.tmid) {
        set({ rooms: { ...get().rooms, [rid]: { ...room, lastMessage: msg, lm: msg.ts } } });
      }
      notifyIfNeeded(msg, rid, state);
      if (get().activeRid === rid) {
        scheduleMarkRead(rid);
        scheduleReceiptRefresh(rid);
      }
      // 对方发出消息即视为停止输入
      const typingOfRoom = get().typing[rid];
      if (typingOfRoom?.[msg.u.username]) {
        const next = { ...typingOfRoom };
        delete next[msg.u.username];
        set({ typing: { ...get().typing, [rid]: next } });
      }
    });

    // 房间级通知：消息删除 / 正在输入
    realtime.onStream('stream-notify-room', (eventName, args) => {
      const [rid, kind] = eventName.split('/');
      if (kind === 'deleteMessage') {
        const deleted = args[0] as { _id: string } | undefined;
        if (!deleted?._id) return;
        const list = get().messages[rid];
        if (!list) return;
        set({ messages: { ...get().messages, [rid]: list.filter((m) => m._id !== deleted._id) } });
      } else if (kind === 'user-activity') {
        const [username, activities] = args as [string, string[]];
        const me = useAuth.getState().user?.username;
        if (!username || username === me) return;
        const room = { ...(get().typing[rid] ?? {}) };
        if (Array.isArray(activities) && activities.includes('user-typing')) {
          room[username] = Date.now() + 8000;
          // 到期自动清理（顺带触发一次重渲染）
          setTimeout(() => {
            const cur = get().typing[rid];
            if (cur?.[username] && cur[username] <= Date.now()) {
              const next = { ...cur };
              delete next[username];
              set({ typing: { ...get().typing, [rid]: next } });
            }
          }, 8200);
        } else {
          delete room[username];
        }
        set({ typing: { ...get().typing, [rid]: room } });
      }
    });

    realtime.onStream('stream-notify-user', (eventName, args) => {
      const [action, payload] = args as [string, RcRoom & RcSubscription];
      if (!payload) return;
      if (eventName.endsWith('/rooms-changed')) {
        if (action === 'removed') return;
        set({ rooms: { ...get().rooms, [payload._id]: payload as RcRoom } });
      } else if (eventName.endsWith('/subscriptions-changed')) {
        const subs2 = { ...get().subscriptions };
        if (action === 'removed') delete subs2[payload.rid];
        else subs2[payload.rid] = payload as RcSubscription;
        set({ subscriptions: subs2 });
      }
    });
    realtime.subscribe('stream-notify-user', `${auth.userId}/rooms-changed`);
    realtime.subscribe('stream-notify-user', `${auth.userId}/subscriptions-changed`);
  },

  openRoom: async (rid) => {
    const sub = get().subscriptions[rid];
    // 打开有未读的会话时记录「以下为新消息」位置（取上次已读时间）。
    // RC 对频道默认只有 @ 才累计 unread，普通新消息只置 alert，两者都算未读
    const marks = { ...get().unreadMarkTs };
    if (sub && (sub.unread > 0 || sub.alert) && sub.ls) marks[rid] = tsMs(sub.ls);
    else delete marks[rid];
    set({ activeRid: rid, rightPanel: null, unreadMarkTs: marks, pendingFiles: null, replyTo: null });

    const { historyLoaded, subscriptions, rooms } = get();
    subscribeRoomStreams(rid);

    if (!historyLoaded[rid]) {
      const type = subscriptions[rid]?.t ?? rooms[rid]?.t ?? 'c';
      const history = await rest.getHistory(rid, type, HISTORY_PAGE);
      const existing = get().messages[rid] ?? [];
      let merged = history;
      for (const m of existing) merged = upsertMessage(merged, m);
      merged.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
      set({
        messages: { ...get().messages, [rid]: merged },
        historyLoaded: { ...get().historyLoaded, [rid]: true },
        hasMore: { ...get().hasMore, [rid]: history.length >= HISTORY_PAGE },
      });
    }
    scheduleMarkRead(rid);
    scheduleReceiptRefresh(rid);
  },

  openThread: async (mid) => {
    set({ rightPanel: { kind: 'thread', mid } });
    const rid = get().activeRid;
    if (!rid) return;
    try {
      const threadMessages = await rest.getThreadMessages(mid);
      let list = get().messages[rid] ?? [];
      for (const m of threadMessages) list = upsertMessage(list, m);
      list.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
      set({ messages: { ...get().messages, [rid]: list } });
    } catch {
      /* 线程功能被服务器禁用时静默降级 */
    }
  },

  setPanel: (panel) => set({ rightPanel: panel }),

  loadOlder: async () => {
    const rid = get().activeRid;
    if (!rid || get().hasMore[rid] === false) return 0;
    const list = get().messages[rid] ?? [];
    const oldest = list.find((m) => !m.tmid) ?? list[0];
    if (!oldest) return 0;
    const type = get().subscriptions[rid]?.t ?? get().rooms[rid]?.t ?? 'c';
    const older = await rest.getHistory(
      rid,
      type,
      HISTORY_PAGE,
      new Date(tsMs(oldest.ts)).toISOString(),
    );
    let merged = get().messages[rid] ?? [];
    for (const m of older) merged = upsertMessage(merged, m);
    merged.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
    set({
      messages: { ...get().messages, [rid]: merged },
      hasMore: { ...get().hasMore, [rid]: older.length >= HISTORY_PAGE },
    });
    return older.length;
  },

  loadMembers: async (rid) => {
    const cached = get().members[rid];
    if (cached) return cached;
    const type = get().subscriptions[rid]?.t ?? get().rooms[rid]?.t ?? 'c';
    try {
      const members = await rest.getMembers(rid, type);
      set({ members: { ...get().members, [rid]: members } });
      return members;
    } catch {
      return [];
    }
  },

  send: async (text, opts) => {
    const rid = get().activeRid;
    const trimmed = text.trim();
    const me = useAuth.getState().user;
    if (!rid || !trimmed || !me) return;

    // 引用回复：文本前缀消息链接，服务端展开为引用附件
    const fullText = opts?.quote
      ? quoteLinkPrefix(opts.quote, get().subscriptions) + trimmed
      : trimmed;

    // 乐观上屏：秒回显，pending 状态等服务器确认
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const temp: RcMessage = {
      _id: tempId,
      rid,
      msg: fullText,
      ts: new Date().toISOString(),
      u: { _id: me._id, username: me.username, name: me.name },
      ...(opts?.tmid ? { tmid: opts.tmid } : {}),
      ...(opts?.quote ? { attachments: [localQuoteAttachment(opts.quote)] } : {}),
      pending: true,
    };
    set({
      messages: { ...get().messages, [rid]: [...(get().messages[rid] ?? []), temp] },
      ...(opts?.tmid ? {} : { scrollNonce: get().scrollNonce + 1 }),
    });
    // 发送即视为停止输入
    void realtime.call('stream-notify-room', `${rid}/user-activity`, me.username, []).catch(() => {});

    try {
      const msg = await rest.sendMessageRaw({
        rid,
        msg: fullText,
        ...(opts?.tmid ? { tmid: opts.tmid } : {}),
      });
      const list = (get().messages[rid] ?? []).filter((m) => m._id !== tempId);
      set({ messages: { ...get().messages, [rid]: upsertMessage(list, msg) } });
      scheduleReceiptRefresh(rid);
    } catch (err) {
      // 标记失败，可重试
      set({
        messages: {
          ...get().messages,
          [rid]: (get().messages[rid] ?? []).map((m) =>
            m._id === tempId ? { ...m, pending: false, failed: true } : m,
          ),
        },
      });
      toast.show({
        kind: 'error',
        message: humanError(err, '消息发送失败'),
        action: { label: '重试', onClick: () => void get().resendMessage(tempId) },
      });
    }
  },

  resendMessage: async (tempId) => {
    // 用消息自身的 rid：用户可能已切换到别的会话
    const rid = Object.keys(get().messages).find((r) =>
      (get().messages[r] ?? []).some((m) => m._id === tempId),
    );
    if (!rid) return;
    const failed = (get().messages[rid] ?? []).find((m) => m._id === tempId);
    if (!failed) return;
    set({
      messages: {
        ...get().messages,
        [rid]: (get().messages[rid] ?? []).map((m) =>
          m._id === tempId ? { ...m, pending: true, failed: false } : m,
        ),
      },
    });
    try {
      // 附件是本地展示用的，不随重发提交（引用信息已在消息文本前缀里）
      const msg = await rest.sendMessageRaw({
        rid,
        msg: failed.msg,
        ...(failed.tmid ? { tmid: failed.tmid } : {}),
      });
      const list = (get().messages[rid] ?? []).filter((m) => m._id !== tempId);
      set({ messages: { ...get().messages, [rid]: upsertMessage(list, msg) } });
    } catch {
      set({
        messages: {
          ...get().messages,
          [rid]: (get().messages[rid] ?? []).map((m) =>
            m._id === tempId ? { ...m, pending: false, failed: true } : m,
          ),
        },
      });
    }
  },

  discardMessage: (tempId) => {
    const rid = Object.keys(get().messages).find((r) =>
      (get().messages[r] ?? []).some((m) => m._id === tempId),
    );
    if (!rid) return;
    set({
      messages: {
        ...get().messages,
        [rid]: (get().messages[rid] ?? []).filter((m) => m._id !== tempId),
      },
    });
  },

  setReplyTo: (msg) => set({ replyTo: msg }),

  jumpToMessage: async (mid, rid) => {
    const targetRid = rid ?? get().activeRid;
    if (!targetRid) return;

    // 目标不在当前会话 → 先切过去
    if (targetRid !== get().activeRid) {
      await get().openRoom(targetRid);
    }

    // 消息不在已加载的范围内 → 向上翻页找（最多 5 页，避免无限拉）
    for (let i = 0; i < 5; i++) {
      const list = get().messages[targetRid] ?? [];
      if (list.some((m) => m._id === mid)) break;
      if (get().hasMore[targetRid] === false) break;
      const loaded = await get().loadOlder();
      if (loaded === 0) break;
    }

    const found = (get().messages[targetRid] ?? []).some((m) => m._id === mid);
    if (!found) {
      toast.info('原消息太久远，未能定位');
      return;
    }

    set({ highlightMid: mid });
    // 滚动由 MessageItem 侧的 effect 执行（拿到 DOM 节点）
    setTimeout(() => {
      if (get().highlightMid === mid) set({ highlightMid: null });
    }, 2600);
  },

  emitTyping: () => {
    const rid = get().activeRid;
    const me = useAuth.getState().user;
    if (!rid || !me) return;
    const now = Date.now();
    if (now - lastTypingEmit < 3000) return; // 节流
    lastTypingEmit = now;
    void realtime
      .call('stream-notify-room', `${rid}/user-activity`, me.username, ['user-typing'])
      .catch(() => {});
  },

  refreshReceipts: async (rid) => {
    const me = useAuth.getState().user;
    if (!me || !receiptsSupported) return;
    const list = (get().messages[rid] ?? []).filter(
      (m) => !m.tmid && !m.t && !m.pending && !m.failed,
    );
    const lastOwn = [...list].reverse().find((m) => m.u._id === me._id);
    if (!lastOwn) return;
    try {
      const receipts = await rest.getReadReceipts(lastOwn._id);
      const users = receipts
        .filter((r) => r.user?._id !== me._id)
        .map((r) => ({ username: r.user?.username ?? '', name: r.user?.name }));
      set({ readReceipts: { ...get().readReceipts, [rid]: { mid: lastOwn._id, users } } });
    } catch (err) {
      // 社区版 / 未开启回执：停止后续请求，功能静默降级
      const raw = err instanceof Error ? err.message : '';
      if (/enterprise|not-allowed|not allowed|disabled/i.test(raw)) receiptsSupported = false;
    }
  },

  inviteMembers: async (rid, users) => {
    const type = get().subscriptions[rid]?.t ?? get().rooms[rid]?.t ?? 'c';
    for (const u of users) {
      await rest.inviteToRoom(rid, type, u._id);
    }
    // 邀请后清缓存，成员面板重新拉取
    const members = { ...get().members };
    delete members[rid];
    set({ members });
    toast.success(
      users.length === 1
        ? `已添加 ${users[0].name || users[0].username}`
        : `已添加 ${users.length} 位成员`,
    );
  },

  editMessage: async (msgId, text) => {
    const rid = get().activeRid;
    if (!rid || !text.trim()) return;
    try {
      const updated = await rest.updateMessage(rid, msgId, text.trim());
      set({
        messages: { ...get().messages, [rid]: upsertMessage(get().messages[rid] ?? [], updated) },
      });
    } catch (err) {
      toast.error(err, '编辑失败');
    }
  },

  deleteMessage: async (msgId) => {
    const rid = get().activeRid;
    if (!rid) return;
    try {
      await rest.deleteMessage(rid, msgId);
      const list = get().messages[rid] ?? [];
      set({ messages: { ...get().messages, [rid]: list.filter((m) => m._id !== msgId) } });
      const panel = get().rightPanel;
      if (panel?.kind === 'thread' && panel.mid === msgId) set({ rightPanel: null });
    } catch (err) {
      toast.error(err, '删除失败');
    }
  },

  toggleReaction: async (messageId, emoji) => {
    try {
      await rest.react(messageId, emoji);
    } catch (err) {
      toast.error(err, '表情回应失败');
    }
  },

  togglePin: async (msg) => {
    // RC 置顶/取消置顶不会推送消息更新事件，本地乐观更新 pinned 标志
    const rid = msg.rid;
    const apply = (value: boolean) => {
      const list = get().messages[rid];
      if (!list) return;
      set({
        messages: {
          ...get().messages,
          [rid]: list.map((m) => (m._id === msg._id ? { ...m, pinned: value } : m)),
        },
      });
    };
    apply(!msg.pinned);
    try {
      if (msg.pinned) await rest.unpinMessage(msg._id);
      else await rest.pinMessage(msg._id);
      toast.success(msg.pinned ? '已取消置顶' : '已置顶');
    } catch (err) {
      apply(!!msg.pinned); // 失败回滚
      toast.error(err, msg.pinned ? '取消置顶失败' : '置顶失败');
    }
  },

  toggleStar: async (msg) => {
    // 与置顶同理：服务器不推送星标变更，本地乐观更新
    const rid = msg.rid;
    const auth = loadStoredAuth();
    const mine = { _id: auth?.userId ?? '' };
    const starred = msg.starred?.some((s) => s._id === mine._id);
    const apply = (value: boolean) => {
      const list = get().messages[rid];
      if (!list) return;
      set({
        messages: {
          ...get().messages,
          [rid]: list.map((m) =>
            m._id === msg._id
              ? {
                  ...m,
                  starred: value
                    ? [...(m.starred ?? []), mine]
                    : (m.starred ?? []).filter((s) => s._id !== mine._id),
                }
              : m,
          ),
        },
      });
    };
    apply(!starred);
    try {
      if (starred) await rest.unstarMessage(msg._id);
      else await rest.starMessage(msg._id);
      toast.success(starred ? '已取消标记' : '已标记');
    } catch (err) {
      apply(!!starred);
      toast.error(err, starred ? '取消标记失败' : '标记失败');
    }
  },

  toggleFavorite: async (conv) => {
    try {
      await rest.favoriteRoom(conv.rid, !conv.favorite);
      toast.success(conv.favorite ? '已取消收藏' : '已收藏');
    } catch (err) {
      toast.error(err, '收藏操作失败');
    }
  },

  toggleMute: async (conv) => {
    try {
      await rest.muteRoom(conv.rid, !conv.muted);
      // rooms.saveNotification 不一定推送订阅变更，本地同步一份
      const sub = get().subscriptions[conv.rid];
      if (sub) {
        set({
          subscriptions: {
            ...get().subscriptions,
            [conv.rid]: { ...sub, disableNotifications: !conv.muted },
          },
        });
      }
      toast.success(conv.muted ? '已取消免打扰' : '已开启免打扰');
    } catch (err) {
      toast.error(err, '免打扰设置失败');
    }
  },

  markConvRead: async (rid) => {
    try {
      await rest.markRead(rid);
    } catch (err) {
      toast.error(err, '标为已读失败');
    }
  },

  hideConv: async (conv) => {
    try {
      await rest.hideRoom(conv.rid, conv.type);
      const sub = get().subscriptions[conv.rid];
      if (sub) {
        set({
          subscriptions: { ...get().subscriptions, [conv.rid]: { ...sub, open: false } },
        });
      }
      if (get().activeRid === conv.rid) set({ activeRid: null, rightPanel: null });
      toast.success(`已隐藏「${conv.name}」，收到新消息时会重新出现`);
    } catch (err) {
      toast.error(err, '隐藏会话失败');
    }
  },

  saveRoomSettings: async (rid, settings) => {
    const room = get().rooms[rid];
    try {
      await rest.saveRoomSettings(rid, settings);
      // 服务端不一定推送房间更新，本地先合并一份
      if (room) set({ rooms: { ...get().rooms, [rid]: { ...room, ...settings } } });
      toast.success('已保存');
    } catch (err) {
      toast.error(err, '保存失败，可能是你没有该群的管理权限');
      throw err;
    }
  },

  leaveConv: async (conv) => {
    try {
      // DM 不能「退出」，只能隐藏
      if (conv.type === 'd') await rest.hideRoom(conv.rid, conv.type);
      else await rest.leaveRoom(conv.rid, conv.type);
      const subs = { ...get().subscriptions };
      delete subs[conv.rid];
      set({ subscriptions: subs });
      if (get().activeRid === conv.rid) set({ activeRid: null, rightPanel: null });
      toast.success(conv.type === 'd' ? `已隐藏「${conv.name}」` : `已退出「${conv.name}」`);
    } catch (err) {
      toast.error(err, '退出失败');
    }
  },

  forwardMessage: async (msg, rids) => {
    const names = rids.map(
      (rid) => get().subscriptions[rid]?.fname || get().subscriptions[rid]?.name || '会话',
    );
    for (const rid of rids) {
      await rest.sendMessageRaw({
        rid,
        msg: stripQuotePrefix(msg.msg || '') || undefined,
        attachments: msg.attachments?.filter((a) => !a.message_link),
      });
    }
    toast.success(
      rids.length === 1 ? `已转发到「${names[0]}」` : `已转发到 ${rids.length} 个会话`,
    );
  },

  setDraft: (rid, text) => {
    const drafts = { ...get().drafts };
    if (text) drafts[rid] = text;
    else delete drafts[rid];
    set({ drafts });
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
    } catch {
      /* 存储满时忽略 */
    }
  },

  startDM: async (username) => {
    const room = await rest.createDirectMessage(username);
    await rest.openDirectMessage(room._id).catch(() => {});
    await refreshSubsAndRooms(set);
    await get().openRoom(room._id);
    return room._id;
  },

  createGroup: async (name, members, priv) => {
    const room = await rest.createGroup(name, members, priv);
    await refreshSubsAndRooms(set);
    await get().openRoom(room._id);
    toast.success(`已创建群组「${name}」`);
    return room._id;
  },

  createTeam: async (name, members, priv) => {
    const team = await rest.createTeam(name, members, priv);
    await refreshSubsAndRooms(set);
    await get().openRoom(team.roomId);
    toast.success(`已创建团队「${name}」`);
    return team.roomId;
  },

  createDiscussionFrom: async (msg) => {
    const id = toast.loading('正在创建讨论…');
    try {
      const name = (stripQuotePrefix(msg.msg) || '讨论').slice(0, 40);
      const room = await rest.createDiscussion(msg.rid, name, msg._id);
      await refreshSubsAndRooms(set);
      await get().openRoom(room._id);
      toast.update(id, { kind: 'success', message: `已创建讨论「${name}」` });
    } catch (err) {
      toast.update(id, { kind: 'error', message: humanError(err, '创建讨论失败') });
    }
  },

  requestUpload: (files) => {
    if (files.length > 0) set({ pendingFiles: files });
  },

  confirmUpload: async () => {
    const files = get().pendingFiles;
    set({ pendingFiles: null });
    if (files) await get().uploadFiles(files);
  },

  cancelUpload: () => set({ pendingFiles: null }),

  uploadFiles: async (files, tmid) => {
    const rid = get().activeRid;
    if (!rid || files.length === 0) return;
    const label = files.length === 1 ? files[0].name : `${files.length} 个文件`;
    const id = toast.loading(`正在发送 ${label}…`);
    set({ uploading: get().uploading + files.length });
    try {
      for (const file of files) {
        await rest.uploadMedia(rid, file, { tmid });
        set({ uploading: get().uploading - 1 });
      }
      toast.dismiss(id);
    } catch (err) {
      set({ uploading: 0 });
      toast.update(id, {
        kind: 'error',
        message: humanError(err, `发送 ${label} 失败`),
      });
    }
  },
}));

if (typeof window !== 'undefined') window.__chat = useChat;

/** 派生会话列表：订阅 + 房间信息合并，按最新消息时间排序（配合 useMemo 使用） */
export function buildConversations(
  subscriptions: Record<string, RcSubscription>,
  rooms: Record<string, RcRoom>,
): Conversation[] {
  const items: Conversation[] = [];
  for (const sub of Object.values(subscriptions)) {
    if (sub.open === false) continue;
    const room = rooms[sub.rid];
    /**
     * 只认「真实的最后一条消息时间」。
     * 早先这里还兜底取了 sub._updatedAt，可打开会话本身就会更新订阅（清未读、写 ls），
     * _updatedAt 变成此刻 → 会话直接窜到列表顶部，看起来像「点谁谁置顶」。
     * 没有任何消息的空会话拿不到时间，排在最后即可。
     */
    const lastTs = Math.max(tsMs(room?.lm), tsMs(room?.lastMessage?.ts));
    const prid = sub.prid ?? room?.prid;
    const parent = prid ? rooms[prid] : undefined;
    /**
     * 多人直聊：Rocket.Chat 里它的 t 仍然是 'd'，只是成员多于两人
     * （fname 形如「Rocket.Cat, 张三」）。对用户来说这是群聊，不该混进「单聊」。
     * room 还没加载时退化用名字里的逗号判断。
     */
    const dmSize = room?.uids?.length ?? room?.usersCount;
    const isMultiDM =
      sub.t === 'd' && (dmSize !== undefined ? dmSize > 2 : (sub.fname ?? sub.name).includes(','));
    items.push({
      rid: sub.rid,
      name: sub.fname || sub.name,
      type: sub.t,
      unread: sub.unread,
      alert: sub.alert,
      userMentions: sub.userMentions ?? 0,
      favorite: !!sub.f,
      muted: !!sub.disableNotifications,
      isDiscussion: !!prid,
      isMultiDM,
      parentName: parent ? parent.fname || parent.name : undefined,
      // Team 标记在 room 对象上（订阅里没有）
      isTeam: !!(room?.teamMain ?? sub.teamMain),
      teamId: room?.teamId ?? sub.teamId,
      lastTs,
      lastPreview: messagePreview(room?.lastMessage),
      // 多人直聊没有「对方」，不能拿某个人的头像顶上
      avatarUsername: sub.t === 'd' && !isMultiDM ? sub.name : undefined,
    });
  }
  // 置顶会话在前，其余按最新消息时间
  items.sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.lastTs - a.lastTs);
  return items;
}

/** 会话归入哪个分区（顺序即优先级，与 RC 官方一致） */
export function sectionOf(conv: Conversation): SectionKey {
  if (conv.favorite) return 'favorites';
  if (conv.isTeam) return 'teams';
  if (conv.isDiscussion) return 'discussions';
  // 多人直聊归到频道/群组区，「私聊」区只放 1 对 1
  if (conv.type === 'd' && !conv.isMultiDM) return 'direct';
  return 'channels';
}

/**
 * 把会话切分成分区。
 * showUnread: 未读单独置顶成一个分区
 * showFavorites: 收藏独立成区（否则收藏会话仍留在原类型分区里，只是排前面）
 * groupByType: 关闭时不分区，全部混在一起
 */
export function buildSections(
  convs: Conversation[],
  opts: {
    groupByType: boolean;
    showUnread: boolean;
    showFavorites: boolean;
    sortBy: 'activity' | 'alphabetical';
  },
): { key: SectionKey | 'all'; label: string; items: Conversation[] }[] {
  const sortFn = (a: Conversation, b: Conversation) =>
    opts.sortBy === 'alphabetical'
      ? a.name.localeCompare(b.name, 'zh-CN')
      : b.lastTs - a.lastTs;

  const rest = [...convs];
  const sections: { key: SectionKey | 'all'; label: string; items: Conversation[] }[] = [];

  if (opts.showUnread) {
    const unread = rest.filter((c) => c.unread > 0 || c.alert);
    if (unread.length > 0) {
      sections.push({ key: 'unread', label: SECTION_LABELS.unread, items: unread.sort(sortFn) });
      for (const c of unread) rest.splice(rest.indexOf(c), 1);
    }
  }

  if (!opts.groupByType) {
    const favorites = opts.showFavorites ? rest.filter((c) => c.favorite) : [];
    if (favorites.length > 0) {
      sections.push({
        key: 'favorites',
        label: SECTION_LABELS.favorites,
        items: favorites.sort(sortFn),
      });
      for (const c of favorites) rest.splice(rest.indexOf(c), 1);
    }
    sections.push({ key: 'all', label: '会话', items: rest.sort(sortFn) });
    return sections;
  }

  const order: SectionKey[] = ['favorites', 'teams', 'discussions', 'channels', 'direct'];
  const buckets = new Map<SectionKey, Conversation[]>();
  for (const c of rest) {
    const key = opts.showFavorites ? sectionOf(c) : sectionOf({ ...c, favorite: false });
    const list = buckets.get(key) ?? [];
    list.push(c);
    buckets.set(key, list);
  }
  for (const key of order) {
    const items = buckets.get(key);
    if (items?.length) {
      sections.push({ key, label: SECTION_LABELS[key], items: items.sort(sortFn) });
    }
  }
  return sections;
}
