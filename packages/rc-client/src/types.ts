/** Rocket.Chat 的时间字段：REST 返回 ISO 字符串，实时 API 返回 { $date: ms } */
export type RcDate = string | { $date: number };

export function tsMs(d: RcDate | undefined | null): number {
  if (d == null) return 0;
  if (typeof d === 'string') return new Date(d).getTime();
  return d.$date;
}

export type RoomType = 'c' | 'p' | 'd' | 'l';

export interface RcUser {
  _id: string;
  username: string;
  name?: string;
  status?: string;
  emails?: { address: string; verified?: boolean }[];
  avatarETag?: string;
  /** 全局角色（admin / user / bot…）。admin 在所有房间里通吃 */
  roles?: string[];
}

export interface RcMessageAttachmentField {
  short?: boolean;
  title?: string;
  value?: string;
}

export interface RcMessageAttachment {
  /** 服务端附件类别，例如留存策略清理后的 removed-file。 */
  type?: string;
  color?: string;
  text?: string;
  title?: string;
  /** 引用回复的原消息链接（有值即按引用样式渲染） */
  message_link?: string;
  ts?: RcDate;
  title_link?: string;
  /** 文件附件标记（RC 文件消息为 true，可下载） */
  title_link_download?: boolean;
  description?: string;
  image_url?: string;
  /** 图片原始尺寸（RC 上传时探测）。渲染前按它预留空间，加载完成不再撑开列表 */
  image_dimensions?: { width?: number; height?: number };
  author_name?: string;
  author_icon?: string;
  /** 引用消息展开后的原附件列表。 */
  attachments?: RcMessageAttachment[];
  fields?: RcMessageAttachmentField[];
  collapsed?: boolean;
}

export interface RcMessageMention {
  _id: string;
  username: string;
  name?: string;
  type?: 'user' | 'team';
}

export interface RcUiKitText {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  i18n?: { key: string; args?: Record<string, string | number> };
}

export interface RcUiKitOption {
  text: RcUiKitText;
  value: string;
}

export interface RcUiKitElement {
  type: string;
  appId?: string;
  actionId?: string;
  text?: RcUiKitText;
  placeholder?: RcUiKitText;
  initialValue?: string;
  value?: string;
  options?: RcUiKitOption[];
}

export interface RcUiKitBlock {
  type: string;
  appId?: string;
  blockId?: string;
  text?: RcUiKitText;
  label?: RcUiKitText;
  optional?: boolean;
  element?: RcUiKitElement;
  elements?: Array<RcUiKitElement | RcUiKitText>;
  accessory?: RcUiKitElement;
}

export interface RcUiKitView {
  id: string;
  appId?: string;
  title: RcUiKitText;
  submit?: RcUiKitElement;
  close?: RcUiKitElement;
  blocks: RcUiKitBlock[];
}

export interface RcUiKitViewSubmitInteraction {
  type: 'viewSubmit';
  triggerId: string;
  viewId: string;
  rid?: string;
  payload: {
    view: RcUiKitView & {
      state: Record<string, Record<string, unknown>>;
    };
  };
}

export interface RcUiKitBlockActionInteraction {
  type: 'blockAction';
  triggerId: string;
  actionId: string;
  payload: { blockId: string; value: unknown };
  container: { type: 'message' | 'view'; id: string };
  mid?: string;
  tmid?: string;
  rid?: string;
}

export type RcUiKitUserInteraction =
  | RcUiKitViewSubmitInteraction
  | RcUiKitBlockActionInteraction;

export type RcUiKitServerInteraction =
  | {
      type: 'modal.open' | 'modal.update';
      triggerId: string;
      appId: string;
      view: RcUiKitView;
    }
  | {
      type: 'modal.close';
      triggerId: string;
      appId: string;
    }
  | {
      type: 'errors';
      triggerId: string;
      appId: string;
      viewId: string;
      errors: Record<string, string> | Array<Record<string, string>>;
    };

