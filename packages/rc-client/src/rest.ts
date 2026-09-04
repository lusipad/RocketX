import type {
  RcDate,
  RcLoginData,
  RcPreferences,
  RcRoomFile,
  RcRoomRole,
  RcSlashCommand,
  RcUiKitServerInteraction,
  RcUiKitUserInteraction,
  RcTeam,
  RcMessage,
  RcMessageAttachment,
  RcRoom,
  RcSubscription,
  RcUser,
  RoomType,
} from './types';
import {
  createRocketChatCapabilities,
  type RocketChatCapabilities,
} from './capabilities';
import {
  createRocketChatDomainFacades,
  type RocketChatDomainFacades,
} from './domains';
import {
  currentAuth,
  request as requestEndpoint,
  RcApiError,
  type RcRestOptions,
  type RcRestEndpointContext,
  type RcRestRequestContext,
} from './request';
import {
  login as loginEndpoint,
  loginWithToken as loginWithTokenEndpoint,
  logout as logoutEndpoint,
  me as meEndpoint,
} from './auth';
import {
  getExplicitPreferences as getExplicitPreferencesEndpoint,
  getPreferences as getPreferencesEndpoint,
  setPreferences as setPreferencesEndpoint,
} from './preferences';
import {
  getPresences as getPresencesEndpoint,
  getUserInfo as getUserInfoEndpoint,
  getUserInfoById as getUserInfoByIdEndpoint,
  listUsers as listUsersEndpoint,
  resetAvatar as resetAvatarEndpoint,
  searchUsers as searchUsersEndpoint,
  setAvatar as setAvatarEndpoint,
  setStatus as setStatusEndpoint,
  updateOwnBasicInfo as updateOwnBasicInfoEndpoint,
} from './users';
import {
  deleteMessage as deleteMessageEndpoint,
  followMessage as followMessageEndpoint,
  getHistory as getHistoryEndpoint,
  getMessage as getMessageEndpoint,
  getPinnedMessages as getPinnedMessagesEndpoint,
  getReadReceipts as getReadReceiptsEndpoint,
  getStarredMessages as getStarredMessagesEndpoint,
  getThreadMessages as getThreadMessagesEndpoint,
  listCommands as listCommandsEndpoint,
  pinMessage as pinMessageEndpoint,
  postMessage as postMessageEndpoint,
  react as reactEndpoint,
  runCommand as runCommandEndpoint,
  sendUiKitInteraction as sendUiKitInteractionEndpoint,
  sendMessage as sendMessageEndpoint,
  sendMessageRaw as sendMessageRawEndpoint,
  starMessage as starMessageEndpoint,
  unfollowMessage as unfollowMessageEndpoint,
  unpinMessage as unpinMessageEndpoint,
  unstarMessage as unstarMessageEndpoint,
  updateMessage as updateMessageEndpoint,
} from './messages';
import {
  fetchFile as fetchFileEndpoint,
  fetchFileResponse as fetchFileResponseEndpoint,
  getRoomFiles as getRoomFilesEndpoint,
  uploadMedia as uploadMediaEndpoint,
} from './files';
import {
  directory as directoryEndpoint,
  getMentionedMessages as getMentionedMessagesEndpoint,
  getMentionedMessagesPage as getMentionedMessagesPageEndpoint,
  searchMessages as searchMessagesEndpoint,
  spotlight as spotlightEndpoint,
} from './search';
import {
  archiveRoom as archiveRoomEndpoint,
  createDiscussion as createDiscussionEndpoint,
  createDirectMessage as createDirectMessageEndpoint,
  createGroup as createGroupEndpoint,
  createTeam as createTeamEndpoint,
  deleteRoom as deleteRoomEndpoint,
  favoriteRoom as favoriteRoomEndpoint,
  getMembers as getMembersEndpoint,
  getRoomInfo as getRoomInfoEndpoint,
  getRoomRoles as getRoomRolesEndpoint,
  getRooms as getRoomsEndpoint,
  getSubscriptions as getSubscriptionsEndpoint,
  hideRoom as hideRoomEndpoint,
  inviteToRoom as inviteToRoomEndpoint,
  joinChannel as joinChannelEndpoint,
  joinRoom as joinRoomEndpoint,
  kickFromRoom as kickFromRoomEndpoint,
  leaveRoom as leaveRoomEndpoint,
  listTeamRooms as listTeamRoomsEndpoint,
  listTeams as listTeamsEndpoint,
  markRead as markReadEndpoint,
  muteRoom as muteRoomEndpoint,
  muteUser as muteUserEndpoint,
  openDirectMessage as openDirectMessageEndpoint,
  openRoom as openRoomEndpoint,
  saveRoomSettings as saveRoomSettingsEndpoint,
  setReadOnly as setReadOnlyEndpoint,
  setRoomRole as setRoomRoleEndpoint,
} from './rooms';
import {
  createCustomEmoji as createCustomEmojiEndpoint,
  getCustomEmojiByName as getCustomEmojiByNameEndpoint,
  type RcCustomEmoji,
} from './emoji';

