import { create } from 'zustand';
import {
  RcApiError,
  tsMs,
  type RcMessage,
  type RcMessageAttachment,
  type RcRoom,
  type RcRoomRole,
  type RcSlashCommand,
  type RcSubscription,
  type RcUser,
  type RealtimeStatus,
} from '@rcx/rc-client';
import {
  ensureSiteUrl,
  getPublicSetting,
  loadStoredAuth,
  realtime,
  rest,
  siteUrlSync,
} from '../lib/client';
import { emojify } from '../lib/emoji';
import { findCommand } from '../lib/slash';
import { kernelRegistry } from '../kernel/registry';
import { desktopNotify } from '../lib/notify';
import { flashTaskbar } from '../lib/taskbar';
import { forwardableAttachments, mergedForwardAttachments } from '../lib/forward';
import { QUOTE_LINK_RE, stripQuotePrefix } from '../lib/messageText';
import {
  canApplyRetainedRoomResult,
  omitRoomEntries,
  retainRecentRooms,
  trimRoomMessages,
} from '../lib/chatMemory';
import { useUiPrefs } from './uiPrefs';
import { createActiveRoomStreams } from '../lib/roomStreams';
import { useAuth } from './auth';
import { usePrefs } from './prefs';
import { useOnboarding } from './onboarding';
import { humanError, toast } from './toast';
import { useUI } from './ui';
import { routeNotification, type NotificationAggregationInput } from '../lib/notificationAggregation';
import { useNotificationAggregation } from './notificationAggregation';

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
  /** 已从常用会话列表隐藏 */
  hidden: boolean;
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
  /** 多人聊天：临时拉起来的、没有名字的群聊 */
  | 'multi'
  | 'direct';

export const SECTION_LABELS: Record<SectionKey, string> = {
  unread: '未读',
  favorites: '收藏',
  teams: '团队',
  discussions: '讨论',
  channels: '频道与群组',
  multi: '多人聊天',
  direct: '私聊',
};

/** 右侧面板：话题 / Pin / 标记 / 成员 / 搜索 / 群信息 / 文件 / 提及我的，同一时刻只开一个 */
export type RightPanel =
  | { kind: 'thread'; mid: string }
  | { kind: 'pins' }
  | { kind: 'starred' }
  | { kind: 'members' }
  | { kind: 'search' }
  | { kind: 'info' }
  | { kind: 'files'; fileId?: string }
  | { kind: 'mentions' }
  | { kind: 'ai' }
  | { kind: 'agent'; tmid: string }
  | { kind: `app:${string}`; props?: unknown }
  | null;

const HISTORY_PAGE = 50;
const INACTIVE_ROOM_MESSAGE_LIMIT = 60;
const RECENT_INACTIVE_ROOM_LIMIT = 8;
const DRAFTS_KEY = 'rcx-drafts';

export function roomMembershipPolicy(
  hasSubscription: boolean,
  room: Pick<RcRoom, 't' | 'prid'> | undefined,
): { requiresJoin: boolean; canCompose: boolean } {
  const requiresJoin = !hasSubscription && !!room && (room.t === 'c' || !!room.prid);
  return {
    requiresJoin,
    // Rocket.Chat 允许父房间成员在未订阅讨论时查看和发送消息；加入只负责订阅通知。
    canCompose: !requiresJoin || !!room?.prid,
  };
}

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
  /** 成员拉取失败的原因:rid -> 错误文案。用来把「拉取失败」和「群里真没人」区分开 */
  memberErrors: Record<string, string>;
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
  /** 服务器提供的斜杠命令（登录后拉一次，全局共用） */
  slashCommands: RcSlashCommand[];
  /** 房间里有角色的人：rid -> [{ u, roles: ['owner'] }]。普通成员不在里面 */
  roomRoles: Record<string, RcRoomRole[]>;
  /** 其他人的在线状态：username -> 'online' | 'away' | 'busy' | 'offline'。
      按用户名键（各处都拿得到用户名；DM 房间 id 推不出对端 userId）。
      初值由通讯录/成员列表播种，之后靠 stream-notify-logged/user-status 实时更新 */
  userStatus: Record<string, string>;

  init: () => Promise<void>;
  /** 批量播种在线状态（通讯录/成员列表拿到 status 时调用，不覆盖已有的实时值） */
  seedUserStatus: (users: { username: string; status?: string }[]) => void;
  /** 滚到当前会话最新消息。再点一次已打开的会话时用（跳看历史后想回底部） */
  scrollToLatest: () => void;
  openRoom: (rid: string) => Promise<void>;
  openThread: (mid: string) => Promise<void>;
  setPanel: (panel: RightPanel) => void;
  loadOlder: () => Promise<number>;
  loadMembers: (rid: string) => Promise<RcUser[]>;
  send: (text: string, opts?: { rid?: string; tmid?: string; quote?: RcMessage }) => Promise<void>;
  /** 执行斜杠命令。tmid 有值时在话题里执行 */
  runSlash: (command: string, params: string, tmid?: string) => Promise<void>;

  /** 拉房间详情并并回 store（rooms.get 的字段不全，公告/禁言名单/归档只有 rooms.info 有） */
  refreshRoomInfo: (rid: string) => Promise<RcRoom | null>;
  /** 从父频道的「讨论」卡片跳进讨论 */
  openDiscussion: (drid: string) => Promise<void>;
  /** 加入公开频道/讨论，成功后刷新订阅让它进会话列表 */
  joinRoom: (rid: string) => Promise<void>;
  loadRoomRoles: (rid: string) => Promise<RcRoomRole[]>;
  kickMember: (rid: string, user: RcUser) => Promise<void>;
  setMemberRole: (
    rid: string,
    user: RcUser,
    role: 'owner' | 'moderator' | 'leader',
    grant: boolean,
  ) => Promise<void>;
  toggleMemberMute: (rid: string, user: RcUser) => Promise<void>;
  setRoomReadOnly: (rid: string, readOnly: boolean) => Promise<void>;
  archiveConv: (rid: string, archive: boolean) => Promise<void>;
  deleteConv: (rid: string) => Promise<void>;
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
  /**
   * 从服务端拉取置顶列表并把本房间消息的 pinned 标志同步成服务端状态，
   * 返回置顶消息列表。RC 不随消息更新推送置顶变化，别人置顶后本地永远不知道 ——
   * 右键菜单就只有「置顶」、看不到「取消置顶」（issue #19-5）。
   */
  reconcilePinned: (rid: string) => Promise<RcMessage[]>;
  toggleStar: (msg: RcMessage) => Promise<void>;
  toggleFavorite: (conv: Conversation) => Promise<void>;
  toggleMute: (conv: Conversation) => Promise<void>;
  markConvRead: (rid: string) => Promise<void>;
  hideConv: (conv: Conversation) => Promise<void>;
  restoreConv: (conv: Conversation) => Promise<void>;
  /** 改群设置（话题/公告/描述/名称）；无权限时会抛出 */
  saveRoomSettings: (
    rid: string,
    settings: { topic?: string; announcement?: string; description?: string; name?: string },
  ) => Promise<void>;
  /** 退出群组（DM 只能隐藏） */
  leaveConv: (conv: Conversation) => Promise<void>;
  forwardMessage: (msg: RcMessage, rids: string[]) => Promise<void>;
  /** 多条消息转发到多个会话。merge=true 合并成一条「聊天记录」卡片，否则逐条 */
  forwardMessages: (msgs: RcMessage[], rids: string[], merge: boolean) => Promise<void>;
  /** 消息多选（合并转发用）：是否在多选态、选中的消息 id */
  selectMode: boolean;
  selectedMids: Set<string>;
  enterSelectMode: (mid: string) => void;
  toggleSelectMid: (mid: string) => void;
  exitSelectMode: () => void;
  setDraft: (rid: string, text: string) => void;
  /**
   * 开启直聊并跳转，返回房间 id。
   * 传多个用户名即多人直聊 —— 不用起群名、选完人就能聊的那种群聊。
   */
  startDM: (usernames: string | string[]) => Promise<string>;
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

