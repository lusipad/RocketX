import type { RcMessage, RcRoomFile, RoomType } from '@rcx/rc-client';

export interface KernelSubscription {
  rid: string;
  name: string;
  fname?: string;
  t: RoomType;
  unread?: number;
}

export interface KernelRoom {
  uids?: readonly string[];
}

export interface KernelUser {
  _id: string;
  username: string;
  name?: string;
  status?: string;
}

export interface KernelChatSnapshot {
  activeRid: string | null;
  messages: Readonly<Record<string, readonly RcMessage[]>>;
  subscriptions: Readonly<Record<string, KernelSubscription>>;
  rooms: Readonly<Record<string, KernelRoom>>;
  members: Readonly<Record<string, readonly KernelUser[]>>;
}

export interface KernelChatEventState {
  activeRid: string | null;
  messages: Readonly<Record<string, readonly RcMessage[]>>;
}

export interface KernelChatPort {
  current(): { rid: string | null; messages: RcMessage[] };
  history(rid: string, count: number): RcMessage[];
  postMessage(rid: string, text: string, tmid?: string): Promise<{ ok: true }>;
}

export interface KernelRoomPort {
  list(): Array<{
    rid: string;
    name: string;
    type: RoomType;
    unread: number;
  }>;
  isMember(rid: string): boolean;
  typeOf(rid: string): RoomType | null;
  memberIds(rid: string): readonly string[];
}

export interface KernelUserPort {
  read(rid: string | null): KernelUser[];
}

export interface KernelFilePort {
  list(rid: string, type: RoomType, count: number): Promise<RcRoomFile[]>;
  read(path: string): Promise<Blob>;
}

export interface KernelLanPeer {
  userId: string;
  deviceId: string;
  deviceName: string;
  trusted: boolean;
  source: 'mdns' | 'udp';
  lastSeenMs: number;
}

export interface KernelLanPort {
  listPeers(): KernelLanPeer[];
}

export interface KernelNavigationPort {
  currentModule(): string;
  setModule(module: string): void;
  currentPanel(): string | null;
  setPanel(kind: string | null): void;
  installModuleValidator(validator: (module: string) => boolean): void;
}

export interface KernelNotificationPort {
  info(message: unknown, title?: string): void;
  success(message: unknown, title?: string): void;
  error(message: unknown, title?: string): void;
}

export interface KernelBackgroundPort {
  startRoutines(): void;
}

export interface KernelAiPort {
  summarize(rid: string): Promise<void>;
}

export interface KernelAgentPort {
  endSession(tmid: string): Promise<void>;
  startBridge(): void | Promise<void>;
  stopBridge(): void | Promise<void>;
}

export interface KernelEventPort {
  subscribeChat(listener: (state: KernelChatEventState, previous: KernelChatEventState) => void): () => void;
}

export interface KernelIdentityPort {
  userId(): string | null;
}

export interface KernelWorkbenchPort {
  useConnected(): boolean;
}

export interface KernelHost {
  identity: KernelIdentityPort;
  chat: KernelChatPort;
  rooms: KernelRoomPort;
  users: KernelUserPort;
  files: KernelFilePort;
  lan: KernelLanPort;
  navigation: KernelNavigationPort;
  notifications: KernelNotificationPort;
  background: KernelBackgroundPort;
  ai: KernelAiPort;
  agent: KernelAgentPort;
  events: KernelEventPort;
  workbench: KernelWorkbenchPort;
}