export type { RcCustomEmoji } from './emoji';

export { RcApiError, type RcRestOptions } from './request';

/**
 * Rocket.Chat REST API 客户端（api/v1）。
 * 只依赖 fetch，浏览器 / Node 18+ 通用。
 */
export class RcRestClient {
  baseUrl: string;
  authToken: string | null = null;
  userId: string | null = null;
  domains: RocketChatDomainFacades;
  private authProvider?: RcRestOptions['authProvider'];
  private fetchImpl?: typeof fetch;
  private onAuthError?: () => void;
  private _capabilities: RocketChatCapabilities;

  constructor(options: RcRestOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.authProvider = options.authProvider;
    this.fetchImpl = options.fetchImpl;
    this.onAuthError = options.onAuthError;
    this._capabilities = createRocketChatCapabilities();
    this.domains = createRocketChatDomainFacades(this);
  }

  get capabilities(): RocketChatCapabilities {
    return this._capabilities;
  }

  /**
   * 轻量能力协商只访问公开 info，不改变认证状态。
   * 服务器不支持该端点时保留默认合同，调用方仍可继续使用兼容路径。
   */
  async negotiateCapabilities(): Promise<RocketChatCapabilities> {
    try {
      const doFetch = this.fetchImpl ?? fetch;
      const response = await doFetch(`${this.baseUrl}/api/info`, { method: 'GET' });
      type RocketChatInfo = {
        version?: unknown;
        apiVersion?: unknown;
        error?: unknown;
        message?: unknown;
      };
      let data: RocketChatInfo | null = null;
      try {
        data = (await response.json()) as RocketChatInfo;
      } catch {
        // 能力协商失败时保留默认合同。
      }
      if (!response.ok) {
        const message = typeof data?.error === 'string'
          ? data.error
          : typeof data?.message === 'string'
            ? data.message
            : `HTTP ${response.status}`;
        throw new RcApiError(
          message,
          response.status,
        );
      }
      this.setCapabilities({
        source: 'server',
        serverVersion: typeof data?.version === 'string' ? data.version : undefined,
        apiVersion: typeof data?.apiVersion === 'string' ? data.apiVersion : undefined,
      });
    } catch {
      // 能力协商是增强路径，网络/旧服务端失败不能阻断登录。
    }
    return this._capabilities;
  }

  /** 更新服务端能力快照；网络请求和错误合同仍由原 client 负责。 */
  setCapabilities(input: Partial<RocketChatCapabilities>): void {
    this._capabilities = createRocketChatCapabilities({
      ...this._capabilities,
      ...input,
      endpoint: { ...this._capabilities.endpoint, ...(input.endpoint ?? {}) },
      authentication: { ...this._capabilities.authentication, ...(input.authentication ?? {}) },
      fileTransfer: { ...this._capabilities.fileTransfer, ...(input.fileTransfer ?? {}) },
      realtime: { ...this._capabilities.realtime, ...(input.realtime ?? {}) },
      settings: { ...this._capabilities.settings, ...(input.settings ?? {}) },
      features: { ...this._capabilities.features, ...(input.features ?? {}) },
      updatedAt: Date.now(),
    });
    this.domains = createRocketChatDomainFacades(this);
  }

