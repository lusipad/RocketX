import { create } from 'zustand';
import {
  RcApiError,
  tsMs,
  type RcMessage,
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
import {
  normalizeMessageMaxAllowedSize,
  toSendableMessageChunks,
} from '../lib/messageChunks';
import { findCommand } from '../lib/slash';
import { formatMixedLanguageText } from '../lib/mixedLanguageFormat';
import { kernelRegistry } from '../kernel/registry';
import { desktopNotify } from '../lib/notify';
import { playNotificationSound } from '../lib/notificationSound';
import { flashTaskbar } from '../lib/taskbar';
import {
  forwardFileName,
  forwardableAttachments,
  mergedForwardAttachments,
  protectedFilePath,
} from '../lib/forward';
import { quoteMessagePrefix, stripQuotePrefix } from '../lib/messageText';
import {
  canApplyRetainedRoomResult,
  omitRoomEntries,
  retainRecentRooms,
  trimRoomMessages,
} from '../lib/chatMemory';
import { useUiPrefs } from './uiPrefs';
import { createActiveRoomStreams } from '../lib/roomStreams';
import {
  messageScrollTransactionMatches,
  nextMessageScrollTransaction,
  type MessageScrollEntry,
  type MessageScrollTransaction,
} from '../lib/messageScrollTransaction';
import { recordMessageScrollDiagnostic } from '../lib/messageScrollDiagnostics';
import { useAuth } from './auth';
import { usePrefs } from './prefs';
import { useOnboarding } from './onboarding';
import { humanError, toast } from './toast';
import { useUI } from './ui';
import { useFocus } from './focus';
import { useNotificationAggregation } from './notificationAggregation';
import { isLanControlMessage } from '../lan/protocol';
import {
  sendLanFile,
  probeLanPeer,
  startLanRuntime,
  type LanFileEvent,
} from '../lan/runtime';
import { stripAgentSessionMarker } from '../agent/card';
import { agentReplyNotificationTracker } from '../agent/replyNotification';
import {
  enqueueAttachmentArchives,
  scheduleAttachmentArchiveCleanup,
} from '../lib/attachmentArchiveRuntime';
import {
  localQuoteAttachment,
  messageTime,
  upsertMessage,
} from '../chat/messageProjection';
import {
  type Conversation,
} from '../chat/roomDirectory';
import { notifyChatMessage, rememberLocalMessage } from '../chat/notificationCoordinator';
import {
  conversationIsActivelyViewed,
} from '../chat/notificationPolicy';
import { statDesktopFile, uploadDesktopBlob, uploadDesktopFile } from '../platform/desktopFs';
import { isTauri } from '../lib/http';
import { shouldSpoolUpload } from '../lib/uploadRouting';
import { useUiKit } from '../lib/uikit';

/** 右侧面板：话题 / Pin / 标记 / 成员 / 搜索 / 群信息 / 文件 / 提及我的，同一时刻只开一个 */
export type RightPanel =
  | { kind: 'thread'; mid: string }
  | { kind: 'pins' }
  | { kind: 'starred' }
  | { kind: 'members'; highlightName?: string }
  | { kind: 'search' }
  | { kind: 'info' }
  | { kind: 'files'; fileId?: string }
  | { kind: 'mentions' }
  | { kind: 'ai' }
  | { kind: 'butler'; tmid?: string }
  | { kind: 'agent'; tmid: string }
  | { kind: `app:${string}`; props?: unknown }
  | null;

const HISTORY_PAGE = 50;
const INACTIVE_ROOM_MESSAGE_LIMIT = 60;
const RECENT_INACTIVE_ROOM_LIMIT = 8;
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
  /** 成员拉取失败的原因:rid -> 错误文案。用来把「拉取失败」和「群里真没人」区分开 */
  memberErrors: Record<string, string>;
  activeRid: string | null;
  rightPanel: RightPanel;
  /** 自己发送消息后递增，MessageList 据此强制滚到底部 */
  scrollNonce: number;
  /** 每次普通打开或消息定位都会生成新的滚动事务，同一房间也不复用。 */
  messageScrollGeneration: number;
  messageScrollTransaction: MessageScrollTransaction | null;
  uploading: number;
  /** 每个会话的输入草稿（持久化） */
  drafts: Record<string, string>;
  /** 「以下为新消息」分割线时间戳（打开有未读的会话时记录） */
  unreadMarkTs: Record<string, number>;
  /** 待确认发送的文件（粘贴/拖拽后进入预览确认） */
  pendingFiles: File[] | null;
  /** 选择文件时输入框里的文字，确认后随第一个文件发送 */
  pendingUploadMessage: string | null;
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
  openRoom: (
    rid: string,
    options?: { entry?: MessageScrollEntry; messageId?: string },
  ) => Promise<void>;
  openThread: (mid: string) => Promise<void>;
  toggleThreadFollow: (mid: string, follow: boolean) => Promise<boolean>;
  setPanel: (panel: RightPanel) => void;
  loadOlder: () => Promise<number>;
  loadMembers: (rid: string, options?: { force?: boolean }) => Promise<RcUser[]>;
  /** 绕过缓存重新拉成员（别人在其它端拉了人，本地缓存不会自己失效） */
  refreshMembers: (rid: string) => Promise<RcUser[]>;
  send: (
    text: string,
    opts?: { rid?: string; tmid?: string; quote?: RcMessage; clientId?: string; preserveWhitespace?: boolean },
  ) => Promise<ChatSendResult | undefined>;
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
  deleteMessage: (message: Pick<RcMessage, '_id' | 'rid'>) => Promise<void>;
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
  createDiscussionFrom: (msg: RcMessage, name?: string) => Promise<void>;
  requestUpload: (files: File[], message?: string) => void;
  confirmUpload: (message?: string) => Promise<boolean>;
  cancelUpload: () => void;
  uploadFiles: (files: File[], tmid?: string, message?: string) => Promise<boolean>;
  uploadNativeFiles: (paths: string[], tmid?: string, message?: string) => Promise<boolean>;
  sendP2pFiles: (paths: string[]) => Promise<boolean>;
  prepareP2p: () => Promise<boolean>;
}

