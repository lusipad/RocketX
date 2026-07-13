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
import { useAuth } from './auth';

export interface Conversation {
  rid: string;
  name: string;
  type: RcSubscription['t'];
  unread: number;
  alert: boolean;
  /** 置顶会话 */
  favorite: boolean;
  /** 免打扰 */
  muted: boolean;
  /** 讨论（Discussion，父房间的子会话） */
  isDiscussion: boolean;
  /** 讨论所属的父会话名 */
  parentName?: string;
  lastTs: number;
  lastPreview: string;
  /** DM 用对方用户名取头像 */
  avatarUsername?: string;
}

/** 右侧面板：话题 / Pin 列表 / 标记 / 群成员 / 消息搜索，同一时刻只开一个 */
export type RightPanel =
  | { kind: 'thread'; mid: string }
  | { kind: 'pins' }
  | { kind: 'starred' }
  | { kind: 'members' }
  | { kind: 'search' }
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
  forwardMessage: (msg: RcMessage, rids: string[]) => Promise<void>;
  setDraft: (rid: string, text: string) => void;
  /** 发起私聊：创建/打开 DM 并跳转，返回房间 id */
  startDM: (username: string) => Promise<string>;
  /** 创建群组并跳转，返回房间 id */
  createGroup: (name: string, members: string[], priv: boolean) => Promise<string>;
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
  const text = (msg.msg ?? '').replace(QUOTE_LINK_RE, '');
  if (text) return who ? `${who}: ${text}` : text;
  if (msg.attachments?.length) return who ? `${who}: [卡片消息]` : '[卡片消息]';
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
  const inactive = state.activeRid !== rid || document.hidden;
  if (!inactive) return;
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
    realtime.onStatus = (s) => set({ connection: s });
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
    } catch {
      // 标记失败，可重试
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
  },

  editMessage: async (msgId, text) => {
    const rid = get().activeRid;
    if (!rid || !text.trim()) return;
    const updated = await rest.updateMessage(rid, msgId, text.trim());
    set({ messages: { ...get().messages, [rid]: upsertMessage(get().messages[rid] ?? [], updated) } });
  },

  deleteMessage: async (msgId) => {
    const rid = get().activeRid;
    if (!rid) return;
    await rest.deleteMessage(rid, msgId);
    const list = get().messages[rid] ?? [];
    set({ messages: { ...get().messages, [rid]: list.filter((m) => m._id !== msgId) } });
    const panel = get().rightPanel;
    if (panel?.kind === 'thread' && panel.mid === msgId) set({ rightPanel: null });
  },

  toggleReaction: async (messageId, emoji) => {
    await rest.react(messageId, emoji).catch(() => {});
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
    } catch {
      apply(!!msg.pinned); // 失败回滚
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
    } catch {
      apply(!!starred);
    }
  },

  toggleFavorite: async (conv) => {
    await rest.favoriteRoom(conv.rid, !conv.favorite).catch(() => {});
  },

  toggleMute: async (conv) => {
    await rest.muteRoom(conv.rid, !conv.muted).catch(() => {});
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
  },

  markConvRead: async (rid) => {
    await rest.markRead(rid).catch(() => {});
  },

  hideConv: async (conv) => {
    await rest.hideRoom(conv.rid, conv.type).catch(() => {});
    const sub = get().subscriptions[conv.rid];
    if (sub) {
      set({
        subscriptions: { ...get().subscriptions, [conv.rid]: { ...sub, open: false } },
      });
    }
    if (get().activeRid === conv.rid) set({ activeRid: null, rightPanel: null });
  },

  forwardMessage: async (msg, rids) => {
    for (const rid of rids) {
      await rest.sendMessageRaw({
        rid,
        msg: msg.msg || undefined,
        attachments: msg.attachments,
      });
    }
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
    return room._id;
  },

  createDiscussionFrom: async (msg) => {
    const name = (msg.msg || '讨论').slice(0, 40);
    const room = await rest.createDiscussion(msg.rid, name, msg._id);
    await refreshSubsAndRooms(set);
    await get().openRoom(room._id);
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
    set({ uploading: get().uploading + files.length });
    try {
      for (const file of files) {
        await rest.uploadMedia(rid, file, { tmid });
        set({ uploading: get().uploading - 1 });
      }
    } catch (err) {
      set({ uploading: 0 });
      throw err;
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
    const lastTs = Math.max(tsMs(room?.lm), tsMs(room?.lastMessage?.ts), tsMs(sub._updatedAt));
    const prid = sub.prid ?? room?.prid;
    const parent = prid ? rooms[prid] : undefined;
    items.push({
      rid: sub.rid,
      name: sub.fname || sub.name,
      type: sub.t,
      unread: sub.unread,
      alert: sub.alert,
      favorite: !!sub.f,
      muted: !!sub.disableNotifications,
      isDiscussion: !!prid,
      parentName: parent ? parent.fname || parent.name : undefined,
      lastTs,
      lastPreview: messagePreview(room?.lastMessage),
      avatarUsername: sub.t === 'd' ? sub.name : undefined,
    });
  }
  // 置顶会话在前，其余按最新消息时间
  items.sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.lastTs - a.lastTs);
  return items;
}