  setAuth(authToken: string | null, userId: string | null): void {
    this.authToken = authToken;
    this.userId = userId;
  }

  private requestContext(): RcRestRequestContext {
    return {
      baseUrl: this.baseUrl,
      authToken: this.authToken,
      userId: this.userId,
      capabilities: this._capabilities,
      authProvider: this.authProvider,
      fetchImpl: this.fetchImpl,
      onAuthError: this.onAuthError,
    };
  }

  private endpointContext(): RcRestEndpointContext {
    return {
      ...this.requestContext(),
      request: (method, path, body, query) => this.request(method, path, body, query),
      setAuth: (authToken, userId) => this.setAuth(authToken, userId),
      currentUserId: () => this.currentUserId(),
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    return requestEndpoint(this.requestContext(), method, path, body, query);
  }

  // ---- 认证 ----

  async login(user: string, password: string): Promise<RcLoginData> {
    return loginEndpoint(this.endpointContext(), user, password);
  }

  /** 用已有 token 恢复会话（本地存储的 token 重新登录） */
  async loginWithToken(token: string): Promise<RcLoginData> {
    return loginWithTokenEndpoint(this.endpointContext(), token);
  }

  async logout(): Promise<void> {
    return logoutEndpoint(this.endpointContext());
  }

  me(): Promise<RcUser> {
    return meEndpoint(this.endpointContext());
  }

  // ---- 用户偏好（服务端持久化，跨设备同步）----

  /**
   * `/me` 的偏好：Rocket.Chat 会把**服务端默认值**一并填满（38 个键），
   * 分不清哪些是用户真改过的。想让客户端有自己的默认值，用 getExplicitPreferences。
   */
  async getPreferences(): Promise<RcPreferences> {
    return getPreferencesEndpoint(this.endpointContext());
  }

  /**
   * 只返回用户**显式保存过**的偏好。
   *
   * 主路径是 `users.getPreferences`：它返回 settings.preferences 原文（只含显式键），
   * 且从很老的 RC 版本就存在。不能用 `users.info` 当主路径——RC 8.x 起 users.info
   * 的字段表里根本没有 settings（getFullUserData 不投影它），恒读不到偏好；
   * 仅在 getPreferences 不可用时（更老的版本/代理裁剪）回退 users.info。
   */
  async getExplicitPreferences(): Promise<RcPreferences> {
    return getExplicitPreferencesEndpoint(this.endpointContext());
  }

  /** 当前登录用户 id（authProvider 模式下 this.userId 为空，需实时取） */
  private currentUserId(): string | null {
    return currentAuth(this.requestContext())?.userId ?? this.userId;
  }

  /**
   * REST 写偏好。注意：RC 8.x 的 users.setPreferences 是 schema 校验端点
   * （additionalProperties:false），RocketX 自定义键（rcxAliases/rcxNameFormat）
   * 会被 invalid-params 整体拒绝——含自定义键的写入请用 apps/web 侧的
   * savePreferences（DDP saveUserPreferences 优先，本方法只是它的回退路径）。
   */
  async setPreferences(data: Partial<RcPreferences>): Promise<void> {
    return setPreferencesEndpoint(this.endpointContext(), data);
  }

  /**
   * 全量用户在线状态快照（官方客户端启动时也拉它）。
   * 不拉的话，只有状态**变化**的人才会被实时流点亮——刚打开软件时会话列表一个状态点都没有。
   */
  async getPresences(): Promise<{ username: string; status?: string }[]> {
    return getPresencesEndpoint(this.endpointContext());
  }

  /** 设置在线状态（online / away / busy / offline） */
  setStatus(status: string, message?: string): Promise<unknown> {
    return setStatusEndpoint(this.endpointContext(), status, message);
  }

  // ---- Teams ----

  async listTeams(count = 50): Promise<RcTeam[]> {
    return listTeamsEndpoint(this.endpointContext(), count);
  }

  /** 创建 Team（type: 0 公开 / 1 私有） */
  async createTeam(name: string, members: string[], priv = true): Promise<RcTeam> {
    return createTeamEndpoint(this.endpointContext(), name, members, priv);
  }

  /** Team 下的频道列表 */
  async listTeamRooms(teamId: string, count = 50): Promise<RcRoom[]> {
    return listTeamRoomsEndpoint(this.endpointContext(), teamId, count);
  }

  // ---- 会话 / 房间 ----

  async getSubscriptions(): Promise<RcSubscription[]> {
    return getSubscriptionsEndpoint(this.endpointContext());
  }

  async getRooms(): Promise<RcRoom[]> {
    return getRoomsEndpoint(this.endpointContext());
  }

  markRead(rid: string): Promise<unknown> {
    return markReadEndpoint(this.endpointContext(), rid);
  }

  /**
   * 开启直聊。传多个用户名即为多人直聊（飞书那种「选完人就能聊、不用起群名」的群聊）。
   *
   * 单人用 `username`、多人用 `usernames`（逗号分隔）—— 服务端认的是两个不同的字段，
   * 多人时传 `username` 会被当成一个不存在的用户名而失败。
   */
  async createDirectMessage(usernames: string | string[]): Promise<RcRoom> {
    return createDirectMessageEndpoint(this.endpointContext(), usernames);
  }

  /** 打开 DM 会话（创建后订阅可能是关闭状态，需要显式 open 才会出现在会话列表） */
  openDirectMessage(roomId: string): Promise<unknown> {
    return openDirectMessageEndpoint(this.endpointContext(), roomId);
  }

  /** 创建群组：priv=true 走 groups.create（私有），否则 channels.create（公开频道） */
  async createGroup(name: string, members: string[], priv = true): Promise<RcRoom> {
    return createGroupEndpoint(this.endpointContext(), name, members, priv);
  }

  /** 目录检索：全部成员 / 公开频道（分页） */
  async directory(
    type: 'users' | 'channels',
    text = '',
    count = 50,
    offset = 0,
  ): Promise<{ result: (RcUser & RcRoom)[]; total: number }> {
    return directoryEndpoint(this.endpointContext(), type, text, count, offset);
  }

  /** 用户列表（需要 view-outside-room 权限，作为 directory 的回退） */
  async listUsers(count = 100, offset = 0): Promise<{ users: RcUser[]; total: number }> {
    return listUsersEndpoint(this.endpointContext(), count, offset);
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
    return searchUsersEndpoint(this.endpointContext(), text, count, offset);
  }

  // ---- 消息 ----

  async getHistory(rid: string, type: RoomType, count = 50, latest?: string): Promise<RcMessage[]> {
    return getHistoryEndpoint(this.endpointContext(), rid, type, count, latest);
  }

  async sendMessage(rid: string, msg: string, tmid?: string): Promise<RcMessage> {
    return sendMessageEndpoint(this.endpointContext(), rid, msg, tmid);
  }

  // ---- 斜杠命令 ----

  /**
   * 服务器提供的斜杠命令列表（/me、/invite、/kick、/mute、/topic、/archive…）。
   * 命令由服务端执行，客户端只负责识别并转发 —— 直接把 "/kick @张三" 当文本发出去
   * 的话，它只会变成一条字面量消息。
   */
  async listCommands(): Promise<RcSlashCommand[]> {
    return listCommandsEndpoint(this.endpointContext());
  }

  /** 执行斜杠命令。command 不含前导斜杠，params 是命令后面的全部内容 */
  async runCommand(
    command: string,
    rid: string,
    params = '',
    tmid?: string,
    triggerId?: string,
  ): Promise<void> {
    return runCommandEndpoint(this.endpointContext(), command, rid, params, tmid, triggerId);
  }

  async sendUiKitInteraction(
    appId: string,
    interaction: RcUiKitUserInteraction,
  ): Promise<RcUiKitServerInteraction> {
    return sendUiKitInteractionEndpoint(this.endpointContext(), appId, interaction);
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
    customFields?: Record<string, unknown>;
  }): Promise<RcMessage> {
    return sendMessageRawEndpoint(this.endpointContext(), message);
  }

