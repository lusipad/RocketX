import { create } from 'zustand';
import {
  tsMs,
  type RcMessage,
  type RcRoom,
  type RcSubscription,
  type RcUser,
  type RealtimeStatus,
} from '@rcx/rc-client';
import { loadStoredAuth, realtime, rest } from '../lib/client';

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

  init: () => Promise<void>;
  openRoom: (rid: string) => Promise<void>;
  openThread: (mid: string) => Promise<void>;
  setPanel: (panel: RightPanel) => void;
  loadOlder: () => Promise<number>;
  loadMembers: (rid: string) => Promise<RcUser[]>;
  send: (text: string, tmid?: string) => Promise<void>;
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
  if (msg.msg) return who ? `${who}: ${msg.msg}` : msg.msg;
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

function scheduleMarkRead(rid: string) {
  if (markReadTimer) clearTimeout(markReadTimer);
  markReadTimer = setTimeout(() => {
    rest.markRead(rid).catch(() => {});
  }, 600);
}

function subscribeRoomStreams(rid: string) {
  if (subscribedRooms.has(rid)) return;
  subscribedRooms.add(rid);
  realtime.subscribe('stream-room-messages', rid);
  realtime.subscribe('stream-notify-room', `${rid}/deleteMessage`);
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

  init: async () => {
    const auth = loadStoredAuth();
    if (!auth) return;

    const [subs, rooms] = await Promise.all([rest.getSubscriptions(), rest.getRooms()]);
    const subMap: Record<string, RcSubscription> = {};
    for (const s of subs) subMap[s.rid] = s;
    const roomMap: Record<string, RcRoom> = {};
    for (const r of rooms) roomMap[r._id] = r;
    set({ subscriptions: subMap, rooms: roomMap, ready: true });

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
      if (get().activeRid === rid) scheduleMarkRead(rid);
    });

    realtime.onStream('stream-notify-room', (eventName, args) => {
      if (!eventName.endsWith('/deleteMessage')) return;
      const rid = eventName.split('/')[0];
      const deleted = args[0] as { _id: string } | undefined;
      if (!deleted?._id) return;
      const list = get().messages[rid];
      if (!list) return;
      set({ messages: { ...get().messages, [rid]: list.filter((m) => m._id !== deleted._id) } });
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
    set({ activeRid: rid, rightPanel: null, unreadMarkTs: marks, pendingFiles: null });

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

  send: async (text, tmid) => {
    const rid = get().activeRid;
    const trimmed = text.trim();
    if (!rid || !trimmed) return;
    const msg = await rest.sendMessage(rid, trimmed, tmid);
    set({
      messages: { ...get().messages, [rid]: upsertMessage(get().messages[rid] ?? [], msg) },
      ...(tmid ? {} : { scrollNonce: get().scrollNonce + 1 }),
    });
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
    items.push({
      rid: sub.rid,
      name: sub.fname || sub.name,
      type: sub.t,
      unread: sub.unread,
      alert: sub.alert,
      favorite: !!sub.f,
      muted: !!sub.disableNotifications,
      lastTs,
      lastPreview: messagePreview(room?.lastMessage),
      avatarUsername: sub.t === 'd' ? sub.name : undefined,
    });
  }
  // 置顶会话在前，其余按最新消息时间
  items.sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.lastTs - a.lastTs);
  return items;
}