export interface ChatSendResult {
  id: string;
  delivery: 'server' | 'lan' | 'unknown' | 'failed';
  reason?: string;
}

async function lanRecipientIds(rid: string): Promise<string[]> {
  const state = useChat.getState();
  const me = useAuth.getState().user?._id;
  if (!me) return [];
  const roomIds = state.rooms[rid]?.uids?.filter((id) => id !== me) ?? [];
  if (roomIds.length > 0) return [...new Set(roomIds)];
  const members = await state.loadMembers(rid);
  return [...new Set(members.map((member) => member._id).filter((id) => id !== me))];
}

function localLanFileMessage(
  event: Pick<
    LanFileEvent,
    | 'messageId'
    | 'roomId'
    | 'originalTs'
    | 'fileName'
    | 'size'
    | 'blake3'
    | 'localPath'
  >,
  author: Pick<RcUser, '_id' | 'username' | 'name'>,
  bytesPerSecond?: number,
): RcMessage {
  return {
    _id: event.messageId,
    rid: event.roomId,
    msg: '',
    ts: new Date(event.originalTs).toISOString(),
    u: author,
    file: {
      _id: `lan-${event.blake3.slice(0, 24)}`,
      name: event.fileName,
      type: 'application/octet-stream',
      size: event.size,
    },
    attachments: [
      {
        title: event.fileName,
        title_link: 'rocketx-local://file',
        title_link_download: true,
      },
    ],
    rocketxOriginalTs: event.originalTs,
    rocketxOffline: true,
    rocketxLocalPath: event.localPath,
    rocketxLanHash: event.blake3,
    rocketxLanBytesPerSecond: bytesPerSecond,
  };
}

function insertLanFileMessage(message: RcMessage): void {
  const current = useChat.getState();
  const next = upsertMessage(current.messages[message.rid] ?? [], message).sort(
    (left, right) => messageTime(left) - messageTime(right),
  );
  const room = current.rooms[message.rid];
  useChat.setState({
    messages: { ...current.messages, [message.rid]: next },
    ...(room
      ? {
          rooms: {
            ...current.rooms,
            [message.rid]: { ...room, lastMessage: message, lm: message.ts },
          },
        }
      : {}),
  });
}

async function acceptLanFile(event: LanFileEvent): Promise<void> {
  const state = useChat.getState();
  if (!state.subscriptions[event.roomId]) return;
  const members = await state.loadMembers(event.roomId);
  const author = members.find((member) => member._id === event.fromUserId);
  if (!author) return;
  const message = localLanFileMessage(event, author);
  insertLanFileMessage(message);
  void notifyIfNeeded(message, event.roomId, state);
}

/**
 * 内存里的文件走哪条上传通道：桌面端的大文件必须先落盘再由 Rust 流式提交，
 * 否则请求体会在 WebView 里物化成按字节展开的数组，直接抛
 * `RangeError: Invalid array length`（issue #377）。
 */
