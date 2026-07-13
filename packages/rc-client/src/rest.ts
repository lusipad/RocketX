import { tsMs } from './types';
import type {
  RcDate,
  RcLoginData,
  RcPreferences,
  RcTeam,
  RcMessage,
  RcMessageAttachment,
  RcRoom,
  RcSubscription,
  RcUser,
  RoomType,
} from './types';

export class RcApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public errorType?: string,
  ) {
    super(message);
    this.name = 'RcApiError';
  }
}

export interface RcRestOptions {
  /** Rocket.Chat 服务地址，留空表示同源（开发时经 Vite 代理） */
  baseUrl?: string;
  /**
   * 每次请求实时取认证信息（如从 localStorage 读）。
   * 优先于 setAuth 注入的内存状态，可避免模块多实例/时序问题。
   */
  authProvider?: () => { authToken: string; userId: string } | null;
  /**
   * 自定义 fetch 实现。桌面端（Tauri）注入 plugin-http 的 fetch
   * 走 Rust 通道绕开 webview CORS；缺省用全局 fetch。
   */
  fetchImpl?: typeof fetch;
}

/**
 * Rocket.Chat REST API 客户端（api/v1）。
 * 只依赖 fetch，浏览器 / Node 18+ 通用。
 */
export class RcRestClient {
  baseUrl: string;
  authToken: string | null = null;
  userId: string | null = null;
  private authProvider?: RcRestOptions['authProvider'];
  private fetchImpl?: typeof fetch;

  constructor(options: RcRestOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.authProvider = options.authProvider;
    this.fetchImpl = options.fetchImpl;
  }