  /** 按稳定消息 id 回查；离线回灌重试报错时用它确认服务端是否已经落库。 */
  async getMessage(msgId: string): Promise<RcMessage> {
    return getMessageEndpoint(this.endpointContext(), msgId);
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
    return postMessageEndpoint(this.endpointContext(), params);
  }

  async getCustomEmojiByName(name: string): Promise<RcCustomEmoji | null> {
    return getCustomEmojiByNameEndpoint(this.endpointContext(), name);
  }

  async createCustomEmoji(params: {
    name: string;
    file: Blob;
    fileName: string;
    aliases?: string[];
  }): Promise<void> {
    return createCustomEmojiEndpoint(this.endpointContext(), params);
  }

  /** emoji 传 :name: 格式；shouldReact 省略时为切换 */
  react(messageId: string, emoji: string, shouldReact?: boolean): Promise<unknown> {
    return reactEndpoint(this.endpointContext(), messageId, emoji, shouldReact);
  }

  async updateMessage(rid: string, msgId: string, text: string): Promise<RcMessage> {
    return updateMessageEndpoint(this.endpointContext(), rid, msgId, text);
  }

  async deleteMessage(rid: string, msgId: string): Promise<void> {
    return deleteMessageEndpoint(this.endpointContext(), rid, msgId);
  }

