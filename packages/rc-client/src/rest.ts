import { tsMs } from './types';
import type {
  RcDate,
  RcLoginData,
  RcPreferences,
  RcRoomFile,
  RcRoomRole,
  RcSlashCommand,
  RcTeam,
  RcMessage,
  RcMessageAttachment,
  RcRoom,
  RcSubscription,
  RcUser,
  RoomType,
} from './types';

/**
 * SHA-256 十六进制。改密码时服务端要的是哈希，不是明文。
 *
 * `crypto.subtle` 只在安全上下文里存在（https 或 localhost）。部署到
 * `http://内网IP` 时它是 undefined —— 不拦的话用户点「修改密码」会看到一句
 * 「Cannot read properties of undefined (reading 'digest')」。
 */
async function sha256Hex(text: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new RcApiError(
      '当前不是安全上下文，无法加密密码。请通过 https 访问，或改用桌面客户端。',
      400,
    );
  }
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 含中日韩字符、且用户没手动包 /.../ 的查询，自动包成正则，绕开服务端未开
 * Message_AlwaysSearchRegExp 时中文子串搜不到的问题。纯 ASCII 查询保持原样，
 * 不改变英文搜索行为。
 */
function wrapCjkAsRegex(text: string): string {
  const t = text.trim();
  if (!t) return text;
  const hasCjk = /[一-鿿぀-ヿ가-힯]/.test(t);
  const alreadyRegex = /^\/.*\/$/.test(t);
  if (!hasCjk || alreadyRegex) return text;
  return `/${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`;
}

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
  /**
   * 收到 401（未认证）时的回调。token 被吊销 / 过期后，界面本会停在已登录态、
   * 所有操作静默 401，用户以为是网络问题反复重试。上层据此登出回登录页。
   */
  onAuthError?: () => void;
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
  private onAuthError?: () => void;

  constructor(options: RcRestOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.authProvider = options.authProvider;
    this.fetchImpl = options.fetchImpl;
    this.onAuthError = options.onAuthError;
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
      // 已带 token 的请求收到 401 = token 失效（排除 login 本身：密码错也是 401）。
      // 通知上层登出，避免「能收消息但一操作就静默 401」的僵尸态。
      if (res.status === 401 && auth && path !== 'login') {
        this.onAuthError?.();
      }
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

  /**
   * `/me` 的偏好：Rocket.Chat 会把**服务端默认值**一并填满（38 个键），
   * 分不清哪些是用户真改过的。想让客户端有自己的默认值，用 getExplicitPreferences。
   */
  async getPreferences(): Promise<RcPreferences> {
    const res = await this.request<{ settings?: { preferences?: RcPreferences } }>('GET', 'me');
    return res.settings?.preferences ?? {};
  }

  /**
   * 只返回用户**显式保存过**的偏好。
   *
   * users.info 里的 settings.preferences 只有用户自己设过的键，
   * 没设过的不会出现 —— 客户端的默认值才能生效。
   */
  async getExplicitPreferences(): Promise<RcPreferences> {
    const userId = this.currentUserId();
    if (!userId) return {};
    const res = await this.request<{
      user?: { settings?: { preferences?: RcPreferences } };
    }>('GET', 'users.info', undefined, { userId });
    return res.user?.settings?.preferences ?? {};
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

  /**
   * 全量用户在线状态快照（官方客户端启动时也拉它）。
   * 不拉的话，只有状态**变化**的人才会被实时流点亮——刚打开软件时会话列表一个状态点都没有。
   */
  async getPresences(): Promise<{ username: string; status?: string }[]> {
    const res = await this.request<{ users: { username: string; status?: string }[] }>(
      'GET',
      'users.presence',
    );
    return res.users ?? [];
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

  /**
   * 开启直聊。传多个用户名即为多人直聊（飞书那种「选完人就能聊、不用起群名」的群聊）。
   *
   * 单人用 `username`、多人用 `usernames`（逗号分隔）—— 服务端认的是两个不同的字段，
   * 多人时传 `username` 会被当成一个不存在的用户名而失败。
   */
  async createDirectMessage(usernames: string | string[]): Promise<RcRoom> {
    const list = Array.isArray(usernames) ? usernames : [usernames];
    const body =
      list.length > 1 ? { usernames: list.join(',') } : { username: list[0] };
    const res = await this.request<{ room: RcRoom }>('POST', 'im.create', body);
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
  async listUsers(count = 100, offset = 0): Promise<{ users: RcUser[]; total: number }> {
    const res = await this.request<{ users: RcUser[]; total: number }>(
      'GET',
      'users.list',
      undefined,
      { count, offset },
    );
    return { users: res.users ?? [], total: res.total ?? 0 };
  }

  /**
   * 成员目录：directory → users.list → spotlight 三级回退。
   * 不同服务器/权限配置下总能拿到可用的成员列表。
   */
  async searchUsers(
    text = '',
    count = 100,
    offset = 0,
  ): Promise<{ users: RcUser[]; total: number; via: string }> {
    const errors: string[] = [];
    try {
      const { result, total } = await this.directory('users', text, count, offset);
      if (result.length > 0) return { users: result as RcUser[], total, via: 'directory' };
      errors.push('directory 返回空');
    } catch (err) {
      errors.push(`directory: ${err instanceof Error ? err.message : err}`);
    }
    try {
      const { users, total } = await this.listUsers(count, offset);
      const filtered = text
        ? users.filter(
            (u) =>
              u.username?.toLowerCase().includes(text.toLowerCase()) ||
              (u.name ?? '').toLowerCase().includes(text.toLowerCase()),
          )
        : users;
      if (filtered.length > 0) return { users: filtered, total: total || filtered.length, via: 'users.list' };
      if (offset > 0) return { users: [], total, via: 'users.list' };
      errors.push('users.list 返回空');
    } catch (err) {
      errors.push(`users.list: ${err instanceof Error ? err.message : err}`);
    }
    // spotlight 没有 offset，翻页时不能回退，否则会不断重复首屏。
    if (offset > 0) return { users: [], total: 0, via: 'spotlight' };
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

  // ---- 斜杠命令 ----

  /**
   * 服务器提供的斜杠命令列表（/me、/invite、/kick、/mute、/topic、/archive…）。
   * 命令由服务端执行，客户端只负责识别并转发 —— 直接把 "/kick @张三" 当文本发出去
   * 的话，它只会变成一条字面量消息。
   */
  async listCommands(): Promise<RcSlashCommand[]> {
    const res = await this.request<{ commands: RcSlashCommand[] }>(
      'GET',
      'commands.list',
      undefined,
      { count: 100 },
    );
    return res.commands ?? [];
  }

  /** 执行斜杠命令。command 不含前导斜杠，params 是命令后面的全部内容 */
  async runCommand(command: string, rid: string, params = '', tmid?: string): Promise<void> {
    await this.request('POST', 'commands.run', {
      command,
      roomId: rid,
      params,
      ...(tmid ? { tmid } : {}),
    });
  }

  /**
   * 发送完整消息对象（可带附件），转发消息时用。
   *
   * `_id` 可由客户端生成（RC 官方客户端就是这么做的，实测 8.6.1 接受且同 id
   * 重发不会落库第二条）——乐观消息、WS 回声、REST 响应三者同 id 才能天然合并，
   * 否则回声先到时同一条消息会显示两遍，超时重试还会真的发出第二条。
   */
  async sendMessageRaw(message: {
    _id?: string;
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
    const pageSize = Math.max(1, count);
    const members = new Map<string, RcUser>();
    let offset = 0;
    while (true) {
      const res = await this.request<{ members: RcUser[]; total?: number }>(
        'GET',
        endpoint,
        undefined,
        { roomId: rid, count: pageSize, offset },
      );
      const page = res.members ?? [];
      for (const member of page) members.set(member._id, member);
      if (page.length === 0) break;
      offset += page.length;
      if (res.total !== undefined ? offset >= res.total : page.length < pageSize) break;
    }
    return [...members.values()];
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
   *
   * 字段名必须是 `roomXxx` 前缀形式——服务端的 schema 是严格模式，
   * 传 `announcement` 会直接 400「must NOT have additional properties」。
   * 没权限时返回 unauthorized，调用方据此回退 UI。
   */
  async saveRoomSettings(
    rid: string,
    settings: { topic?: string; announcement?: string; description?: string; name?: string },
  ): Promise<void> {
    const body: Record<string, string> = { rid };
    if (settings.topic !== undefined) body.roomTopic = settings.topic;
    if (settings.announcement !== undefined) body.roomAnnouncement = settings.announcement;
    if (settings.description !== undefined) body.roomDescription = settings.description;
    if (settings.name !== undefined) body.roomName = settings.name;
    await this.request('POST', 'rooms.saveRoomSettings', body);
  }

  /** 退出房间（DM 不支持，用 hideRoom 代替） */
  async leaveRoom(rid: string, type: RoomType): Promise<void> {
    const endpoint = type === 'c' ? 'channels.leave' : 'groups.leave';
    await this.request('POST', endpoint, { roomId: rid });
  }

  /**
   * 彻底删除房间（连同历史消息），需要管理员或房主权限。
   * 与 hideRoom 完全不同：hide 只是从自己的会话列表里隐掉，房间还在服务器上。
   */
  async deleteRoom(rid: string, type: RoomType): Promise<void> {
    const endpoint = type === 'c' ? 'channels.delete' : 'groups.delete';
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

  // ---- 群管理 ----

  /**
   * 房间成员的角色（owner / moderator / leader）。
   * 只返回「有角色的人」，普通成员不在列表里。
   */
  async getRoomRoles(rid: string, type: RoomType): Promise<RcRoomRole[]> {
    const endpoint = type === 'c' ? 'channels.roles' : 'groups.roles';
    const res = await this.request<{ roles: RcRoomRole[] }>('GET', endpoint, undefined, {
      roomId: rid,
    });
    return res.roles ?? [];
  }

  /** 把人移出房间 */
  kickFromRoom(rid: string, type: RoomType, userId: string): Promise<unknown> {
    const endpoint = type === 'c' ? 'channels.kick' : 'groups.kick';
    return this.request('POST', endpoint, { roomId: rid, userId });
  }

  /** 授予/收回房间角色。role 为 owner / moderator / leader */
  setRoomRole(
    rid: string,
    type: RoomType,
    userId: string,
    role: 'owner' | 'moderator' | 'leader',
    grant: boolean,
  ): Promise<unknown> {
    const verb = grant ? 'add' : 'remove';
    const suffix = role === 'owner' ? 'Owner' : role === 'moderator' ? 'Moderator' : 'Leader';
    const endpoint = `${type === 'c' ? 'channels' : 'groups'}.${verb}${suffix}`;
    return this.request('POST', endpoint, { roomId: rid, userId });
  }

  /**
   * 禁言 / 解除禁言。
   *
   * **只能走斜杠命令**：RC 8.6.1 的 `channels.muteUser` 和 `groups.muteUser` 都返回 404
   * ——这两个 REST 端点根本不存在（实测过）。服务端只在 `/mute` 命令里实现了这个能力。
   */
  muteUser(rid: string, username: string, mute: boolean): Promise<unknown> {
    return this.runCommand(mute ? 'mute' : 'unmute', rid, `@${username}`);
  }

  /** 归档 / 取消归档 */
  archiveRoom(rid: string, type: RoomType, archive: boolean): Promise<unknown> {
    const endpoint = `${type === 'c' ? 'channels' : 'groups'}.${archive ? 'archive' : 'unarchive'}`;
    return this.request('POST', endpoint, { roomId: rid });
  }

  /** 设为只读（只有房主/管理员能发言）/ 取消只读 */
  setReadOnly(rid: string, type: RoomType, readOnly: boolean): Promise<unknown> {
    const endpoint = `${type === 'c' ? 'channels' : 'groups'}.setReadOnly`;
    return this.request('POST', endpoint, { roomId: rid, readOnly });
  }

  // ---- 面板数据 ----

  /** 房间里传过的文件（「文件」面板） */
  async getRoomFiles(rid: string, type: RoomType, count = 50): Promise<RcRoomFile[]> {
    const endpoint =
      type === 'c' ? 'channels.files' : type === 'p' ? 'groups.files' : 'im.files';
    const res = await this.request<{ files: RcRoomFile[] }>('GET', endpoint, undefined, {
      roomId: rid,
      count,
      sort: JSON.stringify({ uploadedAt: -1 }),
    });
    return res.files ?? [];
  }

  /** 本房间里 @ 到我的消息（「提及我的」面板） */
  async getMentionedMessages(rid: string, count = 50): Promise<RcMessage[]> {
    const res = await this.request<{ messages: RcMessage[] }>(
      'GET',
      'chat.getMentionedMessages',
      undefined,
      { roomId: rid, count },
    );
    return res.messages ?? [];
  }

  // ---- 个人资料 ----

  /**
   * 改昵称 / 邮箱 / 密码。
   * 改密码时服务端要求同时提供 currentPassword（除非管理员改别人的）。
   */
  async updateOwnBasicInfo(data: {
    name?: string;
    email?: string;
    username?: string;
    newPassword?: string;
    currentPassword?: string;
  }): Promise<RcUser> {
    const { currentPassword, ...rest } = data;
    const res = await this.request<{ user: RcUser }>('POST', 'users.updateOwnBasicInfo', {
      data: {
        ...rest,
        // 服务端要的是 SHA-256 十六进制，不是明文
        ...(currentPassword ? { currentPassword: await sha256Hex(currentPassword) } : {}),
      },
    });
    return res.user;
  }

  /** 上传头像。RC 的 users.setAvatar 用 multipart，字段名固定是 image */
  async setAvatar(file: Blob, fileName = 'avatar.png'): Promise<void> {
    await this.postMultipart('users.setAvatar', 'image', file, fileName);
  }

  /**
   * 移除头像，回到 RC 生成的默认首字母图。
   * userId 必须显式给 —— 传空对象服务端会拒（"required userId or username param was not provided"），
   * 它不会默认成「当前用户」。
   */
  async resetAvatar(userId?: string): Promise<void> {
    const target = userId ?? this.currentUserId();
    if (!target) throw new RcApiError('未登录', 401);
    await this.request('POST', 'users.resetAvatar', { userId: target });
  }

  /** 查某个用户的资料（按用户名或 id） */
  async getUserInfo(usernameOrId: string): Promise<RcUser> {
    const key = /^[a-zA-Z0-9]{17}$/.test(usernameOrId) ? 'userId' : 'username';
    const res = await this.request<{ user: RcUser }>('GET', 'users.info', undefined, {
      [key]: usernameOrId,
    });
    return res.user;
  }

  /**
   * 手工构造 multipart 体发到某个端点。
   * 不用 FormData：Tauri 的 plugin-http 通道对它支持不可靠（uploadMedia 也是同样的理由）。
   */
  private async postMultipart(
    path: string,
    fieldName: string,
    file: Blob,
    fileName: string,
  ): Promise<any> {
    const boundary = `----rcx${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const encoder = new TextEncoder();
    const safeName = fileName.replace(/"/g, '%22').replace(/[\r\n]/g, ' ');
    const head = encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${safeName}"\r\n` +
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
    const res = await doFetch(`${this.baseUrl}/api/v1/${path}`, {
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
    return data;
  }

  /** 带认证拉取站内文件（头像/上传附件），桌面端 <img> 无法带凭据时用 */
  async fetchFile(path: string): Promise<Blob> {
    const auth =
      this.authProvider?.() ??
      (this.authToken && this.userId
        ? { authToken: this.authToken, userId: this.userId }
        : null);
    const doFetch = this.fetchImpl ?? fetch;
    const absolute = /^https?:\/\//i.test(path);
    const base = this.baseUrl.replace(/\/+$/, '');
    const url = absolute ? path : `${base}${path}`;
    const ownServer = !absolute || (!!base && (url === base || url.startsWith(`${base}/`)));
    const authHeaders: Record<string, string> =
      auth && ownServer
        ? { 'X-Auth-Token': auth.authToken, 'X-User-Id': auth.userId }
        : {};

    // 同源 Web 部署用 rc_uid/rc_token cookie 即可。不要再附自定义认证头：浏览器
    // 跟随到 CDN 时 cookie 会按域自动隔离，而自定义 X-* 头可能被原样转发。
    const cookieAuth =
      ownServer &&
      typeof location !== 'undefined' &&
      new URL(url, location.href).origin === location.origin;

    let res: Response;
    if (!auth || !ownServer || cookieAuth) {
      res = await doFetch(url, cookieAuth ? { credentials: 'include' } : {});
    } else {
      // 桌面端/跨源直连必须显式带 RC 头。手动跟随重定向，并且只在仍属于
      // Rocket.Chat 本源时保留凭据；跳到 S3/CDN 后立即去掉，避免 token 泄露。
      let current = url;
      let headers: Record<string, string> = authHeaders;
      const serverOrigin = base ? new URL(base).origin : '';
      for (let redirects = 0; ; redirects += 1) {
        // Tauri plugin-http 不识别标准 redirect:'manual'，但会读取
        // maxRedirections:0；原生 fetch 则忽略这个扩展字段、按 manual 返回 3xx。
        // 两者都必须在客户端逐跳处理，才能在跨源时剥离 Rocket.Chat 凭据。
        res = await doFetch(current, {
          headers,
          redirect: 'manual',
          maxRedirections: 0,
        } as RequestInit & { maxRedirections: number });
        if (![301, 302, 303, 307, 308].includes(res.status)) break;
        if (redirects >= 5) throw new RcApiError('文件下载重定向次数过多', 508);
        const locationHeader = res.headers.get('location');
        if (!locationHeader) {
          throw new RcApiError('文件下载发生无法安全跟随的重定向', res.status || 502);
        }
        current = new URL(locationHeader, current).href;
        headers = serverOrigin && new URL(current).origin === serverOrigin ? authHeaders : {};
      }
    }
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
      // 中文子串：服务端 Message_AlwaysSearchRegExp=false 时 Mongo 文本索引不切分中文，
      // 直接搜「工作项」搜不到；手动包成 /工作项/ 走正则才命中。用户已经手包 /.../ 的不动。
      searchText: wrapCjkAsRegex(searchText),
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