/**
 * chat.sendMessage 的即时响应可能早于服务端引用展开，不带 attachments。
 * 同 id 的乐观/WS 消息已有引用卡时，不能被这个半成品响应覆盖。
 */
export function mergeMessageUpdate(current: RcMessage, incoming: RcMessage): RcMessage {
  const quote = current.attachments?.find((attachment) => attachment.message_link);
  const incomingHasQuote = incoming.attachments?.some((attachment) => attachment.message_link);
  if (quote && !incomingHasQuote && QUOTE_LINK_RE.test(incoming.msg)) {
    return {
      ...incoming,
      attachments: [quote, ...(incoming.attachments ?? [])],
    };
  }
  return incoming;
}

function upsertMessage(list: RcMessage[], msg: RcMessage): RcMessage[] {
  const idx = list.findIndex((m) => m._id === msg._id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = mergeMessageUpdate(list[idx], msg);
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

const subscribeRoomStreams = createActiveRoomStreams(
  (stream, key) => realtime.subscribe(stream, key),
  (stream, key) => realtime.unsubscribe(stream, key),
);
let markReadTimer: ReturnType<typeof setTimeout> | null = null;
let receiptTimer: ReturnType<typeof setTimeout> | null = null;
let lastTypingEmit = 0;
/** 正在飞的 channels.roles 请求，按房间去重 */
const rolesInflight = new Map<string, Promise<RcRoomRole[]>>();
/** 成员列表请求版本；邀请/移除后让更早的请求结果失效，避免旧名单回滚新状态。 */
const memberVersions = new Map<string, number>();
/** 同一房间、同一版本的成员请求共享一个 Promise，避免多个面板重复全量分页。 */
const memberInflight = new Map<string, { version: number; promise: Promise<RcUser[]> }>();
/** 服务端成员快照确认前，跨并发请求保留本地已成功的增删变更。 */
const pendingMemberAdds = new Map<string, Map<string, RcUser>>();
const pendingMemberRemovals = new Map<string, Set<string>>();
let retainedRoomOrder: string[] = [];
let retainedRoomGeneration = 0;

function memberVersion(rid: string): number {
  return memberVersions.get(rid) ?? 0;
}

function invalidateMemberRequests(rid: string): number {
  const next = memberVersion(rid) + 1;
  memberVersions.set(rid, next);
  return next;
}

function requestMemberSnapshot(rid: string, type: RcRoom['t'], version: number): Promise<RcUser[]> {
  const current = memberInflight.get(rid);
  if (current?.version === version) return current.promise;

  const promise = rest.getMembers(rid, type);
  memberInflight.set(rid, { version, promise });
  const clear = () => {
    if (memberInflight.get(rid)?.promise === promise) memberInflight.delete(rid);
  };
  void promise.then(clear, clear);
  return promise;
}

function resetMemberRequestState() {
  for (const rid of memberInflight.keys()) invalidateMemberRequests(rid);
  memberInflight.clear();
  pendingMemberAdds.clear();
  pendingMemberRemovals.clear();
}

function resetRoomRetention() {
  retainedRoomOrder = [];
  retainedRoomGeneration += 1;
}

function evictMemberRequestState(rid: string) {
  if (memberInflight.has(rid)) {
    invalidateMemberRequests(rid);
    memberInflight.delete(rid);
  } else {
    memberVersions.delete(rid);
  }
  pendingMemberAdds.delete(rid);
  pendingMemberRemovals.delete(rid);
}

function compactEvictedRoomData(state: ChatState, evictedRids: readonly string[]) {
  return {
    messages: trimRoomMessages(state.messages, evictedRids, INACTIVE_ROOM_MESSAGE_LIMIT),
    historyLoaded: omitRoomEntries(state.historyLoaded, evictedRids),
    hasMore: omitRoomEntries(state.hasMore, evictedRids),
    members: omitRoomEntries(state.members, evictedRids),
    memberErrors: omitRoomEntries(state.memberErrors, evictedRids),
    typing: omitRoomEntries(state.typing, evictedRids),
    readReceipts: omitRoomEntries(state.readReceipts, evictedRids),
    roomRoles: omitRoomEntries(state.roomRoles, evictedRids),
  };
}

function stageMemberAdds(rid: string, users: RcUser[]) {
  const additions = pendingMemberAdds.get(rid) ?? new Map<string, RcUser>();
  const removals = pendingMemberRemovals.get(rid);
  for (const user of users) {
    additions.set(user._id, user);
    removals?.delete(user._id);
  }
  pendingMemberAdds.set(rid, additions);
}

function stageMemberRemoval(rid: string, userId: string) {
  pendingMemberAdds.get(rid)?.delete(userId);
  const removals = pendingMemberRemovals.get(rid) ?? new Set<string>();
  removals.add(userId);
  pendingMemberRemovals.set(rid, removals);
}

function applyPendingMemberChanges(
  rid: string,
  members: RcUser[],
  serverSnapshot = false,
): RcUser[] {
  const merged = new Map(members.map((member) => [member._id, member]));
  const additions = pendingMemberAdds.get(rid);
  for (const [id, member] of additions ?? []) {
    if (serverSnapshot && merged.has(id)) additions?.delete(id);
    else merged.set(id, member);
  }
  const removals = pendingMemberRemovals.get(rid);
  for (const id of removals ?? []) {
    if (serverSnapshot && !merged.has(id)) removals?.delete(id);
    else merged.delete(id);
  }
  if (additions?.size === 0) pendingMemberAdds.delete(rid);
  if (removals?.size === 0) pendingMemberRemovals.delete(rid);
  return [...merged.values()];
}
/**
 * 已读回执是 RC 企业版功能。
 *
 * init 时读一次服务器的 Message_Read_Receipt_Enabled 就能知道支不支持，用不着先打过去
 * 挨一个 400 再降级 —— 社区版每次刷新页面都会在控制台留一条红色错误，白打一个请求。
 * 请求失败时的熔断（refreshReceipts 的 catch）作为兜底保留：万一设置读不到，行为不变。
 */
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

/**
 * 房间类型。订阅里没有就退到 rooms —— 从讨论卡片跳进一个自己还没订阅的私有讨论时，
 * 只有 rooms[rid] 有值。少了这层兜底，'p' 会被当成 'c'，归档/只读/删除全都会打到
 * channels.* 而不是 groups.*，报「房间不存在」。
 */
function roomTypeOf(
  state: Pick<ChatState, 'subscriptions' | 'rooms'>,
  rid: string,
): RcSubscription['t'] {
  return state.subscriptions[rid]?.t ?? state.rooms[rid]?.t ?? 'c';
}

/**
 * 客户端生成消息 _id（Meteor Random.id() 同款：17 位、去掉易混字符的字母表）。
 * 乐观消息与提交给服务端的是同一个 id —— WS 回声、REST 响应都带它，
 * upsertMessage 按 _id 天然合并，杜绝「同一条消息显示两遍」和「重试发出第二条」。
 */
const ID_CHARS = '23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz';
function randomMessageId(): string {
  let s = '';
  for (let i = 0; i < 17; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

/** RC 用户状态的数字编码 → 语义字符串 */
const STATUS_BY_NUM: Record<number, string> = {
  0: 'offline',
  1: 'online',
  2: 'away',
  3: 'busy',
};

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
 *
 * site 必须精确等于服务端配置的 Site_Url，否则服务端不展开（实测:前缀差一点就
 * 完全不展开）。调用方要传 ensureSiteUrl() 拿到的值，别用可能回退到 getServerBase()
 * 的 siteUrlSync()——桌面端填 IP / 经代理访问时两者不一致，就会「有动画没引用」(#9)。
 */
function quoteLinkPrefix(
  quoted: RcMessage,
  subs: Record<string, RcSubscription>,
  site: string,
): string {
  return `[ ](${site}/${roomPath(quoted.rid, subs)}?msg=${quoted._id})\n`;
}

/**
 * 消息的永久链接（右键「复制消息链接」）。
 *
 * 复用 roomPath —— 引用回复用的就是它，而且服务端能正确解析（引用会被展开成附件），
 * 是被验证过的。**别照着 room.name 另拼一份**：DM 的房间文档根本没有 name / fname
 * （实测：room.name=undefined，名字只在订阅上），那样拼出来是 `/direct/?msg=xxx`，
 * 段名为空，打开是个死链。DM 要用 rid。
 */
export function permalinkOf(rid: string, mid: string): string {
  return `${siteUrlSync()}/${roomPath(rid, useChat.getState().subscriptions)}?msg=${mid}`;
}

/** 本地乐观展示用的引用附件（服务器确认后会被展开后的正式附件替换） */
export function localQuoteAttachment(quoted: RcMessage): RcMessageAttachment {
  const image = quoted.attachments?.find((attachment) => !!attachment.image_url);
  return {
    message_link: `local-quote`,
    author_name: quoted.u.name || quoted.u.username,
    text: stripQuotePrefix(quoted.msg) || quoted.attachments?.[0]?.title || '[卡片消息]',
    ts: quoted.ts,
    ...(image
      ? {
          image_url: image.image_url,
          image_dimensions: image.image_dimensions,
          title: image.title,
          title_link: image.title_link,
        }
      : {}),
  };
}

/** 消息文本开头的引用链接（渲染与预览时隐藏） */
export { QUOTE_LINK_RE, stripQuotePrefix } from '../lib/messageText';

// 开发调试：控制台可通过 window.__chat 检查 store 状态
declare global {
  interface Window {
    __chat?: typeof useChat;
  }
}

// 已处理过通知的消息 id：__my_messages__ 全局流和房间订阅流可能各送一次同一条消息，
// 不去重的话桌面通知会弹两遍（浏览器端有 tag 去重，Tauri 通知插件没有）
const notifiedMids = new Set<string>();

export function notificationAttentionPolicy(input: {
  subscribed: boolean;
  muted: boolean;
  mentioned: boolean;
  focused: boolean;
  isGroupish: boolean;
  desktopNotifications: 'all' | 'mentions' | 'nothing';
  muteFocusedConversations: boolean;
  taskbarFlash: boolean;
}): { flashTaskbar: boolean; showDesktopNotification: boolean } {
  if (!input.subscribed) {
    return { flashTaskbar: false, showDesktopNotification: false };
  }
  const muted = input.muted && !input.mentioned;
  return {
    // 任务栏是未读注意力信号，不受桌面通知内容偏好控制。
    flashTaskbar: input.taskbarFlash && !muted && !input.focused,
    showDesktopNotification:
      !muted &&
      input.desktopNotifications !== 'nothing' &&
      (input.desktopNotifications !== 'mentions' || !input.isGroupish || input.mentioned) &&
      (!input.focused || !input.muteFocusedConversations),
  };
}

export function conversationHasFocus(
  activeRid: string | null,
  rid: string,
  documentHasFocus: boolean,
): boolean {
  return activeRid === rid && documentHasFocus;
}

function notifyIfNeeded(msg: RcMessage, rid: string, state: ChatState) {
  const auth = loadStoredAuth();
  if (!auth || msg.u._id === auth.userId || msg.t) return;
  const subscription = state.subscriptions[rid];
  if (!subscription) return;
  if (notifiedMids.has(msg._id)) return;
  notifiedMids.add(msg._id);
  if (notifiedMids.size > 800) {
    for (const id of notifiedMids) {
      notifiedMids.delete(id);
      if (notifiedMids.size <= 400) break;
    }
  }

  const currentUser = useAuth.getState().user;
  const me = currentUser?.username;
  const mentioned =
    !!me &&
    new RegExp(`@(${me.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}|all|here)\\b`).test(msg.msg ?? '');

  const prefs = usePrefs.getState().prefs;
  const roomType = subscription.t ?? state.rooms[rid]?.t;
  const dmSize = state.rooms[rid]?.uids?.length ?? state.rooms[rid]?.usersCount;
  const isGroupish = roomType !== 'd' || (dmSize !== undefined && dmSize > 2);
  const focused = conversationHasFocus(state.activeRid, rid, document.hasFocus());
  const policy = notificationAttentionPolicy({
    subscribed: true,
    muted: !!subscription.disableNotifications,
    mentioned,
    focused,
    isGroupish,
    desktopNotifications: prefs.desktopNotifications,
    muteFocusedConversations: prefs.muteFocusedConversations ?? true,
    taskbarFlash: useUiPrefs.getState().taskbarFlash,
  });
  if (policy.flashTaskbar) void flashTaskbar();
  if (!policy.showDesktopNotification) return;

  const title = msg.u.name || msg.u.username;
  const body = msg.msg || (msg.attachments?.length ? '[卡片/文件]' : '');
  const directMention = !!currentUser && !!msg.mentions?.some((mention) =>
    mention._id === currentUser._id || mention.username === currentUser.username,
  );
  const broadcastMention = /@(all|here)\b/i.test(msg.msg ?? '');
  const aggregation = useNotificationAggregation.getState();
  const aggregationState = aggregation.state;
  const candidate: NotificationAggregationInput = {
    id: msg._id,
    roomId: rid,
    roomName: subscription.fname || subscription.name || state.rooms[rid]?.fname || state.rooms[rid]?.name || '会话',
    senderName: title,
    text: body,
    timestamp: tsMs(msg.ts),
    directMessage: !isGroupish,
    directMention,
    broadcastMention,
    priority: /(^|\s|[\[【])P1(?=$|\s|[\]】:：])/i.test(body) ? 1 : undefined,
  };
  const phase = aggregationState?.metrics.activePhase;
  if (phase) aggregation.recordCandidate(phase, candidate.timestamp);
  if (aggregationState && routeNotification(candidate, aggregationState.config).mode === 'aggregate') {
    aggregation.addAggregate(candidate);
    return;
  }
  // 桌面端走系统通知插件、浏览器走 Web Notification（权限判断在 desktopNotify 内部）
  void desktopNotify({
    title,
    body: body.slice(0, 120),
    tag: msg._id,
    rid,
    mid: msg._id,
    onClick: () => {
      window.focus();
      useUI.getState().setModule('messages');
      void useChat.getState().jumpToMessage(msg._id, rid);
    },
  }).then((shown) => {
    if (shown && phase) useNotificationAggregation.getState().recordPopup(phase, Date.now(), 'passthrough');
  }).catch(() => {});
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
  memberErrors: {},
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
  slashCommands: [],
  roomRoles: {},
  userStatus: {},
  selectMode: false,
  selectedMids: new Set(),

  scrollToLatest: () => set({ scrollNonce: get().scrollNonce + 1 }),

  seedUserStatus: (users) => {
    const cur = get().userStatus;
    const next = { ...cur };
    let changed = false;
    for (const u of users) {
      // 只播种、不覆盖已有值：实时流的值比列表快照新
      if (u.username && u.status && !(u.username in cur)) {
        next[u.username] = u.status;
        changed = true;
      }
    }
    if (changed) set({ userStatus: next });
  },

  init: async () => {
    const auth = loadStoredAuth();
    if (!auth) return;
    // 重新登录/切换服务器后不能复用上一个会话尚未完成的成员请求。
    resetMemberRequestState();
    resetRoomRetention();
    // 预热 Site_Url 缓存（引用回复的链接前缀需要）
    void ensureSiteUrl();
    // 已读回执是企业版功能，社区版直接别调，省掉每次刷新那个 400
    void getPublicSetting('Message_Read_Receipt_Enabled').then((v) => {
      if (v === false) receiptsSupported = false;
    });
    // 命令表：拉不到就当没有命令，输入框退回纯文本，不该拖住整个初始化
    void rest
      .listCommands()
      .then((slashCommands) => set({ slashCommands }))
      .catch(() => {});

    let subs: RcSubscription[];
    let rooms: RcRoom[];
    try {
      [subs, rooms] = await Promise.all([rest.getSubscriptions(), rest.getRooms()]);
    } catch (err) {
      // 这里挂掉的话界面会永远停在「加载会话中…」，连个错都看不到。
      // 必须说出来，否则用户只能干瞪眼。
      toast.error(err, '无法加载会话列表');
      console.error('[rcx] 初始化失败', err);
      return;
    }

    const subMap: Record<string, RcSubscription> = {};
    for (const s of subs) subMap[s.rid] = s;
    const roomMap: Record<string, RcRoom> = {};
    for (const r of rooms) roomMap[r._id] = r;
    set({ subscriptions: subMap, rooms: roomMap, ready: true });

    // 防止重复注册（StrictMode 双执行 / 开发时 HMR 重建 store）
    realtime.clearStreamHandlers();
    // 重连成功后补数据：DDP 的 stream 是纯 live 推送、服务端不回放，只重订阅收不到
    // 断线期间产生的消息（P0-2）。这里刷新会话列表/未读，并补拉当前房间的新消息。
    const backfillAfterReconnect = async () => {
      try {
        const [subs2, rooms2] = await Promise.all([rest.getSubscriptions(), rest.getRooms()]);
        const subMap2: Record<string, RcSubscription> = {};
        for (const s of subs2) subMap2[s.rid] = s;
        const roomMap2: Record<string, RcRoom> = {};
        for (const r of rooms2) roomMap2[r._id] = r;
        set({ subscriptions: subMap2, rooms: roomMap2 });

        const rid = get().activeRid;
        if (rid && get().historyLoaded[rid]) {
          const type = get().subscriptions[rid]?.t ?? get().rooms[rid]?.t ?? 'c';
          const latest = await rest.getHistory(rid, type, HISTORY_PAGE);
          let merged = [...(get().messages[rid] ?? [])];
          for (const m of latest) merged = upsertMessage(merged, m);
          merged.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
          set({ messages: { ...get().messages, [rid]: merged } });
        }
      } catch {
        /* 补拉失败：下次重连或用户手动切房间时再补 */
      }
    };

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
      // 从重连态恢复 → 补断线期间漏掉的数据
      if (s === 'connected' && prev === 'reconnecting') {
        void backfillAfterReconnect();
      }
    };
    await realtime.connect();
    await realtime.login(auth.authToken);

    // 事件名可能是房间 id（房间订阅）或 '__my_messages__'（全局订阅），
    // 一律以消息自带的 rid 为准
    realtime.onStream('stream-room-messages', (_eventName, args) => {
      const msg = args[0] as RcMessage | undefined;
      if (!msg?._id || !msg.rid) return;
      const rid = msg.rid;
      const state = get();
      let nextList = upsertMessage(state.messages[rid] ?? [], msg);
      // 还没打开过的会话只留个尾巴当预览：全局流会给所有房间推消息，
      // 不截断的话长时间挂机后台房间会无限积累；打开时反正要拉历史再合并
      if (!state.historyLoaded[rid] && nextList.length > INACTIVE_ROOM_MESSAGE_LIMIT) {
        nextList = nextList.slice(-INACTIVE_ROOM_MESSAGE_LIMIT);
      }
      set({ messages: { ...state.messages, [rid]: nextList } });
      const room = state.rooms[rid];
      if (room && !msg.tmid) {
        set({ rooms: { ...get().rooms, [rid]: { ...room, lastMessage: msg, lm: msg.ts } } });
      }
      // 置顶/取消置顶不推送消息更新，但会产生一条系统消息——以它为信号
      // 同步一次本房间的 pinned 标志（issue #19-5）
      if ((msg.t === 'message_pinned' || msg.t === 'message_unpinned') && state.historyLoaded[rid]) {
        void get().reconcilePinned(rid).catch(() => {});
      }
      notifyIfNeeded(msg, rid, state);
      if (get().activeRid === rid) {
        if (get().subscriptions[rid]) scheduleMarkRead(rid);
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

    // 全局消息流：我加入的所有房间的新消息都推过来。
    // 以前只订阅「本次会话里打开过的房间」（openRoom → subscribeRoomStreams），
    // 没点开过的会话来消息就不会进 notifyIfNeeded —— 这正是「有些人发消息会提示、
    // 有些人不会」的原因（issue #19-7）。房间级订阅保留作为兜底（服务器不支持
    // __my_messages__ 时行为与从前一致），重复送达由 upsert 幂等 + 通知去重兜住。
    realtime.subscribe('stream-room-messages', '__my_messages__');

    // 其他人的在线状态：RC 在有人状态变化时广播 [userId, username, statusNum, statusText]
    // statusNum：0=离线 1=在线 2=离开 3=忙。只推变化，初值由通讯录/成员列表播种。
    // 按 username 存：消息(u.username)、会话列表(avatarUsername)、成员都拿得到用户名，
    // 而 DM 的房间 id 在 RC 8.6.1 是普通房间 id、推不出对端 userId。
    realtime.onStream('stream-notify-logged', (eventName, args) => {
      if (eventName !== 'user-status') return;
      // args 可能是单个元组，也可能是一批元组，统一成数组处理
      const tuples = (Array.isArray(args[0]) ? args : [args]) as unknown[][];
      const cur = get().userStatus;
      const next = { ...cur };
      let changed = false;
      for (const t of tuples) {
        const username = t[1] as string;
        const num = t[2] as number;
        const status = STATUS_BY_NUM[num] ?? 'offline';
        if (username && next[username] !== status) {
          next[username] = status;
          changed = true;
        }
      }
      if (changed) set({ userStatus: next });
    });
    realtime.subscribe('stream-notify-logged', 'user-status');
    // 启动播种全量在线状态：实时流只推「变化」，不播种的话刚打开软件时
    // 会话列表/消息头像一个状态点都没有，要等别人恰好切状态才亮
    void rest
      .getPresences()
      .then((users) => get().seedUserStatus(users))
      .catch(() => {});
  },

  openRoom: async (rid) => {
    const requestGeneration = retainedRoomGeneration;
    const sub = get().subscriptions[rid];
    // 打开有未读的会话时记录「以下为新消息」位置（取上次已读时间）。
    // RC 对频道默认只有 @ 才累计 unread，普通新消息只置 alert，两者都算未读
    const marks = { ...get().unreadMarkTs };
    if (sub && (sub.unread > 0 || sub.alert) && sub.ls) marks[rid] = tsMs(sub.ls);
    else delete marks[rid];
    const retention = retainRecentRooms(retainedRoomOrder, rid, RECENT_INACTIVE_ROOM_LIMIT);
    retainedRoomOrder = retention.order;
    for (const evictedRid of retention.evicted) evictMemberRequestState(evictedRid);
    const compacted = retention.evicted.length
      ? compactEvictedRoomData(get(), retention.evicted)
      : {};
    set({
      ...compacted,
      activeRid: rid,
      rightPanel: null,
      unreadMarkTs: marks,
      pendingFiles: null,
      replyTo: null,
      // 普通打开/重复点击会话应回到最新消息，不能让上一次搜索或通知跳转
      // 遗留的高亮随后 scrollIntoView，把列表从底部再次拉回旧消息。
      highlightMid: null,
      // 切会话退出多选态
      selectMode: false,
      selectedMids: new Set(),
      // 即使重复点击当前会话，也回到最新消息，而不是停留在之前浏览的历史位置。
      scrollNonce: get().scrollNonce + 1,
    });

    const { historyLoaded, subscriptions, rooms } = get();
    subscribeRoomStreams(rid);

    // 顺手播种本房间成员的在线状态，让消息/会话头像的状态点有初值（issue #18.1）。
    // loadMembers 带缓存，重复打开不会多打请求；失败也不影响打开会话。
    void get()
      .loadMembers(rid)
      .then((ms) => get().seedUserStatus(ms))
      .catch(() => {});

    if (!historyLoaded[rid]) {
      const type = subscriptions[rid]?.t ?? rooms[rid]?.t ?? 'c';
      const history = await rest.getHistory(rid, type, HISTORY_PAGE);
      // 用户快速切过很多房间时，旧请求可能在该房间已被淘汰后才返回。
      // 不再保留的房间由下次打开重新加载，避免迟到响应绕过内存上限。
      if (
        !canApplyRetainedRoomResult(
          requestGeneration,
          retainedRoomGeneration,
          retainedRoomOrder,
          rid,
        )
      ) {
        return;
      }
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
    if (get().subscriptions[rid]) scheduleMarkRead(rid);
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
    if (cached && !get().memberErrors[rid]) return cached;
    const type = get().subscriptions[rid]?.t ?? get().rooms[rid]?.t ?? 'c';
    const version = memberVersion(rid);
    try {
      const snapshot = await requestMemberSnapshot(rid, type, version);
      if (memberVersion(rid) !== version) return get().members[rid] ?? snapshot;
      const members = applyPendingMemberChanges(rid, snapshot, true);
      const errs = { ...get().memberErrors };
      delete errs[rid];
      set({ members: { ...get().members, [rid]: members }, memberErrors: errs });
      return members;
    } catch (err) {
      if (memberVersion(rid) !== version) return get().members[rid] ?? [];
      // 保留已有缓存，让其它调用方继续可用；同时记录原因，使成员面板能区分
      // 「拉取失败」和「群里真没人」(P1-11)。
      set({
        memberErrors: { ...get().memberErrors, [rid]: humanError(err, '无法获取成员列表') },
      });
      return get().members[rid] ?? [];
    }
  },

  send: async (text, opts) => {
    const rid = opts?.rid ?? get().activeRid;
    const trimmed = text.trim();
    const me = useAuth.getState().user;
    if (!rid || !trimmed || !me) return;

    // 引用回复：文本前缀消息链接，服务端展开为引用附件。
    // 必须 await 到服务端真正的 Site_Url——缓存没热时 siteUrlSync 会回退到
    // getServerBase()，与服务端 Site_Url 不一致就不展开（issue #9）。
    const fullText = opts?.quote
      ? quoteLinkPrefix(opts.quote, get().subscriptions, await ensureSiteUrl()) + trimmed
      : trimmed;

    // 乐观上屏：秒回显，pending 状态等服务器确认。
    // _id 由客户端生成并随请求提交 —— WS 回声先到时同 id 被 upsert 合并，
    // 不会「同一条显示两遍」；504 但服务端已落库时重试同 id 也不会发出第二条。
    const clientId = randomMessageId();
    const temp: RcMessage = {
      _id: clientId,
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
        _id: clientId,
        rid,
        msg: fullText,
        ...(opts?.tmid ? { tmid: opts.tmid } : {}),
      });
      set({ messages: { ...get().messages, [rid]: upsertMessage(get().messages[rid] ?? [], msg) } });
      useOnboarding.getState().markChecklist('sentMessage');
      scheduleReceiptRefresh(rid);
    } catch (err) {
      // 只对**仍是 pending** 的那条标失败：WS 回声可能已抢先把 temp 替换成真实消息
      //（同 _id、无 pending 字段），此时其实发送成功了，不能给它扣一顶失败的帽子。
      const cur = get().messages[rid] ?? [];
      const stillPending = cur.some((m) => m._id === clientId && m.pending);
      if (!stillPending) {
        useOnboarding.getState().markChecklist('sentMessage');
        return;
      }
      set({
        messages: {
          ...get().messages,
          [rid]: cur.map((m) =>
            m._id === clientId && m.pending ? { ...m, pending: false, failed: true } : m,
          ),
        },
      });
      toast.show({
        kind: 'error',
        message: humanError(err, '消息发送失败'),
        action: { label: '重试', onClick: () => void get().resendMessage(clientId) },
      });
    }
  },

  runSlash: async (command, params, tmid) => {
    const rid = get().activeRid;
    if (!rid) return;
    const local = kernelRegistry
      .get('composer.command')
      .find((candidate) => candidate.name.toLowerCase() === command.toLowerCase());
    if (local) {
      try {
        await local.run({ rid, params, ...(tmid ? { tmid } : {}) });
      } catch (err) {
        toast.error(err, `/${command} 执行失败`);
      }
      return;
    }
    // 认不出来的命令**不发**。以前会把 `/kick @张三` 原样广播给全群——
    // 打错一个字母就变成公开处刑，宁可让用户看见「没有这个命令」。
    if (!findCommand(get().slashCommands, command)) {
      toast.show({ kind: 'error', message: `没有 /${command} 这个命令` });
      return;
    }
    try {
      await rest.runCommand(command, rid, params, tmid);
      // 命令的结果由服务端产生（发消息 / 改房间 / 踢人），走实时流回来，这里不用管
    } catch (err) {
      toast.error(err, `/${command} 执行失败`);
    }
  },

  resendMessage: async (tempId) => {
    // 用消息自身的 rid：用户可能已切换到别的会话
    const rid = Object.keys(get().messages).find((r) =>
      (get().messages[r] ?? []).some((m) => m._id === tempId),
    );
    if (!rid) return;
    const failed = (get().messages[rid] ?? []).find((m) => m._id === tempId);
    // 只重发仍是失败态的：WS 回声若已把它替换成真实消息，说明其实发出去了
    if (!failed || !failed.failed) return;
    set({
      messages: {
        ...get().messages,
        [rid]: (get().messages[rid] ?? []).map((m) =>
          m._id === tempId ? { ...m, pending: true, failed: false } : m,
        ),
      },
    });
    try {
      // 附件是本地展示用的，不随重发提交（引用信息已在消息文本前缀里）。
      // 沿用同一个 _id：上次其实已落库时（504 但服务端收到了），同 id 不会发出第二条。
      const msg = await rest.sendMessageRaw({
        _id: tempId,
        rid,
        msg: failed.msg,
        ...(failed.tmid ? { tmid: failed.tmid } : {}),
      });
      set({ messages: { ...get().messages, [rid]: upsertMessage(get().messages[rid] ?? [], msg) } });
    } catch {
      // 同 send()：回声已替换成真实消息（无 pending 字段）就不再标失败
      const cur = get().messages[rid] ?? [];
      if (!cur.some((m) => m._id === tempId && m.pending)) return;
      set({
        messages: {
          ...get().messages,
          [rid]: cur.map((m) =>
            m._id === tempId && m.pending ? { ...m, pending: false, failed: true } : m,
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
    const requestGeneration = retainedRoomGeneration;
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
      if (
        !canApplyRetainedRoomResult(
          requestGeneration,
          retainedRoomGeneration,
          retainedRoomOrder,
          rid,
        )
      ) {
        return;
      }
      set({ readReceipts: { ...get().readReceipts, [rid]: { mid: lastOwn._id, users } } });
    } catch (err) {
      // 社区版 / 未开启回执：停止后续请求，功能静默降级
      const raw = err instanceof Error ? err.message : '';
      if (/enterprise|not-allowed|not allowed|disabled/i.test(raw)) receiptsSupported = false;
    }
  },

  inviteMembers: async (rid, users) => {
    const type = get().subscriptions[rid]?.t ?? get().rooms[rid]?.t ?? 'c';

    /**
     * 直聊没法「加人」—— Rocket.Chat 根本没有这个 API
     * （channels.invite / groups.invite / im.invite 对 DM 房间全部报错）。
     * 官方客户端和 Slack 的多人私聊一样：拉新人 = 新建一个包含所有人的会话。
     * 原会话保留，历史消息留在那边。
     */
    if (type === 'd') {
      const existing = await get().loadMembers(rid);
      const me = useAuth.getState().user?.username;
      const usernames = [
        ...new Set([...existing.map((u) => u.username), ...users.map((u) => u.username)]),
      ].filter((u) => u && u !== me);
      await get().startDM(usernames);
      toast.info('多人聊天不支持直接加人（Rocket.Chat 的限制），已新建一个包含所有人的会话');
      return;
    }

    for (const u of users) {
      await rest.inviteToRoom(rid, type, u._id);
    }
    // 邀请接口成功即代表这些用户已经是成员。服务端成员列表在高并发时可能短暂滞后，
    // 直接清缓存并立刻重拉会偶发把刚邀请的人漏掉（issue #23）。刷新成功时以
    // 服务器结果为准并补上本次邀请；只有刷新失败才退回旧缓存。这样既能立即显示
    // 新人，也不会把其他管理员刚移除的旧成员重新塞回来。
    stageMemberAdds(rid, users);
    const version = invalidateMemberRequests(rid);
    const optimistic = applyPendingMemberChanges(rid, get().members[rid] ?? []);
    set({ members: { ...get().members, [rid]: optimistic } });

    let refreshed: RcUser[] | null = null;
    let refreshError: string | null = null;
    try {
      refreshed = await requestMemberSnapshot(rid, type, version);
    } catch (err) {
      // 邀请本身已经成功；刷新失败时保留旧缓存并乐观加入新人。
      refreshError = humanError(err, '成员列表刷新失败');
    }
    if (memberVersion(rid) !== version) return;
    const nextMembers = applyPendingMemberChanges(
      rid,
      refreshed ?? get().members[rid] ?? [],
      refreshed !== null,
    );
    const memberErrors = { ...get().memberErrors };
    if (refreshError) memberErrors[rid] = refreshError;
    else delete memberErrors[rid];
    const room = get().rooms[rid];
    set({
      members: { ...get().members, [rid]: nextMembers },
      memberErrors,
      ...(room
        ? {
            rooms: {
              ...get().rooms,
              [rid]: {
                ...room,
                usersCount:
                  refreshed === null
                    ? Math.max(room.usersCount ?? 0, nextMembers.length)
                    : nextMembers.length,
              },
            },
          }
        : {}),
    });
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
      const list = get().messages[rid] ?? [];
      await rest.deleteMessage(rid, msgId);
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

  reconcilePinned: async (rid) => {
    const pinned = await rest.getPinnedMessages(rid, 100);
    const ids = new Set(pinned.map((m) => m._id));
    const list = get().messages[rid];
    if (list) {
      let changed = false;
      const next = list.map((m) => {
        const value = ids.has(m._id);
        if (!!m.pinned === value) return m;
        changed = true;
        return { ...m, pinned: value };
      });
      if (changed) set({ messages: { ...get().messages, [rid]: next } });
    }
    return pinned;
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

  restoreConv: async (conv) => {
    try {
      await rest.openRoom(conv.rid, conv.type);
      const sub = get().subscriptions[conv.rid];
      if (sub) {
        set({
          subscriptions: { ...get().subscriptions, [conv.rid]: { ...sub, open: true } },
        });
      }
      toast.success(`已恢复「${conv.name}」`);
    } catch (err) {
      toast.error(err, '恢复会话失败');
      throw err;
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

  // ---- 群管理 ----

  refreshRoomInfo: async (rid) => {
    try {
      const info = await rest.getRoomInfo(rid);
      const prev = get().rooms[rid];
      // 合并而不是替换：rooms.get 带的 lastMessage / lm 在 rooms.info 里没有，
      // 直接盖掉会把会话列表的「最后一条消息」抹空
      set({ rooms: { ...get().rooms, [rid]: { ...prev, ...info } } });
      return info;
    } catch {
      return get().rooms[rid] ?? null;
    }
  },

  openDiscussion: async (drid) => {
    const previousRid = get().activeRid;
    // 本地快照可能落后于服务端：先尽力刷新，避免把已加入的讨论误判成未订阅。
    if (!get().subscriptions[drid]) {
      try {
        await refreshSubsAndRooms(set);
      } catch {
        // 刷新失败不阻塞打开；后续仍可按未订阅讨论读取历史。
      }
    }
    // 讨论在未订阅时仍允许父房间成员读历史、发消息；先补齐类型，再统一走 openRoom，
    // 这样历史加载和实时订阅不会被旁路。
    if (!get().subscriptions[drid] && !get().rooms[drid]) {
      const info = await get().refreshRoomInfo(drid);
      if (!info) {
        toast.show({ kind: 'error', message: '打不开这个讨论，可能你不在讨论成员里' });
        return;
      }
    }
    try {
      await get().openRoom(drid);
    } catch (err) {
      // 只回滚这次打开留下的状态，不能覆盖用户随后发起的其他导航。
      if (get().activeRid === drid) set({ activeRid: previousRid });
      toast.error(err, '打不开这个讨论，可能你不在讨论成员里');
    }
  },

  joinRoom: async (rid) => {
    try {
      try {
        await rest.joinRoom(rid);
      } catch (err) {
        // Rocket.Chat 旧版本没有 rooms.join；讨论加入由 DDP joinRoom 提供兼容路径。
        if (!(err instanceof RcApiError) || err.status !== 404) throw err;
        await realtime.call('joinRoom', rid);
      }
      // 加入不一定推订阅变更，主动刷新并重新打开讨论。
      await refreshSubsAndRooms(set);
      await get().openRoom(rid);
      toast.success('已加入');
    } catch (err) {
      toast.error(err, '加入失败，该讨论可能是私有的，需要成员邀请你');
    }
  },

  loadRoomRoles: async (rid) => {
    const requestGeneration = retainedRoomGeneration;
    const type = roomTypeOf(get(), rid);
    // 单聊和多人聊天（都是 t='d'）没有角色一说，groups.roles 对它们直接 400
    if (type === 'd') return [];
    // 同一房间的并发请求合流：群信息面板和成员面板都会调，成员列表一变（比如踢完人）
    // effect 还会再跑一次 —— 不去重的话一次「群信息 → 群成员」要打三次 channels.roles
    const pending = rolesInflight.get(rid);
    if (pending) return pending;

    const p = (async () => {
      try {
        const roles = await rest.getRoomRoles(rid, type);
        if (
          canApplyRetainedRoomResult(
            requestGeneration,
            retainedRoomGeneration,
            retainedRoomOrder,
            rid,
          )
        ) {
          set({ roomRoles: { ...get().roomRoles, [rid]: roles } });
        }
        return roles;
      } catch {
        // 拿不到角色就当自己没权限，界面退回只读——不该因此报错打断用户
        return [];
      } finally {
        rolesInflight.delete(rid);
      }
    })();
    rolesInflight.set(rid, p);
    return p;
  },

  kickMember: async (rid, user) => {
    const type = roomTypeOf(get(), rid);
    try {
      await rest.kickFromRoom(rid, type, user._id);
      stageMemberRemoval(rid, user._id);
      invalidateMemberRequests(rid);
      set({
        members: {
          ...get().members,
          [rid]: applyPendingMemberChanges(rid, get().members[rid] ?? []),
        },
      });
      toast.success(`已把 ${user.name || user.username} 移出群聊`);
    } catch (err) {
      toast.error(err, '移出失败，可能是你没有该群的管理权限');
    }
  },

  setMemberRole: async (rid, user, role, grant) => {
    const type = roomTypeOf(get(), rid);
    const label = role === 'owner' ? '群主' : role === 'moderator' ? '管理员' : '负责人';
    try {
      await rest.setRoomRole(rid, type, user._id, role, grant);
      await get().loadRoomRoles(rid);
      toast.success(`${grant ? '已设为' : '已取消'}${label}：${user.name || user.username}`);
    } catch (err) {
      toast.error(err, `${grant ? '设置' : '取消'}${label}失败`);
    }
  },

  toggleMemberMute: async (rid, user) => {
    // 禁言名单只在 rooms.info 里，rooms.get 不一定带。拿不到就先补一次 ——
    // 否则 muted 恒为空，willMute 永远是 true，「解除禁言」点了还是禁言。
    let room = get().rooms[rid];
    if (!room?.muted) room = (await get().refreshRoomInfo(rid)) ?? room;

    const muted = room?.muted ?? [];
    const willMute = !muted.includes(user.username);
    try {
      await rest.muteUser(rid, user.username, willMute);
      // 禁言走的是斜杠命令，服务端不会推房间更新，本地自己维护 muted 列表
      const cur = get().rooms[rid];
      if (cur) {
        set({
          rooms: {
            ...get().rooms,
            [rid]: {
              ...cur,
              muted: willMute
                ? [...muted, user.username]
                : muted.filter((u) => u !== user.username),
            },
          },
        });
      }
      toast.success(`${willMute ? '已禁言' : '已解除禁言'}：${user.name || user.username}`);
    } catch (err) {
      toast.error(err, `${willMute ? '禁言' : '解除禁言'}失败`);
    }
  },

  setRoomReadOnly: async (rid, readOnly) => {
    const type = roomTypeOf(get(), rid);
    const room = get().rooms[rid];
    try {
      await rest.setReadOnly(rid, type, readOnly);
      if (room) set({ rooms: { ...get().rooms, [rid]: { ...room, ro: readOnly } } });
      toast.success(readOnly ? '已设为只读，只有群主和管理员能发言' : '已取消只读');
    } catch (err) {
      toast.error(err, '设置失败，可能是你没有该群的管理权限');
    }
  },

  archiveConv: async (rid, archive) => {
    const type = roomTypeOf(get(), rid);
    const room = get().rooms[rid];
    try {
      await rest.archiveRoom(rid, type, archive);
      if (room) set({ rooms: { ...get().rooms, [rid]: { ...room, archived: archive } } });
      toast.success(archive ? '已归档，该群不再接收新消息' : '已取消归档');
    } catch (err) {
      toast.error(err, `${archive ? '归档' : '取消归档'}失败`);
    }
  },

  deleteConv: async (rid) => {
    const type = roomTypeOf(get(), rid);
    const name = get().subscriptions[rid]?.fname ?? get().subscriptions[rid]?.name ?? '该群';
    try {
      await rest.deleteRoom(rid, type);
      // 服务端会推 subscriptions-changed，但先本地摘掉，别让用户盯着一个已经没了的群
      const subs = { ...get().subscriptions };
      const rooms = { ...get().rooms };
      delete subs[rid];
      delete rooms[rid];
      set({
        subscriptions: subs,
        rooms,
        ...(get().activeRid === rid ? { activeRid: null, rightPanel: null } : {}),
      });
      toast.success(`已解散并删除「${name}」`);
    } catch (err) {
      toast.error(err, '删除失败，只有群主或系统管理员能解散群');
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
        attachments: forwardableAttachments(msg.attachments, rid === msg.rid),
      });
    }
    toast.success(
      rids.length === 1 ? `已转发到「${names[0]}」` : `已转发到 ${rids.length} 个会话`,
    );
  },

  forwardMessages: async (msgs, rids, merge) => {
    // 按时间正序转发，保证目标会话里顺序和原会话一致
    const ordered = [...msgs].sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
    const names = rids.map(
      (rid) => get().subscriptions[rid]?.fname || get().subscriptions[rid]?.name || '会话',
    );
    for (const rid of rids) {
      if (merge) {
        // 合并成一条「聊天记录」卡片：每条消息一个 attachment，AttachmentCard 的
        // 富文本分支会把 author_name + text 堆叠渲染成一块转发记录（无需服务端支持）
        await rest.sendMessageRaw({
          _id: randomMessageId(),
          rid,
          msg: `[聊天记录] 共 ${ordered.length} 条`,
          attachments: mergedForwardAttachments(
            ordered.map((m) => ({
              text: stripQuotePrefix(m.msg || ''),
              ts: m.ts,
              attachments: m.attachments,
            })),
            ordered.every((message) => message.rid === rid),
          ),
        });
      } else {
        for (const m of ordered) {
          await rest.sendMessageRaw({
            _id: randomMessageId(),
            rid,
            msg: stripQuotePrefix(m.msg || '') || undefined,
            attachments: forwardableAttachments(m.attachments, rid === m.rid),
          });
        }
      }
    }
    toast.success(
      rids.length === 1
        ? `已转发 ${ordered.length} 条到「${names[0]}」`
        : `已转发 ${ordered.length} 条到 ${rids.length} 个会话`,
    );
  },

  enterSelectMode: (mid) => set({ selectMode: true, selectedMids: new Set([mid]) }),
  toggleSelectMid: (mid) => {
    const next = new Set(get().selectedMids);
    if (next.has(mid)) next.delete(mid);
    else next.add(mid);
    set({ selectedMids: next });
  },
  exitSelectMode: () => set({ selectMode: false, selectedMids: new Set() }),

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

  startDM: async (usernames) => {
    const room = await rest.createDirectMessage(usernames);
    // 新建的直聊订阅可能是关闭状态，不显式 open 就不会出现在会话列表里
    await rest.openDirectMessage(room._id).catch(() => {});
    await refreshSubsAndRooms(set);
    await get().openRoom(room._id);
    useOnboarding.getState().markChecklist('startedConversation');
    return room._id;
  },

  createGroup: async (name, members, priv) => {
    const room = await rest.createGroup(name, members, priv);
    await refreshSubsAndRooms(set);
    await get().openRoom(room._id);
    useOnboarding.getState().markChecklist('startedConversation');
    toast.success(`已创建群组「${name}」`);
    return room._id;
  },

  createTeam: async (name, members, priv) => {
    const team = await rest.createTeam(name, members, priv);
    await refreshSubsAndRooms(set);
    await get().openRoom(team.roomId);
    useOnboarding.getState().markChecklist('startedConversation');
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
  includeHidden = false,
): Conversation[] {
  const items: Conversation[] = [];
  for (const sub of Object.values(subscriptions)) {
    const hidden = sub.open === false;
    if (hidden && !includeHidden) continue;
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
      hidden,
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
  // 多人聊天独立成区：它没有名字、没有主题，和「general-test」这种有名有姓的
  // 频道是两码事，混在一起用户根本分不清哪个是哪个
  if (conv.isMultiDM) return 'multi';
  if (conv.type === 'd') return 'direct';
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

  const order: SectionKey[] = [
    'favorites',
    'teams',
    'discussions',
    'channels',
    'multi',
    'direct',
  ];
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