  /** 话题（线程）消息，按时间升序返回 */
  async getThreadMessages(tmid: string, count = 100): Promise<RcMessage[]> {
    return getThreadMessagesEndpoint(this.endpointContext(), tmid, count);
  }

  /** 关注讨论串，后续新回复由 Rocket.Chat 按关注关系提醒。 */
  followMessage(mid: string): Promise<unknown> {
    return followMessageEndpoint(this.endpointContext(), mid);
  }

  /** 取消关注讨论串，停止接收普通新回复提醒。 */
  unfollowMessage(mid: string): Promise<unknown> {
    return unfollowMessageEndpoint(this.endpointContext(), mid);
  }

  async getMembers(rid: string, type: RoomType, count = 200): Promise<RcUser[]> {
    return getMembersEndpoint(this.endpointContext(), rid, type, count);
  }

  /** 房间完整信息（含 topic / description / announcement / 拥有者） */
  async getRoomInfo(rid: string): Promise<RcRoom> {
    return getRoomInfoEndpoint(this.endpointContext(), rid);
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
    return saveRoomSettingsEndpoint(this.endpointContext(), rid, settings);
  }

  /** 退出房间（DM 不支持，用 hideRoom 代替） */
  async leaveRoom(rid: string, type: RoomType): Promise<void> {
    return leaveRoomEndpoint(this.endpointContext(), rid, type);
  }

  /**
   * 彻底删除房间（连同历史消息），需要管理员或房主权限。
   * 与 hideRoom 完全不同：hide 只是从自己的会话列表里隐掉，房间还在服务器上。
   */
  async deleteRoom(rid: string, type: RoomType): Promise<void> {
    return deleteRoomEndpoint(this.endpointContext(), rid, type);
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
    return uploadMediaEndpoint(this.endpointContext(), rid, file, opts);
  }

  // ---- 群管理 ----

