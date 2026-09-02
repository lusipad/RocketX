import type { AppPermission, AppRuntime } from './manifest.js';

export const EXTENSION_POINTS = [
  'nav.module',
  'panel.right',
  'message.action',
  'message.renderer',
  'composer.command',
  'composer.trigger',
  'composer.action',
  'entity.link',
  'home.widget',
  'room.tab',
  'settings.page',
  'background.task',
] as const;

export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export interface BridgeMessageEvent {
  data: unknown;
  origin?: string;
  source?: unknown;
}

export interface BridgeEventSource {
  addEventListener(type: 'message', listener: (event: BridgeMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: BridgeMessageEvent) => void): void;
}

export interface BridgeTarget {
  postMessage(message: unknown, targetOrigin: string): void;
}

export type BridgeEventListener<T = unknown> = (payload: T) => void;

export interface BridgeClientOptions {
  target?: BridgeTarget;
  source?: BridgeEventSource;
  origin?: string;
  timeoutMs?: number;
}

export interface AppInfo {
  id: string;
  version: string;
  name: string;
  publisher: string;
  runtime: AppRuntime;
  permissions: readonly AppPermission[];
}

export type BridgeDate = string | { $date: number };

export interface ChatMessage {
  _id: string;
  rid: string;
  msg: string;
  ts?: BridgeDate;
  u: { _id?: string; username: string; name?: string };
  t?: string;
  tmid?: string;
  attachments?: unknown[];
  [key: string]: unknown;
}

export interface ChatCurrent {
  rid: string | null;
  messages: ChatMessage[];
}

export interface ChatHistoryOptions {
  rid?: string;
  count?: number;
}

export interface ChatPostMessageOptions {
  rid?: string;
  text: string;
  tmid?: string;
}

export type RoomType = 'c' | 'p' | 'd' | 'l';

export interface RoomSummary {
  rid: string;
  name: string;
  type: RoomType;
  unread: number;
  [key: string]: unknown;
}

export interface UserSummary {
  _id: string;
  username: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

export interface FileSummary {
  _id: string;
  name: string;
  type?: string;
  size?: number;
  uploadedAt?: BridgeDate;
  url?: string;
  path?: string;
  user?: UserSummary;
  [key: string]: unknown;
}

export interface FilesListOptions {
  rid?: string;
  count?: number;
}

export interface FileReadResult {
  type: string;
  size: number;
  base64: string;
}

export interface FilePickerResult {
  path?: string;
  cancelled?: boolean;
}

export interface LanPeer {
  userId: string;
  deviceId: string;
  deviceName: string;
  trusted: boolean;
  source: 'mdns' | 'udp';
  lastSeenMs: number;
}

export interface StorageEntry<T = unknown> {
  key: string;
  value: T;
}

export interface NetworkFetchOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | string;
  headers?: Record<string, string>;
  body?: string;
}

export interface NetworkFetchResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface NativeEvent {
  event: string;
  payload?: unknown;
}

export interface BridgeEventMap {
  'app.activated': undefined;
  'room.changed': { rid: string | null };
  'message.received': ChatMessage;
  'theme.changed': { theme: string };
  'native.event': NativeEvent;
}

export interface BridgeClient {
  call<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  app: {
    info(): Promise<AppInfo>;
  };
  chat: {
    current(): Promise<ChatCurrent>;
    history(options?: ChatHistoryOptions): Promise<ChatMessage[]>;
    postMessage(options: ChatPostMessageOptions): Promise<{ ok: true }>;
  };
  rooms: {
    list(): Promise<RoomSummary[]>;
  };
  users: {
    read(rid?: string): Promise<UserSummary[]>;
  };
  files: {
    list(options?: FilesListOptions): Promise<FileSummary[]>;
    read(path: string): Promise<FileReadResult>;
    pick(): Promise<FilePickerResult>;
  };
  lan: {
    listPeers(): Promise<LanPeer[]>;
  };
  storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T = unknown>(key: string, value: T): Promise<{ ok: true }>;
    delete(key: string): Promise<{ ok: true }>;
    list<T = unknown>(): Promise<StorageEntry<T>[]>;
  };
  net: {
    fetch(options: NetworkFetchOptions): Promise<NetworkFetchResponse>;
  };
  native: {
    call<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  };
  ui: {
    notify(props: { message: string; level?: 'info' | 'success' | 'error' }): Promise<{ ok: true }>;
  };
  config: {
    get(name: string): Promise<{ name: string; value: string | null }>;
  };
  requestUI<TResult = unknown>(kind: string, props?: unknown): Promise<TResult>;
  on<K extends keyof BridgeEventMap>(
    event: K,
    listener: BridgeEventListener<BridgeEventMap[K]>,
  ): () => void;
  on<T = unknown>(event: string, listener: BridgeEventListener<T>): () => void;
  destroy(): void;
}
