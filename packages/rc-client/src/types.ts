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
}

export interface RcMessageAttachmentField {
  short?: boolean;
  title?: string;
  value?: string;
}

export interface RcMessageAttachment {
  color?: string;
  text?: string;
  title?: string;
  title_link?: string;
  /** 文件附件标记（RC 文件消息为 true，可下载） */
  title_link_download?: boolean;
  description?: string;
  image_url?: string;
  author_name?: string;
  author_icon?: string;
  fields?: RcMessageAttachmentField[];
  collapsed?: boolean;
}

export interface RcMessage {
  _id: string;
  rid: string;
  msg: string;
  ts: RcDate;
  u: { _id: string; username: string; name?: string };
  _updatedAt?: RcDate;
  editedAt?: RcDate;
  editedBy?: { _id: string; username: string };
  /** 系统消息类型（uj=加入 ul=离开 等），普通消息无此字段 */
  t?: string;
  tmid?: string;
  tcount?: number;
  /** 文件消息的文件信息 */
  file?: { _id: string; name: string; type?: string; size?: number };
  attachments?: RcMessageAttachment[];
  reactions?: Record<string, { usernames: string[] }>;
  pinned?: boolean;
  /** 标记（星标）了这条消息的用户 */
  starred?: { _id: string }[];
  groupable?: boolean;
}

export interface RcRoom {
  _id: string;
  t: RoomType;
  name?: string;
  fname?: string;
  /** 父房间 id：有值说明这是一个「讨论」（Discussion） */
  prid?: string;
  topic?: string;
  announcement?: string;
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
  /** 置顶会话（favorite） */
  f?: boolean;
  /** 父房间 id：有值说明这是一个「讨论」 */
  prid?: string;
  /** 免打扰 */
  disableNotifications?: boolean;
  ls?: RcDate;
  _updatedAt: RcDate;
  u: { _id: string; username: string };
}

export interface RcLoginData {
  userId: string;
  authToken: string;
  me: RcUser;
}