  /**
   * 房间成员的角色（owner / moderator / leader）。
   * 只返回「有角色的人」，普通成员不在列表里。
   */
  async getRoomRoles(rid: string, type: RoomType): Promise<RcRoomRole[]> {
    return getRoomRolesEndpoint(this.endpointContext(), rid, type);
  }

  /** 把人移出房间 */
  kickFromRoom(rid: string, type: RoomType, userId: string): Promise<unknown> {
    return kickFromRoomEndpoint(this.endpointContext(), rid, type, userId);
  }

  /** 授予/收回房间角色。role 为 owner / moderator / leader */
  setRoomRole(
    rid: string,
    type: RoomType,
    userId: string,
    role: 'owner' | 'moderator' | 'leader',
    grant: boolean,
  ): Promise<unknown> {
    return setRoomRoleEndpoint(this.endpointContext(), rid, type, userId, role, grant);
  }

  /**
   * 禁言 / 解除禁言。
   *
   * **只能走斜杠命令**：RC 8.6.1 的 `channels.muteUser` 和 `groups.muteUser` 都返回 404
   * ——这两个 REST 端点根本不存在（实测过）。服务端只在 `/mute` 命令里实现了这个能力。
   */
  muteUser(rid: string, username: string, mute: boolean): Promise<unknown> {
    return muteUserEndpoint(this.endpointContext(), rid, username, mute);
  }

  /** 归档 / 取消归档 */
  archiveRoom(rid: string, type: RoomType, archive: boolean): Promise<unknown> {
    return archiveRoomEndpoint(this.endpointContext(), rid, type, archive);
  }

  /** 设为只读（只有房主/管理员能发言）/ 取消只读 */
  setReadOnly(rid: string, type: RoomType, readOnly: boolean): Promise<unknown> {
    return setReadOnlyEndpoint(this.endpointContext(), rid, type, readOnly);
  }

  // ---- 面板数据 ----

  /** 房间里传过的文件（「文件」面板） */
  async getRoomFiles(rid: string, type: RoomType, count = 50): Promise<RcRoomFile[]> {
    return getRoomFilesEndpoint(this.endpointContext(), rid, type, count);
  }

  /** 本房间里 @ 到我的消息（「提及我的」面板）；保留分页元数据给全局收件箱。 */
  async getMentionedMessagesPage(
    rid: string,
    offset = 0,
    count = 50,
  ): Promise<{ messages: RcMessage[]; count: number; offset: number; total: number }> {
    return getMentionedMessagesPageEndpoint(this.endpointContext(), rid, offset, count);
  }

  /** 兼容现有房间面板。 */
  async getMentionedMessages(rid: string, count = 50): Promise<RcMessage[]> {
    return getMentionedMessagesEndpoint(this.endpointContext(), rid, count);
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
    return updateOwnBasicInfoEndpoint(this.endpointContext(), data);
  }

  /** 上传头像。RC 的 users.setAvatar 用 multipart，字段名固定是 image */
  async setAvatar(file: Blob, fileName = 'avatar.png'): Promise<void> {
    return setAvatarEndpoint(this.endpointContext(), file, fileName);
  }

  /**
   * 移除头像，回到 RC 生成的默认首字母图。
   * userId 必须显式给 —— 传空对象服务端会拒（"required userId or username param was not provided"），
   * 它不会默认成「当前用户」。
   */
  async resetAvatar(userId?: string): Promise<void> {
    return resetAvatarEndpoint(this.endpointContext(), userId);
  }

  /** 查某个用户的资料（按用户名或 id） */
  async getUserInfo(usernameOrId: string): Promise<RcUser> {
    return getUserInfoEndpoint(this.endpointContext(), usernameOrId);
  }

  /** 按用户 id 查资料；不依赖 Rocket.Chat 默认的 17 位 id 长度。 */
  async getUserInfoById(userId: string): Promise<RcUser> {
    return getUserInfoByIdEndpoint(this.endpointContext(), userId);
  }