export interface RcMessage {
  _id: string;
  rid: string;
  msg: string;
  ts: RcDate;
  u: { _id: string; username: string; name?: string };
  _updatedAt?: RcDate;
  editedAt?: RcDate;
  editedBy?: { _id: string; username: string };
  /** 系统消息类型（uj=加入 ul=离开 discussion-created=建了讨论 等），普通消息无此字段 */
  t?: string;
  /** subscription-role-added/removed 的房间角色。 */
  role?: 'owner' | 'moderator' | 'leader';
  tmid?: string;
  /** 官方端勾选「同时发送到频道」时为 true；忽略它会让这条回复从主消息流消失。 */
  tshow?: boolean;
  /** 关注该讨论串的用户 ID；服务端据此决定谁接收新回复提醒。 */
  replies?: string[];
  tcount?: number;
  /**
   * 讨论房间 id。t='discussion-created' 的消息带这个字段 ——
   * 它就是父频道里那张「讨论」卡片要跳过去的目标。
   */
  drid?: string;
  /** 讨论里的消息条数（服务端随讨论更新） */
  dcount?: number;
  /** 讨论里最后一条消息的时间 */
  dlm?: RcDate;
  /** 文件消息的文件信息 */
  file?: { _id: string; name: string; type?: string; size?: number };
  /** 消息里 URL 的服务端解析结果（链接卡片预览） */
  urls?: {
    url: string;
    meta?: Record<string, string>;
  }[];
  attachments?: RcMessageAttachment[];
  /** Rocket.Chat Apps UI Kit 结构化消息块。 */
  blocks?: RcUiKitBlock[];
  reactions?: Record<string, { usernames: string[] }>;
  /** 服务端解析后的结构化提及；比正文正则可靠。 */
  mentions?: RcMessageMention[];
  pinned?: boolean;
  /** 标记（星标）了这条消息的用户 */
  starred?: { _id: string }[];
  /** Rocket.Chat 可选消息自定义字段（需工作区显式启用并配置校验）。 */
  customFields?: Record<string, unknown>;
  groupable?: boolean;
  /** ---- 以下为客户端本地字段（不来自服务器）---- */
  /** 发送中（乐观上屏，等待服务器确认） */
  pending?: boolean;
  /** 发送失败（可重试） */
  failed?: boolean;
  /** LAN 断网消息的原始创建时间；服务器回灌后仍按此时间展示。 */
  rocketxOriginalTs?: number;
  /** 已经通过可信 LAN 投递，等待作者回灌 Rocket.Chat。 */
  rocketxOffline?: boolean;
  /** 已认证 LAN 文件在本机的绝对路径；只由桌面端原生接收器写入。 */
  rocketxLocalPath?: string;
  /** LAN 文件整文件 BLAKE3，用于去重与验收。 */
  rocketxLanHash?: string;
  /** 发送端实测的 LAN 文件吞吐量。 */
  rocketxLanBytesPerSecond?: number;
}

export interface RcRoom {
  _id: string;
  t: RoomType;
  name?: string;
  fname?: string;
  /** 父房间 id：有值说明这是一个「讨论」（Discussion） */
  prid?: string;
  /** true 表示这是某个 Team 的主频道（Team 信息在 room 上，不在订阅上） */
  teamMain?: boolean;
  /** 所属 Team 的 id */
  teamId?: string;
  topic?: string;
  announcement?: string;
  description?: string;
  /** 只读频道（只有拥有者能发言） */
  ro?: boolean;
  /** 已归档（只读，且不再收新消息） */
  archived?: boolean;
  /** 被禁言的人（存的是 username，不是 _id） */
  muted?: string[];
  /** 创建者 */
  u?: { _id: string; username: string; name?: string };
  ts?: RcDate;
  usersCount?: number;
  usernames?: string[];
  uids?: string[];
  lastMessage?: RcMessage;
  lm?: RcDate;
  _updatedAt?: RcDate;
}