  setAuth(authToken: string | null, userId: string | null): void {
    this.authToken = authToken;
    this.userId = userId;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    let url = `${this.baseUrl}/api/v1/${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers: Record<string, string> = {};
    if (!isForm) headers['Content-Type'] = 'application/json';
    const auth =
      this.authProvider?.() ??
      (this.authToken && this.userId
        ? { authToken: this.authToken, userId: this.userId }
        : null);
    if (auth) {
      headers['X-Auth-Token'] = auth.authToken;
      headers['X-User-Id'] = auth.userId;
    }
    const doFetch = this.fetchImpl ?? fetch;
    const res = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* 空响应体 */
    }
    if (!res.ok) {
      throw new RcApiError(
        data?.error ?? data?.message ?? `HTTP ${res.status}`,
        res.status,
        data?.errorType,
      );
    }
    return data as T;
  }

  // ---- 认证 ----

  async login(user: string, password: string): Promise<RcLoginData> {
    const res = await this.request<{ data: RcLoginData }>('POST', 'login', { user, password });
    this.setAuth(res.data.authToken, res.data.userId);
    return res.data;
  }

  /** 用已有 token 恢复会话（本地存储的 token 重新登录） */
  async loginWithToken(token: string): Promise<RcLoginData> {
    const res = await this.request<{ data: RcLoginData }>('POST', 'login', { resume: token });
    this.setAuth(res.data.authToken, res.data.userId);
    return res.data;
  }

  async logout(): Promise<void> {
    try {
      await this.request('POST', 'logout');
    } finally {
      this.setAuth(null, null);
    }
  }

  me(): Promise<RcUser> {
    return this.request<RcUser>('GET', 'me');
  }

  // ---- 用户偏好（服务端持久化，跨设备同步）----

  async getPreferences(): Promise<RcPreferences> {
    const res = await this.request<{ settings?: { preferences?: RcPreferences } }>('GET', 'me');
    return res.settings?.preferences ?? {};
  }

  /** 当前登录用户 id（authProvider 模式下 this.userId 为空，需实时取） */
  private currentUserId(): string | null {
    return this.authProvider?.()?.userId ?? this.userId;
  }

  async setPreferences(data: Partial<RcPreferences>): Promise<void> {
    const userId = this.currentUserId();
    if (!userId) throw new Error('未登录');
    await this.request('POST', 'users.setPreferences', { userId, data });
  }

  /** 设置在线状态（online / away / busy / offline） */
  setStatus(status: string, message?: string): Promise<unknown> {
    return this.request('POST', 'users.setStatus', {
      status,
      ...(message !== undefined ? { message } : {}),
    });
  }

  // ---- Teams ----

  async listTeams(count = 50): Promise<RcTeam[]> {
    const res = await this.request<{ teams: RcTeam[] }>('GET', 'teams.list', undefined, { count });
    return res.teams ?? [];
  }

  /** 创建 Team（type: 0 公开 / 1 私有） */
  async createTeam(name: string, members: string[], priv = true): Promise<RcTeam> {
    const res = await this.request<{ team: RcTeam }>('POST', 'teams.create', {
      name,
      type: priv ? 1 : 0,
      members,
    });
    return res.team;
  }

  /** Team 下的频道列表 */
  async listTeamRooms(teamId: string, count = 50): Promise<RcRoom[]> {
    const res = await this.request<{ rooms: RcRoom[] }>('GET', 'teams.listRooms', undefined, {
      teamId,
      count,
    });
    return res.rooms ?? [];
  }

  // ---- 会话 / 房间 ----

  async getSubscriptions(): Promise<RcSubscription[]> {
    const res = await this.request<{ update: RcSubscription[] }>('GET', 'subscriptions.get');
    return res.update ?? [];
  }

  async getRooms(): Promise<RcRoom[]> {
    const res = await this.request<{ update: RcRoom[] }>('GET', 'rooms.get');
    return res.update ?? [];
  }

  markRead(rid: string): Promise<unknown> {
    return this.request('POST', 'subscriptions.read', { rid });
  }

  async createDirectMessage(username: string): Promise<RcRoom> {
    const res = await this.request<{ room: RcRoom }>('POST', 'im.create', { username });
    return res.room;
  }

  /** 打开 DM 会话（创建后订阅可能是关闭状态，需要显式 open 才会出现在会话列表） */
  openDirectMessage(roomId: string): Promise<unknown> {
    return this.request('POST', 'im.open', { roomId });
  }

  /** 创建群组：priv=true 走 groups.create（私有），否则 channels.create（公开频道） */
  async createGroup(name: string, members: string[], priv = true): Promise<RcRoom> {
    if (priv) {
      const res = await this.request<{ group: RcRoom }>('POST', 'groups.create', {
        name,
        members,
      });
      return res.group;
    }
    const res = await this.request<{ channel: RcRoom }>('POST', 'channels.create', {
      name,
      members,
    });
    return res.channel;
  }

  /** 目录检索：全部成员 / 公开频道（分页） */
  async directory(
    type: 'users' | 'channels',
    text = '',
    count = 50,
    offset = 0,
  ): Promise<{ result: (RcUser & RcRoom)[]; total: number }> {
    const res = await this.request<{ result: (RcUser & RcRoom)[]; total: number }>(
      'GET',
      'directory',
      undefined,
      { text, type, count, offset, sort: '{"username":1}' },
    );
    return { result: res.result ?? [], total: res.total ?? 0 };
  }

  /** 用户列表（需要 view-outside-room 权限，作为 directory 的回退） */
  async listUsers(count = 100): Promise<{ users: RcUser[]; total: number }> {
    const res = await this.request<{ users: RcUser[]; total: number }>(
      'GET',
      'users.list',
      undefined,
      { count },
    );
    return { users: res.users ?? [], total: res.total ?? 0 };
  }

  /**
   * 成员目录：directory → users.list → spotlight 三级回退。
   * 不同服务器/权限配置下总能拿到可用的成员列表。
   */
  async searchUsers(text = '', count = 100): Promise<{ users: RcUser[]; total: number; via: string }> {
    const errors: string[] = [];
    try {
      const { result, total } = await this.directory('users', text, count);
      if (result.length > 0) return { users: result as RcUser[], total, via: 'directory' };
      errors.push('directory 返回空');
    } catch (err) {
      errors.push(`directory: ${err instanceof Error ? err.message : err}`);
    }
    try {
      const { users, total } = await this.listUsers(count);
      const filtered = text
        ? users.filter(
            (u) =>
              u.username?.toLowerCase().includes(text.toLowerCase()) ||
              (u.name ?? '').toLowerCase().includes(text.toLowerCase()),
          )
        : users;
      if (filtered.length > 0) return { users: filtered, total: total || filtered.length, via: 'users.list' };
      errors.push('users.list 返回空');
    } catch (err) {
      errors.push(`users.list: ${err instanceof Error ? err.message : err}`);
    }
    try {
      const { users } = await this.spotlight(text);
      if (users.length > 0) return { users, total: users.length, via: 'spotlight' };
      errors.push('spotlight 返回空');
    } catch (err) {
      errors.push(`spotlight: ${err instanceof Error ? err.message : err}`);
    }
    throw new Error(errors.join('；'));
  }

  // ---- 消息 ----

  async getHistory(rid: string, type: RoomType, count = 50, latest?: string): Promise<RcMessage[]> {
    const endpoint =
      type === 'c' ? 'channels.history' : type === 'p' ? 'groups.history' : 'im.history';
    const res = await this.request<{ messages: RcMessage[] }>('GET', endpoint, undefined, {
      roomId: rid,
      count,
      latest,
    });
    // API 返回新→旧，翻转成旧→新方便渲染
    return (res.messages ?? []).reverse();
  }

  async sendMessage(rid: string, msg: string, tmid?: string): Promise<RcMessage> {
    const res = await this.request<{ message: RcMessage }>('POST', 'chat.sendMessage', {
      message: { rid, msg, ...(tmid ? { tmid } : {}) },
    });
    return res.message;
  }

  /** 发送完整消息对象（可带附件），转发消息时用 */
  async sendMessageRaw(message: {
    rid: string;
    msg?: string;
    attachments?: RcMessageAttachment[];
    tmid?: string;
  }): Promise<RcMessage> {
    const res = await this.request<{ message: RcMessage }>('POST', 'chat.sendMessage', {
      message,
    });
    return res.message;
  }

  /** 机器人/集成用：按频道名或 roomId 发消息（支持附件卡片） */
  postMessage(params: {
    channel?: string;
    roomId?: string;
    text?: string;
    alias?: string;
    avatar?: string;
    attachments?: RcMessageAttachment[];
  }): Promise<unknown> {
    return this.request('POST', 'chat.postMessage', params);
  }

  /** emoji 传 :name: 格式；shouldReact 省略时为切换 */
  react(messageId: string, emoji: string, shouldReact?: boolean): Promise<unknown> {
    return this.request('POST', 'chat.react', { messageId, emoji, shouldReact });
  }

  async updateMessage(rid: string, msgId: string, text: string): Promise<RcMessage> {
    const res = await this.request<{ message: RcMessage }>('POST', 'chat.update', {
      roomId: rid,
      msgId,
      text,
    });
    return res.message;
  }

  deleteMessage(rid: string, msgId: string): Promise<unknown> {
    return this.request('POST', 'chat.delete', { roomId: rid, msgId });
  }

  /** 话题（线程）消息，按时间升序返回 */
  async getThreadMessages(tmid: string, count = 100): Promise<RcMessage[]> {
    const res = await this.request<{ messages: RcMessage[] }>(
      'GET',
      'chat.getThreadMessages',
      undefined,
      { tmid, count },
    );
    const messages = res.messages ?? [];
    messages.sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
    return messages;
  }

  async getMembers(rid: string, type: RoomType, count = 200): Promise<RcUser[]> {
    const endpoint =
      type === 'c' ? 'channels.members' : type === 'p' ? 'groups.members' : 'im.members';
    const res = await this.request<{ members: RcUser[] }>('GET', endpoint, undefined, {
      roomId: rid,
      count,
    });
    return res.members ?? [];
  }

  /** 房间完整信息（含 topic / description / announcement / 拥有者） */
  async getRoomInfo(rid: string): Promise<RcRoom> {
    const res = await this.request<{ room: RcRoom }>('GET', 'rooms.info', undefined, {
      roomId: rid,
    });
    return res.room;
  }

  /**
   * 改房间设置（话题 / 公告 / 描述 / 名称）。
   * rooms.saveRoomSettings 一次只认它认识的字段，没权限时服务端返回 unauthorized，
   * 调用方据此把编辑入口藏起来即可。
   */
  async saveRoomSettings(
    rid: string,
    settings: { topic?: string; announcement?: string; description?: string; roomName?: string },
  ): Promise<void> {
    await this.request('POST', 'rooms.saveRoomSettings', { rid, ...settings });
  }

  /** 退出房间（DM 不支持，用 hideRoom 代替） */
  async leaveRoom(rid: string, type: RoomType): Promise<void> {
    const endpoint = type === 'c' ? 'channels.leave' : 'groups.leave';
    await this.request('POST', endpoint, { roomId: rid });
  }

  /**
   * 上传文件到房间（rooms.media 两段式：上传 → 确认发送）。
   * multipart 体手工构造成字节流——浏览器 fetch 与 Tauri plugin-http
   * 通道都稳定支持（后者对 FormData 支持不可靠）。
   */
  async uploadMedia(
    rid: string,
    file: Blob,
    opts: { msg?: string; tmid?: string; fileName?: string } = {},
  ): Promise<void> {
    const name = opts.fileName ?? (file instanceof File ? file.name : 'file');
    const boundary = `----rcx${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const encoder = new TextEncoder();
    // 文件名用原生 UTF-8（现代 multipart 解析器直接支持），只转义引号和换行
    const safeName = name.replace(/"/g, '%22').replace(/[\r\n]/g, ' ');
    const head = encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
        `Content-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
    );
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const fileBytes = new Uint8Array(await file.arrayBuffer());
    const body = new Uint8Array(head.length + fileBytes.length + tail.length);
    body.set(head, 0);
    body.set(fileBytes, head.length);
    body.set(tail, head.length + fileBytes.length);

    const auth =
      this.authProvider?.() ??
      (this.authToken && this.userId
        ? { authToken: this.authToken, userId: this.userId }
        : null);
    const doFetch = this.fetchImpl ?? fetch;
    const res = await doFetch(`${this.baseUrl}/api/v1/rooms.media/${rid}`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        ...(auth ? { 'X-Auth-Token': auth.authToken, 'X-User-Id': auth.userId } : {}),
      },
      body,
    });
    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
      throw new RcApiError(data?.error ?? `HTTP ${res.status}`, res.status, data?.errorType);
    }
    await this.request('POST', `rooms.mediaConfirm/${rid}/${data.file._id}`, {
      msg: opts.msg ?? '',
      ...(opts.tmid ? { tmid: opts.tmid } : {}),
    });
  }

  /** 带认证拉取站内文件（头像/上传附件），桌面端 <img> 无法带凭据时用 */
  async fetchFile(path: string): Promise<Blob> {
    const auth =
      this.authProvider?.() ??
      (this.authToken && this.userId
        ? { authToken: this.authToken, userId: this.userId }
        : null);
    const doFetch = this.fetchImpl ?? fetch;
    const res = await doFetch(`${this.baseUrl}${path}`, {
      headers: auth ? { 'X-Auth-Token': auth.authToken, 'X-User-Id': auth.userId } : {},
    });
    if (!res.ok) throw new RcApiError(`HTTP ${res.status}`, res.status);
    return await res.blob();
  }

  /** 从某条消息创建讨论（Rocket.Chat Discussion，父房间的子会话） */
  async createDiscussion(prid: string, name: string, pmid?: string): Promise<RcRoom> {
    const res = await this.request<{ discussion: RcRoom }>('POST', 'rooms.createDiscussion', {
      prid,
      t_name: name,
      ...(pmid ? { pmid } : {}),
    });
    return res.discussion;
  }

  // ---- 会话管理 ----

  /** 置顶会话（Rocket.Chat 的 favorite） */
  favoriteRoom(roomId: string, favorite: boolean): Promise<unknown> {
    return this.request('POST', 'rooms.favorite', { roomId, favorite });
  }

  /** 免打扰开关 */
  muteRoom(roomId: string, mute: boolean): Promise<unknown> {
    return this.request('POST', 'rooms.saveNotification', {
      roomId,
      notifications: { disableNotifications: mute ? '1' : '0' },
    });
  }

  /** 从会话列表隐藏（不退出房间，有新消息会重新出现） */
  hideRoom(roomId: string, type: RoomType): Promise<unknown> {
    const endpoint = type === 'c' ? 'channels.close' : type === 'p' ? 'groups.close' : 'im.close';
    return this.request('POST', endpoint, { roomId });
  }

  // ---- 标记（星标） ----

  starMessage(messageId: string): Promise<unknown> {
    return this.request('POST', 'chat.starMessage', { messageId });
  }

  unstarMessage(messageId: string): Promise<unknown> {
    return this.request('POST', 'chat.unStarMessage', { messageId });
  }

  async getStarredMessages(rid: string, count = 50): Promise<RcMessage[]> {
    const res = await this.request<{ messages: RcMessage[] }>(
      'GET',
      'chat.getStarredMessages',
      undefined,
      { roomId: rid, count },
    );
    return res.messages ?? [];
  }

  // ---- Pin ----

  pinMessage(messageId: string): Promise<unknown> {
    return this.request('POST', 'chat.pinMessage', { messageId });
  }

  unpinMessage(messageId: string): Promise<unknown> {
    return this.request('POST', 'chat.unPinMessage', { messageId });
  }

  async getPinnedMessages(rid: string, count = 50): Promise<RcMessage[]> {
    const res = await this.request<{ messages: RcMessage[] }>(
      'GET',
      'chat.getPinnedMessages',
      undefined,
      { roomId: rid, count },
    );
    return res.messages ?? [];
  }

  // ---- 搜索 ----

  spotlight(query: string): Promise<{ users: RcUser[]; rooms: RcRoom[] }> {
    return this.request('GET', 'spotlight', undefined, { query });
  }

  /** 搜索某个会话内的消息 */
  async searchMessages(rid: string, searchText: string, count = 30): Promise<RcMessage[]> {
    const res = await this.request<{ messages: RcMessage[] }>('GET', 'chat.search', undefined, {
      roomId: rid,
      searchText,
      count,
    });
    return res.messages ?? [];
  }

  /** 加入公开频道（搜索结果里点开未加入的频道时用） */
  joinChannel(rid: string): Promise<unknown> {
    return this.request('POST', 'channels.join', { roomId: rid });
  }

  /** 邀请成员进群 */
  inviteToRoom(rid: string, type: RoomType, userId: string): Promise<unknown> {
    const endpoint = type === 'c' ? 'channels.invite' : 'groups.invite';
    return this.request('POST', endpoint, { roomId: rid, userId });
  }

  /** 消息的已读回执（需要服务端开启 Message_Read_Receipt_Enabled） */
  async getReadReceipts(
    messageId: string,
  ): Promise<{ user: RcUser; ts: RcDate }[]> {
    const res = await this.request<{ receipts: { user: RcUser; ts: RcDate }[] }>(
      'GET',
      'chat.getMessageReadReceipts',
      undefined,
      { messageId },
    );
    return res.receipts ?? [];
  }
}