async function uploadBlobToRoom(
  rid: string,
  blob: Blob,
  options: { msg?: string; tmid?: string; fileName?: string } = {},
): Promise<void> {
  const fileName =
    options.fileName ?? (typeof File !== 'undefined' && blob instanceof File ? blob.name : undefined);
  if (shouldSpoolUpload(blob.size, isTauri)) {
    await uploadDesktopBlob(blob, rid, {
      msg: options.msg,
      tmid: options.tmid,
      fileName: fileName ?? 'file',
    });
    return;
  }
  await rest.uploadMedia(rid, blob, options);
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
/**
 * 按房间各记各的。共用一个 timer 的话，600ms 内切走就会把上一个房间的
 * 已读请求连根取消，而且永不补发——服务端那边的未读标记就再也下不去了。
 * 群里有讨论组时最容易撞上：点开群、随手点进讨论，正好在这 600ms 内。
 */
const markReadTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  const pending = markReadTimers.get(rid);
  if (pending) clearTimeout(pending);
  markReadTimers.set(
    rid,
    setTimeout(() => {
      markReadTimers.delete(rid);
      rest.markRead(rid).catch(() => {});
    }, 600),
  );
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
const MESSAGE_ID_RE = /^[23456789ABCDEFGHJKLMNPQRSTWXYZabcdefghijkmnopqrstuvwxyz]{17}$/;
function randomMessageId(): string {
  let s = '';
  for (let i = 0; i < 17; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

function safeMessageId(value: string | undefined): string | undefined {
  return value && MESSAGE_ID_RE.test(value) ? value : undefined;
}

function isUncertainSendError(error: unknown): boolean {
  return !(error instanceof RcApiError) || error.status >= 500;
}

// Message_MaxAllowedSize 是公开设置且不常变，拉一次缓存起来，避免每次发送都多一次请求。
let chatMessageSizeProvider: () => Promise<unknown> = () => getPublicSetting('Message_MaxAllowedSize');
let messageMaxAllowedSizeCache: number | undefined;

async function messageMaxAllowedSize(): Promise<number> {
  if (messageMaxAllowedSizeCache !== undefined) return messageMaxAllowedSizeCache;
  const value = await chatMessageSizeProvider().catch(() => undefined);
  const size = normalizeMessageMaxAllowedSize(value);
  messageMaxAllowedSizeCache = size;
  return size;
}

/** 测试用：替换长度上限来源并清掉缓存，返回还原函数 */
export function setChatMessageSizeProviderForTests(
  provider: () => Promise<unknown>,
): () => void {
  const previous = chatMessageSizeProvider;
  chatMessageSizeProvider = provider;
  messageMaxAllowedSizeCache = undefined;
  return () => {
    chatMessageSizeProvider = previous;
    messageMaxAllowedSizeCache = undefined;
  };
}

function findMessageById(
  messages: Record<string, RcMessage[]>,
  messageId: string,
): RcMessage | undefined {
  for (const list of Object.values(messages)) {
    const found = list.find((message) => message._id === messageId);
    if (found) return found;
  }
  return undefined;
}

/**
 * 逐条转发一条消息到目标会话（issue #69）。
 *
 * 受保护文件跨房间引用会 403，此前只能留提示「请在原会话查看」。现在把文件
 * 下载后重传到目标会话：原消息只有一个文件时文字作为它的说明，转发结果仍是
 * 一条消息；多附件时先发文字和可复用附件，再逐个重传。单个文件下载或重传
 * 失败时退回原来的元数据 + 提示，转发不整体失败。
 */
async function forwardSingleMessage(msg: RcMessage, rid: string): Promise<void> {
  const attachments = msg.attachments ?? [];
  const reupload = rid === msg.rid ? [] : attachments.filter((a) => protectedFilePath(a));
  const text = stripQuotePrefix(msg.msg || '') || undefined;
  if (reupload.length === 0) {
    await rest.sendMessageRaw({
      _id: randomMessageId(),
      rid,
      msg: text,
      attachments: forwardableAttachments(attachments, rid === msg.rid),
    });
    return;
  }

  const others = forwardableAttachments(attachments.filter((a) => !reupload.includes(a)));
  const singleFileOnly = reupload.length === 1 && others.length === 0;
  if (!singleFileOnly && (text || others.length > 0)) {
    await rest.sendMessageRaw({ _id: randomMessageId(), rid, msg: text, attachments: others });
  }

  for (const attachment of reupload) {
    try {
      const blob = await rest.fetchFile(protectedFilePath(attachment)!);
      await uploadBlobToRoom(rid, blob, {
        fileName: forwardFileName(attachment),
        msg: singleFileOnly ? (text ?? '') : '',
      });
    } catch {
      await rest.sendMessageRaw({
        _id: randomMessageId(),
        rid,
        msg: singleFileOnly ? text : undefined,
        attachments: forwardableAttachments([attachment]),
      });
    }
  }
}

/** RC 用户状态的数字编码 → 语义字符串 */
const STATUS_BY_NUM: Record<number, string> = {
  0: 'offline',
  1: 'online',
  2: 'away',
  3: 'busy',
};

/**
 * 订阅里没有就退到 rooms —— 同 roomTypeOf 的理由：未订阅的频道/讨论只有 rooms[rid]
 * 有值，少了这层兜底 'c'/'p' 会被当成 DM 拼成 `/direct/<rid>`，链接打不开。
 * 类型是 c/p 却拿不到 name 时返回空，调用方据此放弃给链接（好过给死链）。
 */
function roomPath(rid: string, subs: Record<string, RcSubscription>): string {
  const sub = subs[rid];
  const room = useChat.getState().rooms[rid];
  const type = sub?.t ?? room?.t;
  const name = sub?.name ?? room?.name;
  if (type === 'c' || type === 'p') return name ? `${type === 'c' ? 'channel' : 'group'}/${name}` : '';
  return `direct/${rid}`;
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
  return quoteMessagePrefix(`${site}/${roomPath(quoted.rid, subs)}?msg=${quoted._id}`);
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
  const path = roomPath(rid, useChat.getState().subscriptions);
  return path ? `${siteUrlSync()}/${path}?msg=${mid}` : '';
}

/** 本地乐观展示用的引用附件（服务器确认后会被展开后的正式附件替换） */
/** 消息文本开头的引用链接（渲染与预览时隐藏） */
export { QUOTE_LINK_RE, stripQuotePrefix } from '../lib/messageText';

export {
  localQuoteAttachment,
  mergeMessageUpdate,
  messagePreview,
  messageTime,
  shouldUseLanFallback,
  upsertMessage,
} from '../chat/messageProjection';
export {
  conversationIsActivelyViewed,
  messageIsFromCurrentUser,
  messageIsNotificationCandidate,
  notificationAttentionPolicy,
  threadReplyShouldNotify,
} from '../chat/notificationPolicy';
export { buildConversations, buildSections, roomMembershipPolicy, SECTION_LABELS, sectionOf } from '../chat/roomDirectory';
export type { Conversation, SectionKey } from '../chat/roomDirectory';

// 开发调试：控制台可通过 window.__chat 检查 store 状态
declare global {
  interface Window {
    __chat?: typeof useChat;
  }
}

async function notifyIfNeeded(msg: RcMessage, rid: string, state: ChatState) {
  await notifyChatMessage(msg, rid, state, {
    loadAuth: loadStoredAuth,
    currentUser: () => useAuth.getState().user,
    consumeExpectedAgentReply: (roomId, text) => agentReplyNotificationTracker.consume(roomId, text),
    getPrefs: () => usePrefs.getState().prefs,
    taskbarFlash: () => useUiPrefs.getState().taskbarFlash,
    focus: () => useFocus.getState(),
    aggregation: () => useNotificationAggregation.getState(),
    fetchMessage: (messageId) => rest.getMessage(messageId),
    flashTaskbar,
    showDesktopNotification: (options) => desktopNotify({
      ...options,
      onClick: () => {
        window.focus();
        useUI.getState().setModule('messages');
        options.onClick();
      },
    }),
    playNotificationSound,
    navigateToMessage: (mid, roomId) => void useChat.getState().jumpToMessage(mid, roomId),
    documentHasFocus: () => document.hasFocus(),
  });
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
  messageScrollGeneration: 0,
  messageScrollTransaction: null,
  uploading: 0,
  drafts: loadDrafts(),
  unreadMarkTs: {},
  pendingFiles: null,
  pendingUploadMessage: null,
  replyTo: null,
  highlightMid: null,
  typing: {},
  readReceipts: {},
  slashCommands: [],
  roomRoles: {},
  userStatus: {},
  selectMode: false,
  selectedMids: new Set(),

  scrollToLatest: () => {
    const rid = get().activeRid;
    if (!rid) return;
    const transaction = nextMessageScrollTransaction(
      get().messageScrollGeneration,
      rid,
      'latest',
    );
    set({
      messageScrollGeneration: transaction.generation,
      messageScrollTransaction: transaction,
      highlightMid: null,
    });
    recordMessageScrollDiagnostic({
      rid,
      generation: transaction.generation,
      entry: 'latest',
      phase: 'history',
      historyLoaded: get().historyLoaded[rid] ?? false,
      messageCount: get().messages[rid]?.length ?? 0,
      stickToBottom: true,
      userIntent: false,
      jumpVisible: false,
    });
  },

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
    scheduleAttachmentArchiveCleanup();
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
          const snapshot = get();
          enqueueAttachmentArchives(
            latest,
            snapshot.subscriptions[rid]?.fname || snapshot.subscriptions[rid]?.name ||
              snapshot.rooms[rid]?.fname || snapshot.rooms[rid]?.name || '会话',
          );
          let merged = [...(get().messages[rid] ?? [])];
          for (const m of latest) merged = upsertMessage(merged, m);
          merged.sort((a, b) => messageTime(a) - messageTime(b));
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
      // LAN 控制消息仅用于兼容旧版本遗留数据，不能作为聊天内容显示。
      if (isLanControlMessage(msg.msg)) return;
      const rid = msg.rid;
      const state = get();
      enqueueAttachmentArchives(
        [msg],
        state.subscriptions[rid]?.fname || state.subscriptions[rid]?.name ||
          state.rooms[rid]?.fname || state.rooms[rid]?.name || '会话',
      );
      const alreadyKnown = (state.messages[rid] ?? []).some((message) => message._id === msg._id);
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
      if (!alreadyKnown) void notifyIfNeeded(msg, rid, state);
      const activeRid = get().activeRid;
      if (activeRid === rid) {
        if (
          get().subscriptions[rid] &&
          conversationIsActivelyViewed(activeRid, rid, document.hasFocus())
        ) {
          scheduleMarkRead(rid);
        }
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
      if (eventName.endsWith('/uiInteraction')) {
        useUiKit.getState().consumeServerInteraction(args[0]);
        return;
      }
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
    realtime.subscribe('stream-notify-user', `${auth.userId}/uiInteraction`);

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
    void startLanRuntime(undefined, acceptLanFile).catch((error) => {
      console.warn('[rcx] LAN 服务启动失败', error);
    });
  },

  openRoom: async (rid, options) => {
    const requestGeneration = retainedRoomGeneration;
    const transaction = nextMessageScrollTransaction(
      get().messageScrollGeneration,
      rid,
      options?.entry ?? 'latest',
      options?.messageId,
    );
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
      pendingUploadMessage: null,
      replyTo: null,
      // 普通打开/重复点击会话应回到最新消息，不能让上一次搜索或通知跳转
      // 遗留的高亮随后 scrollIntoView，把列表从底部再次拉回旧消息。
      highlightMid: null,
      // 切会话退出多选态
      selectMode: false,
      selectedMids: new Set(),
      messageScrollGeneration: transaction.generation,
      messageScrollTransaction: transaction,
    });
    recordMessageScrollDiagnostic({
      rid,
      generation: transaction.generation,
      entry: transaction.entry,
      phase: 'history',
      historyLoaded: get().historyLoaded[rid] ?? false,
      messageCount: get().messages[rid]?.length ?? 0,
      stickToBottom: transaction.entry === 'latest',
      userIntent: false,
      jumpVisible: false,
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
      enqueueAttachmentArchives(
        history,
        subscriptions[rid]?.fname || subscriptions[rid]?.name ||
          rooms[rid]?.fname || rooms[rid]?.name || '会话',
      );
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
      const existing = (get().messages[rid] ?? []).filter(
        (message) => !isLanControlMessage(message.msg),
      );
      // 历史中可能包含旧版本发送的 LAN 控制消息；先过滤，再合并本地已知消息。
      let merged = history.filter((message) => !isLanControlMessage(message.msg));
      for (const m of existing) merged = upsertMessage(merged, m);
      merged.sort((a, b) => messageTime(a) - messageTime(b));
      set({
        messages: { ...get().messages, [rid]: merged },
        historyLoaded: { ...get().historyLoaded, [rid]: true },
        hasMore: { ...get().hasMore, [rid]: history.length >= HISTORY_PAGE },
      });
      recordMessageScrollDiagnostic({
        rid,
        generation: transaction.generation,
        entry: transaction.entry,
        phase: 'history',
        historyLoaded: true,
        messageCount: merged.length,
        stickToBottom: transaction.entry === 'latest',
        userIntent: false,
        jumpVisible: false,
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
      const snapshot = get();
      enqueueAttachmentArchives(
        threadMessages,
        snapshot.subscriptions[rid]?.fname || snapshot.subscriptions[rid]?.name ||
          snapshot.rooms[rid]?.fname || snapshot.rooms[rid]?.name || '会话',
      );
      let list = get().messages[rid] ?? [];
      for (const m of threadMessages) {
        if (!isLanControlMessage(m.msg)) list = upsertMessage(list, m);
      }
      list.sort((a, b) => messageTime(a) - messageTime(b));
      set({ messages: { ...get().messages, [rid]: list } });
    } catch {
      /* 线程功能被服务器禁用时静默降级 */
    }
  },

  toggleThreadFollow: async (mid, follow) => {
    try {
      if (follow) await rest.followMessage(mid);
      else await rest.unfollowMessage(mid);

      const userId = useAuth.getState().user?._id ?? loadStoredAuth()?.userId;
      const rid = get().activeRid;
      const list = rid ? get().messages[rid] : undefined;
      if (rid && list && userId) {
        set({
          messages: {
            ...get().messages,
            [rid]: list.map((message) => {
              if (message._id !== mid) return message;
              const replies = new Set(message.replies ?? []);
              if (follow) replies.add(userId);
              else replies.delete(userId);
              return { ...message, replies: [...replies] };
            }),
          },
        });
      }
      toast.success(follow ? '已关注讨论串' : '已关闭讨论串提醒');
      return true;
    } catch (error) {
      toast.error(error, follow ? '关注讨论串失败' : '关闭讨论串提醒失败');
      return false;
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
    const snapshot = get();
    enqueueAttachmentArchives(
      older,
      snapshot.subscriptions[rid]?.fname || snapshot.subscriptions[rid]?.name ||
        snapshot.rooms[rid]?.fname || snapshot.rooms[rid]?.name || '会话',
    );
    let merged = get().messages[rid] ?? [];
    for (const m of older) {
      if (!isLanControlMessage(m.msg)) merged = upsertMessage(merged, m);
    }
    merged.sort((a, b) => messageTime(a) - messageTime(b));
    set({
      messages: { ...get().messages, [rid]: merged },
      hasMore: { ...get().hasMore, [rid]: older.length >= HISTORY_PAGE },
    });
    return older.length;
  },

  // 缓存里已有成员列表就不再请求；force 只在明确知道服务端已经变了时用
  // （群人数变化、邀请成功），它会作废在途请求，保证拿到的是本次快照。
  refreshMembers: (rid) => get().loadMembers(rid, { force: true }),

  loadMembers: async (rid, options) => {
    const force = options?.force === true;
    const cached = get().members[rid];
    if (!force && cached && !get().memberErrors[rid]) return cached;
    const type = get().subscriptions[rid]?.t ?? get().rooms[rid]?.t ?? 'c';
    const version = force ? invalidateMemberRequests(rid) : memberVersion(rid);
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
    const preserveWhitespace = opts?.preserveWhitespace === true;
    const normalized = preserveWhitespace ? text : text.trim();
    const me = useAuth.getState().user;
    if (!rid || !normalized.trim() || !me) return undefined;
    const explicitClientId = opts?.clientId;
    const clientId = safeMessageId(explicitClientId);
    if (explicitClientId !== undefined && !clientId) {
      return {
        id: explicitClientId,
        delivery: 'failed',
        reason: '消息 ID 无效，已拒绝发送',
      };
    }

    // 引用回复：文本前缀消息链接，服务端展开为引用附件。
    // 必须 await 到服务端真正的 Site_Url——缓存没热时 siteUrlSync 会回退到
    // getServerBase()，与服务端 Site_Url 不一致就不展开（issue #9）。
    const rawFullText = opts?.quote
      ? quoteLinkPrefix(opts.quote, get().subscriptions, await ensureSiteUrl()) + normalized
      : normalized;
    const fullText = usePrefs.getState().prefs.rcxAutoFormatMixedLanguage
      ? formatMixedLanguageText(rawFullText)
      : rawFullText;
    const expectsAgentReply = agentReplyNotificationTracker.expect(rid, fullText);

    // 超长消息按服务端 Message_MaxAllowedSize 自动分段发送，而不是整条被 400 拒绝
    // （issue #349）。引用前缀已经在 fullText 里，拆分后自然只落在第一段；
    // 不超长时 chunks[0] === fullText，走原有路径零行为变化。
    const chunks = toSendableMessageChunks(fullText, await messageMaxAllowedSize());
    const firstChunk = chunks[0] ?? fullText;

    // 乐观上屏：秒回显，pending 状态等服务器确认。
    // _id 由客户端生成并随请求提交 —— WS 回声先到时同 id 被 upsert 合并，
    // 不会「同一条显示两遍」；504 但服务端已落库时重试同 id 也不会发出第二条。
    const resolvedClientId = clientId ?? randomMessageId();

    const sendRemainingChunks = async (): Promise<string | null> => {
      // 后续分段：各自生成新 id 顺序发送，WS 回声按 id 合并不会重复上屏。
      // 中途失败即停止：已发出的段不回滚，剩余段不再发送（issue #349）。
      for (let index = 1; index < chunks.length; index += 1) {
        const chunkId = randomMessageId();
        rememberLocalMessage(chunkId);
        try {
          const chunkMessage = await rest.sendMessageRaw({
            _id: chunkId,
            rid,
            msg: chunks[index] ?? '',
            ...(opts?.tmid ? { tmid: opts.tmid } : {}),
          });
          set({
            messages: {
              ...get().messages,
              [rid]: upsertMessage(get().messages[rid] ?? [], chunkMessage),
            },
          });
        } catch (chunkError) {
          const reason = `消息过长已分段发送，第 ${index + 1}/${chunks.length} 段失败，后续段已停止：${humanError(chunkError, '消息发送失败')}`;
          toast.show({ kind: 'error', message: reason });
          return reason;
        }
      }
      return null;
    };

    rememberLocalMessage(resolvedClientId);
    const temp: RcMessage = {
      _id: resolvedClientId,
      rid,
      msg: firstChunk,
      ts: new Date().toISOString(),
      u: { _id: me._id, username: me.username, name: me.name },
      ...(opts?.tmid ? { tmid: opts.tmid } : {}),
      ...(opts?.quote ? { attachments: [localQuoteAttachment(opts.quote)] } : {}),
      pending: true,
    };
    set({
      messages: { ...get().messages, [rid]: upsertMessage(get().messages[rid] ?? [], temp) },
      ...(opts?.tmid ? {} : { scrollNonce: get().scrollNonce + 1 }),
    });
    // 发送即视为停止输入
    void realtime.call('stream-notify-room', `${rid}/user-activity`, me.username, []).catch(() => {});

    try {
      const msg = await rest.sendMessageRaw({
        _id: resolvedClientId,
        rid,
        msg: firstChunk,
        ...(opts?.tmid ? { tmid: opts.tmid } : {}),
      });
      set({ messages: { ...get().messages, [rid]: upsertMessage(get().messages[rid] ?? [], msg) } });
      useOnboarding.getState().markChecklist('sentMessage');
      const remainingFailure = await sendRemainingChunks();
      if (remainingFailure) {
        return { id: resolvedClientId, delivery: 'failed' as const, reason: remainingFailure };
      }
      scheduleReceiptRefresh(rid);
      return { id: resolvedClientId, delivery: 'server' as const };
    } catch (err) {
      const uncertain = isUncertainSendError(err);
      let delivery: ChatSendResult['delivery'] = uncertain ? 'unknown' : 'failed';
      let reason = uncertain
        ? '发送结果暂时无法确认，请检查原会话后重试'
        : humanError(err, '消息发送失败');
      if (uncertain) {
        // 8.6.1 对重复 _id 会只保留一条但返回 500；先按 id 回查，避免把已成功的消息
        // 又转成 LAN 离线消息或未知态。
        try {
          const existing = await rest.getMessage(resolvedClientId);
          if (existing.rid === rid && existing.msg === firstChunk) {
            set({
              messages: {
                ...get().messages,
                [rid]: upsertMessage(get().messages[rid] ?? [], existing),
              },
            });
            useOnboarding.getState().markChecklist('sentMessage');
            const remainingFailure = await sendRemainingChunks();
            if (remainingFailure) {
              return { id: resolvedClientId, delivery: 'failed' as const, reason: remainingFailure };
            }
            scheduleReceiptRefresh(rid);
            return { id: resolvedClientId, delivery: 'server' as const };
          }
          if (existing.rid === rid && existing.msg !== firstChunk) {
            delivery = 'failed';
            reason = '原会话里同一消息 ID 已存在不同内容，请检查原会话后重试';
          } else if (existing.rid !== rid) {
            delivery = 'failed';
            reason = '同一消息 ID 已被其他会话占用，请检查原会话后重试';
          }
        } catch {
          /* 服务端不可达或确实未落库，继续判断 LAN 降级 */
        }
      }

      // 只对**仍是 pending** 的那条标失败：WS 回声可能已抢先把 temp 替换成真实消息
      //（同 _id、无 pending 字段），此时其实发送成功了，不能给它扣一顶失败的帽子。
      const cur = get().messages[rid] ?? [];
      const stillPending = cur.some((m) => m._id === resolvedClientId && m.pending);
      if (!stillPending) {
        const currentMessage = findMessageById(get().messages, resolvedClientId);
        if (currentMessage?.rid === rid && currentMessage.msg === firstChunk) {
          useOnboarding.getState().markChecklist('sentMessage');
          const remainingFailure = await sendRemainingChunks();
          if (remainingFailure) {
            return { id: resolvedClientId, delivery: 'failed' as const, reason: remainingFailure };
          }
          scheduleReceiptRefresh(rid);
          return { id: resolvedClientId, delivery: 'server' as const };
        }
        delivery = currentMessage ? 'failed' : 'unknown';
        reason = !currentMessage
          ? '发送结果暂时无法确认，请检查原会话后重试'
          : currentMessage.rid !== rid
            ? '同一消息 ID 已被其他会话占用，请检查原会话后重试'
            : '原会话里同一消息 ID 已存在不同内容，请检查原会话后重试';
      }
      set({
        messages: {
          ...get().messages,
          [rid]: cur.map((m) =>
            m._id === resolvedClientId && m.pending ? { ...m, pending: false, failed: true } : m,
          ),
        },
      });
      if (expectsAgentReply) agentReplyNotificationTracker.cancel(rid);
      toast.show({
        kind: 'error',
        message: reason,
        ...(explicitClientId === undefined
          ? { action: { label: '重试', onClick: () => void get().resendMessage(resolvedClientId) } }
          : {}),
      });
      return {
        id: resolvedClientId,
        delivery,
        reason,
      };
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
    const serverCommand = findCommand(get().slashCommands, command);
    if (!serverCommand) {
      toast.show({ kind: 'error', message: `没有 /${command} 这个命令` });
      return;
    }
    try {
      const triggerId = serverCommand.appId
        ? useUiKit.getState().begin(serverCommand.appId)
        : undefined;
      await rest.runCommand(command, rid, params, tmid, triggerId);
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
    const messageText = usePrefs.getState().prefs.rcxAutoFormatMixedLanguage
      ? formatMixedLanguageText(failed.msg)
      : failed.msg;
    rememberLocalMessage(tempId);
    set({
      messages: {
        ...get().messages,
        [rid]: (get().messages[rid] ?? []).map((m) =>
          m._id === tempId ? { ...m, msg: messageText, pending: true, failed: false } : m,
        ),
      },
    });
    const expectsAgentReply = agentReplyNotificationTracker.expect(rid, messageText);
    try {
      // 附件是本地展示用的，不随重发提交（引用信息已在消息文本前缀里）。
      // 沿用同一个 _id：上次其实已落库时（504 但服务端收到了），同 id 不会发出第二条。
      const msg = await rest.sendMessageRaw({
        _id: tempId,
        rid,
        msg: messageText,
        ...(failed.tmid ? { tmid: failed.tmid } : {}),
      });
      set({ messages: { ...get().messages, [rid]: upsertMessage(get().messages[rid] ?? [], msg) } });
    } catch {
      // 同 send()：回声已替换成真实消息（无 pending 字段）就不再标失败
      const cur = get().messages[rid] ?? [];
      if (!cur.some((m) => m._id === tempId && m.pending)) return;
      if (expectsAgentReply) agentReplyNotificationTracker.cancel(rid);
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

    // 消息定位是独立事务，优先级高于普通打开后的贴底；同一房间也要生成新 generation。
    const opening = get().openRoom(targetRid, { entry: 'locate', messageId: mid });
    const generation = get().messageScrollTransaction?.generation;
    if (generation === undefined) {
      await opening;
      return;
    }
    const isCurrent = () => messageScrollTransactionMatches(
      get().messageScrollTransaction,
      generation,
      targetRid,
      'locate',
      mid,
    );

    let target = get().messages[targetRid]?.find((message) => message._id === mid);
    if (!target) {
      target = await rest.getMessage(mid).catch(() => undefined);
    }
    if (!isCurrent()) return;
    if (target && target.rid !== targetRid) {
      return get().jumpToMessage(mid, target.rid);
    }
    if (target?.tmid) {
      await opening;
      if (!isCurrent()) return;
      await get().openThread(target.tmid);
      const panel = get().rightPanel;
      if (
        !isCurrent() ||
        get().activeRid !== targetRid ||
        panel?.kind !== 'thread' ||
        panel.mid !== target.tmid
      ) {
        return;
      }
      set({ highlightMid: mid });
      setTimeout(() => {
        if (isCurrent() && get().highlightMid === mid) set({ highlightMid: null });
      }, 2600);
      return;
    }

    await opening;
    if (!isCurrent()) return;

    // 消息不在已加载的范围内 → 向上翻页找（最多 5 页，避免无限拉）
    for (let i = 0; i < 5; i++) {
      if (!isCurrent()) return;
      const list = get().messages[targetRid] ?? [];
      if (list.some((m) => m._id === mid)) break;
      if (get().hasMore[targetRid] === false) break;
      const loaded = await get().loadOlder();
      if (!isCurrent()) return;
      if (loaded === 0) break;
    }

    const found = (get().messages[targetRid] ?? []).some((m) => m._id === mid);
    if (!found) {
      toast.info('原消息太久远，未能定位');
      return;
    }

    if (!isCurrent()) return;
    set({ highlightMid: mid });
    // 滚动由 MessageItem 侧的 effect 执行（拿到 DOM 节点）
    setTimeout(() => {
      if (isCurrent() && get().highlightMid === mid) set({ highlightMid: null });
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

  deleteMessage: async (message) => {
    const { _id: msgId, rid } = message;
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
        // Rocket.Chat 旧版本没有 rooms.join：服务端返回 404，部分部署（反代/网关）对
        // 不支持的端点返回 405（issue #62）。两者都走 DDP joinRoom 兼容路径。
        const missingEndpoint =
          err instanceof RcApiError && (err.status === 404 || err.status === 405);
        if (!missingEndpoint) throw err;
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
      await forwardSingleMessage(msg, rid);
    }
    toast.success(
      rids.length === 1 ? `已转发到「${names[0]}」` : `已转发到 ${rids.length} 个会话`,
    );
  },

  forwardMessages: async (msgs, rids, merge) => {
    // 按时间正序转发，保证目标会话里顺序和原会话一致
    const ordered = [...msgs].sort((a, b) => messageTime(a) - messageTime(b));
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
              text: stripQuotePrefix(stripAgentSessionMarker(m.msg || '')),
              ts: m.ts,
              attachments: m.attachments,
            })),
            ordered.every((message) => message.rid === rid),
          ),
        });
      } else {
        for (const m of ordered) {
          await forwardSingleMessage(m, rid);
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

  createDiscussionFrom: async (msg, requestedName) => {
    const id = toast.loading('正在创建讨论…');
    try {
      const name = (requestedName?.trim() || stripQuotePrefix(msg.msg) || '讨论').slice(0, 40);
      const room = await rest.createDiscussion(msg.rid, name, msg._id);
      await refreshSubsAndRooms(set);
      await get().openRoom(room._id);
      toast.update(id, { kind: 'success', message: `已创建讨论「${name}」` });
    } catch (err) {
      toast.update(id, { kind: 'error', message: humanError(err, '创建讨论失败') });
    }
  },

  requestUpload: (files, message) => {
    if (files.length > 0) set({ pendingFiles: files, pendingUploadMessage: message?.trim() || null });
  },

  confirmUpload: async (message) => {
    const files = get().pendingFiles;
    const uploadMessage = message ?? get().pendingUploadMessage ?? undefined;
    set({ pendingFiles: null, pendingUploadMessage: null });
    return files ? get().uploadFiles(files, undefined, uploadMessage) : false;
  },

  cancelUpload: () => set({ pendingFiles: null, pendingUploadMessage: null }),

  uploadFiles: async (files, tmid, message) => {
    const rid = get().activeRid;
    if (!rid || files.length === 0) return false;
    // 服务器上传接口是大小限制的唯一权威。公开设置可能因缓存、代理或部署
    // 配置与实际上传能力不一致，客户端不能据此提前拒绝（issue #367）。
    // 用图片/文件回复：主输入区挂着的引用要跟着第一个文件发出去，服务端会把
    // 消息链接前缀展开成引用附件（issue #91）。话题面板上传（带 tmid）不消费它。
    const quote = !tmid ? get().replyTo : null;
    if (quote) set({ replyTo: null });
    const label = files.length === 1 ? files[0].name : `${files.length} 个文件`;
    const id = toast.loading(`正在发送 ${label}…`);
    set({ uploading: get().uploading + files.length });
    try {
      const quoteMsg = quote
        ? quoteLinkPrefix(quote, get().subscriptions, await ensureSiteUrl())
        : undefined;
      const caption = message?.trim();
      const firstMessage = quoteMsg ? `${quoteMsg}${caption ?? ''}` : caption;
      for (const [index, file] of files.entries()) {
        await uploadBlobToRoom(rid, file, {
          tmid,
          fileName: file.name,
          ...(index === 0 && firstMessage ? { msg: firstMessage } : {}),
        });
        set({ uploading: get().uploading - 1 });
      }
      toast.dismiss(id);
      return true;
    } catch (err) {
      set({ uploading: 0 });
      toast.update(id, {
        kind: 'error',
        message: humanError(err, `发送 ${label} 失败`),
      });
      return false;
    }
  },

  uploadNativeFiles: async (paths, tmid, message) => {
    const rid = get().activeRid;
    const me = useAuth.getState().user;
    if (!rid || !me || paths.length === 0) return false;
    // 原生拖拽文件回复也要带引用（issue #91 同类）。挂着引用时不走局域网
    // 直传——那条链路绕开 Rocket.Chat，引用附件带不过去。
    const quote = !tmid ? get().replyTo : null;
    if (quote) set({ replyTo: null });
    const id = toast.loading(`正在发送 ${paths.length === 1 ? '文件' : `${paths.length} 个文件`}…`);
    set({ uploading: get().uploading + paths.length });
    try {
      const quoteMsg = quote
        ? quoteLinkPrefix(quote, get().subscriptions, await ensureSiteUrl())
        : undefined;
      const caption = message?.trim();
      const firstMessage = quoteMsg ? `${quoteMsg}${caption ?? ''}` : caption;
      for (const [index, path] of paths.entries()) {
        await statDesktopFile(path);
        await uploadDesktopFile(path, rid, {
          tmid,
          ...(index === 0 && firstMessage ? { msg: firstMessage } : {}),
        });
        set({ uploading: Math.max(0, get().uploading - 1) });
      }
      toast.dismiss(id);
      return true;
    } catch (error) {
      set({ uploading: 0 });
      toast.update(id, {
        kind: 'error',
        message: humanError(error, '发送文件失败'),
      });
      return false;
    }
  },

  sendP2pFiles: async (paths) => {
    const rid = get().activeRid;
    const me = useAuth.getState().user;
    if (!rid || !me || paths.length === 0) return false;
    const recipients = await lanRecipientIds(rid).catch(() => []);
    if (recipients.length !== 1) {
      toast.error(new Error('P2P 直传仅支持一对一私聊'));
      return false;
    }
    const recipient = recipients[0];
    const id = toast.loading(`正在通过 P2P 发送 ${paths.length} 个文件…`);
    try {
      for (const path of paths) {
        const originalTs = Date.now();
        const receipt = await sendLanFile(recipient, path, {
          messageId: randomMessageId(),
          roomId: rid,
          originalTs,
        });
        insertLanFileMessage(
          localLanFileMessage({ ...receipt, roomId: rid, originalTs, localPath: path }, me, receipt.bytesPerSecond),
        );
      }
      toast.dismiss(id);
      toast.info('已通过 P2P 局域网直传发送');
      return true;
    } catch (error) {
      toast.dismiss(id);
      toast.error(error, 'P2P 直传不可用');
      return false;
    }
  },

  prepareP2p: async () => {
    const rid = get().activeRid;
    if (!rid) return false;
    const recipients = await lanRecipientIds(rid).catch(() => []);
    if (recipients.length !== 1) {
      toast.error(new Error('P2P 直传仅支持一对一私聊'));
      return false;
    }
    try {
      if (!(await probeLanPeer(recipients[0]))) throw new Error('对方当前不可用 P2P 直传');
      toast.info('P2P 握手成功，请选择要发送的文件');
      return true;
    } catch (error) {
      toast.error(error, 'P2P 直传不可用');
      return false;
    }
  },
}));

if (typeof window !== 'undefined') window.__chat = useChat;