export interface RcSubscription {
  _id: string;
  rid: string;
  name: string;
  fname?: string;
  t: RoomType;
  unread: number;
  alert: boolean;
  open: boolean;
  /** 被 @ 我的次数（区别于 groupMentions 的 @all/@here） */
  userMentions?: number;
  /** 被 @all / @here 的次数 */
  groupMentions?: number;
  /** 置顶会话（favorite） */
  f?: boolean;
  /** 父房间 id：有值说明这是一个「讨论」 */
  prid?: string;
  /** true 表示这是某个 Team 的主频道 */
  teamMain?: boolean;
  /** 所属 Team 的 id（Team 下的子频道） */
  teamId?: string;
  /** 免打扰 */
  disableNotifications?: boolean;
  ls?: RcDate;
  _updatedAt: RcDate;
  u: { _id: string; username: string };
}

/** Rocket.Chat 用户偏好（服务端持久化，跨设备同步） */
export interface RcPreferences {
  // 侧栏
  sidebarGroupByType?: boolean;
  sidebarShowFavorites?: boolean;
  sidebarShowUnread?: boolean;
  sidebarSortby?: 'activity' | 'alphabetical';
  sidebarViewMode?: 'extended' | 'medium' | 'condensed';
  sidebarDisplayAvatar?: boolean;
  // 消息
  sendOnEnter?: 'normal' | 'alternative' | 'desktop';
  autoImageLoad?: boolean;
  useEmojis?: boolean;
  showThreadsInMainChannel?: boolean;
  displayAvatars?: boolean;
  // 通知
  desktopNotifications?: 'all' | 'mentions' | 'nothing';
  unreadAlert?: boolean;
  muteFocusedConversations?: boolean;
  notificationsSoundVolume?: number;
  enableAutoAway?: boolean;
  idleTimeLimit?: number;
  themeAppearence?: 'auto' | 'light' | 'dark';
  // ---- RocketX 自定义键：RC 不认识它们，但 users.setPreferences 会原样存取，可跨设备同步 ----
  /** 备注名（`u:<username>` 给人、`r:<rid>` 给会话），见 apps/web/src/stores/aliases.ts */
  rcxAliases?: Record<string, string>;
  /** 名字显示格式：只显示备注名 / 备注名（原名） */
  rcxNameFormat?: 'alias' | 'aliasWithReal';
  /** 超长消息折叠：特别长的消息只显示预览，点「展开全部」查看（默认开启） */
  rcxCollapseLongMessages?: boolean;
  /** 折叠时机：消息超过多少屏才折叠（默认半屏） */
  rcxLongMessageFoldAt?: 'half' | 'one' | 'two';
  /** 发送消息时在汉字与英文/数字之间自动补空格（默认开启） */
  rcxAutoFormatMixedLanguage?: boolean;
}

/** 服务器提供的斜杠命令 */
export interface RcSlashCommand {
  command: string;
  /** Apps Engine 命令所属应用；生成 UI Kit trigger 时需要。 */
  appId?: string;
  /** 参数提示。注意可能是 i18n 键名（如 Slash_Topic_Params），要翻译后再显示 */
  params?: string;
  /** 说明。RC 返回的多半是 i18n 键名（如 Slash_Shrug_Description），别直接渲染 */
  description?: string;
}

/** 房间里某人的角色。只有「有角色的人」才会出现在 channels.roles 结果里 */
export interface RcRoomRole {
  _id: string;
  rid: string;
  u: { _id: string; username: string; name?: string };
  roles: RoomRole[];
}

export type RoomRole = 'owner' | 'moderator' | 'leader';

/** channels.files / groups.files / im.files 返回的文件 */
export interface RcRoomFile {
  _id: string;
  name: string;
  type?: string;
  size?: number;
  uploadedAt?: RcDate;
  url?: string;
  path?: string;
  user?: { _id: string; username: string; name?: string };
}

export interface RcTeam {
  _id: string;
  name: string;
  type: number;
  roomId: string;
  createdAt: RcDate;
  createdBy: { _id: string; username: string };
  rooms?: number;
}

export interface RcLoginData {
  userId: string;
  authToken: string;
  me: RcUser;
}