  /** 带认证拉取站内文件，并保留响应流给桌面端直接写盘。 */
  async fetchFileResponse(path: string): Promise<Response> {
    return fetchFileResponseEndpoint(this.endpointContext(), path);
  }

  /** 带认证拉取站内文件（头像/上传附件），桌面端 <img> 无法带凭据时用 */
  async fetchFile(path: string): Promise<Blob> {
    return fetchFileEndpoint(this.endpointContext(), path);
  }

  /** 从某条消息创建讨论（Rocket.Chat Discussion，父房间的子会话） */
  async createDiscussion(prid: string, name: string, pmid?: string): Promise<RcRoom> {
    return createDiscussionEndpoint(this.endpointContext(), prid, name, pmid);
  }

  // ---- 会话管理 ----

  /** 置顶会话（Rocket.Chat 的 favorite） */
  favoriteRoom(roomId: string, favorite: boolean): Promise<unknown> {
    return favoriteRoomEndpoint(this.endpointContext(), roomId, favorite);
  }

  /** 免打扰开关 */
  muteRoom(roomId: string, mute: boolean): Promise<unknown> {
    return muteRoomEndpoint(this.endpointContext(), roomId, mute);
  }

  /** 从会话列表隐藏（不退出房间，有新消息会重新出现） */
  hideRoom(roomId: string, type: RoomType): Promise<unknown> {
    return hideRoomEndpoint(this.endpointContext(), roomId, type);
  }

  /** 恢复已隐藏的会话。 */
  openRoom(roomId: string, type: RoomType): Promise<unknown> {
    return openRoomEndpoint(this.endpointContext(), roomId, type);
  }

  // ---- 标记（星标） ----

  starMessage(messageId: string): Promise<unknown> {
    return starMessageEndpoint(this.endpointContext(), messageId);
  }

  unstarMessage(messageId: string): Promise<unknown> {
    return unstarMessageEndpoint(this.endpointContext(), messageId);
  }

  async getStarredMessages(rid: string, count = 50): Promise<RcMessage[]> {
    return getStarredMessagesEndpoint(this.endpointContext(), rid, count);
  }

  // ---- Pin ----

  pinMessage(messageId: string): Promise<unknown> {
    return pinMessageEndpoint(this.endpointContext(), messageId);
  }

  unpinMessage(messageId: string): Promise<unknown> {
    return unpinMessageEndpoint(this.endpointContext(), messageId);
  }

  async getPinnedMessages(rid: string, count = 50): Promise<RcMessage[]> {
    return getPinnedMessagesEndpoint(this.endpointContext(), rid, count);
  }

  // ---- 搜索 ----

  spotlight(query: string): Promise<{ users: RcUser[]; rooms: RcRoom[] }> {
    return spotlightEndpoint(this.endpointContext(), query);
  }

  /** 搜索某个会话内的消息 */
  async searchMessages(
    rid: string,
    searchText: string,
    count = 30,
    offset = 0,
  ): Promise<RcMessage[]> {
    return searchMessagesEndpoint(this.endpointContext(), rid, searchText, count, offset);
  }

  /** 加入公开频道（搜索结果里点开未加入的频道时用） */
  joinChannel(rid: string): Promise<unknown> {
    return joinChannelEndpoint(this.endpointContext(), rid);
  }

  /** 加入房间；旧版兼容由调用方根据房间语义选择对应路径 */
  joinRoom(rid: string): Promise<unknown> {
    return joinRoomEndpoint(this.endpointContext(), rid);
  }

  /** 邀请成员进群 */
  inviteToRoom(rid: string, type: RoomType, userId: string): Promise<unknown> {
    return inviteToRoomEndpoint(this.endpointContext(), rid, type, userId);
  }

  /** 消息的已读回执（需要服务端开启 Message_Read_Receipt_Enabled） */
  async getReadReceipts(
    messageId: string,
  ): Promise<{ user: RcUser; ts: RcDate }[]> {
    return getReadReceiptsEndpoint(this.endpointContext(), messageId);
  }
}
