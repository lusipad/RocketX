import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { create } from 'zustand';
import { getServerBase, isTauri } from '../lib/client';
import { useAuth } from '../stores/auth';

export const IPMSG_RID = 'local:ipmsg';

const APP_ID = 'system:ipmsg';
const MAX_MESSAGES = 500;

export interface IpmsgPeer {
  id: string;
  user: string;
  host: string;
  nickname: string;
  group: string;
  ip: string;
  port: number;
  dialect: 'ipmsg' | 'feiq' | 'intranet';
  supportsUtf8: boolean;
  lastSeenMs: number;
}

export interface IpmsgMessage {
  id: string;
  peerId: string;
  senderName: string;
  direction: 'incoming' | 'outgoing';
  text: string;
  timestamp: number;
  acknowledged?: boolean;
  fileName?: string;
  fileSize?: number;
  offerId?: string;
  localPath?: string;
  expired?: boolean;
}

interface IpmsgStatus {
  enabled: boolean;
  port: number;
  peerCount: number;
  intranetAvailable: boolean;
}

interface IpmsgPeerEvent {
  kind: 'upsert' | 'remove';
  peer: IpmsgPeer;
}

interface IpmsgMessageEvent {
  id: string;
  peerId: string;
  nickname: string;
  text: string;
  receivedAt: number;
}

interface IpmsgFileOfferEvent {
  id: string;
  peerId: string;
  fileName: string;
  size: number;
}

interface IpmsgSendReceipt {
  packetNo: string;
  acknowledged: boolean;
}

interface IpmsgFileReceipt {
  offerId: string;
  fileName: string;
  size: number;
  localPath: string;
}

interface PersistedIpmsgState {
  enabled: boolean;
  selectedPeerId: string | null;
  messages: IpmsgMessage[];
}

interface IpmsgState {
  hydrated: boolean;
  enabled: boolean;
  running: boolean;
  port: number;
  intranetAvailable: boolean;
  error: string | null;
  peers: IpmsgPeer[];
  selectedPeerId: string | null;
  messages: IpmsgMessage[];
  unread: number;
  hydrate: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  selectPeer: (peerId: string) => void;
  refreshPeers: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  offerFile: (path: string) => Promise<void>;
  downloadFile: (messageId: string) => Promise<void>;
  markRead: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let unlisteners: UnlistenFn[] = [];

function scope(): string {
  return `${encodeURIComponent(getServerBase() || 'same-origin')}:${useAuth.getState().user?._id ?? 'guest'}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentPeer(state: Pick<IpmsgState, 'peers' | 'selectedPeerId'>): IpmsgPeer {
  const peer = state.peers.find((candidate) => candidate.id === state.selectedPeerId);
  if (!peer) throw new Error('请先选择一个在线的内网通/IP Messenger 联系人');
  return peer;
}

function trimMessages(messages: IpmsgMessage[]): IpmsgMessage[] {
  return messages.slice(-MAX_MESSAGES);
}

async function persist(): Promise<void> {
  const { enabled, selectedPeerId, messages } = useIpmsg.getState();
  const { kernelStore } = await import('../kernel/store');
  await kernelStore.appData.set(APP_ID, scope(), {
    enabled,
    selectedPeerId,
    messages: trimMessages(messages),
  } satisfies PersistedIpmsgState);
}

function append(message: IpmsgMessage, unread: boolean): void {
  useIpmsg.setState((state) => ({
    messages: trimMessages([...state.messages.filter((item) => item.id !== message.id), message]),
    unread: unread ? state.unread + 1 : state.unread,
  }));
  void persist();
}

async function wireEvents(): Promise<void> {
  for (const unlisten of unlisteners) unlisten();
  unlisteners = [
    await listen<IpmsgPeerEvent>('rocketx://ipmsg-peer', ({ payload }) => {
      useIpmsg.setState((state) => {
        const peers = payload.kind === 'remove'
          ? state.peers.filter((peer) => peer.id !== payload.peer.id)
          : [...state.peers.filter((peer) => peer.id !== payload.peer.id), payload.peer]
              .sort((left, right) => left.nickname.localeCompare(right.nickname, 'zh-CN'));
        const selectedPeerId = peers.some((peer) => peer.id === state.selectedPeerId)
          ? state.selectedPeerId
          : peers[0]?.id ?? null;
        return { peers, selectedPeerId };
      });
    }),
    await listen<IpmsgMessageEvent>('rocketx://ipmsg-message', ({ payload }) => {
      append({
        id: `message:${payload.id}`,
        peerId: payload.peerId,
        senderName: payload.nickname,
        direction: 'incoming',
        text: payload.text,
        timestamp: payload.receivedAt,
      }, true);
    }),
    await listen<IpmsgFileOfferEvent>('rocketx://ipmsg-file-offer', ({ payload }) => {
      const peer = useIpmsg.getState().peers.find((candidate) => candidate.id === payload.peerId);
      append({
        id: `file:${payload.id}`,
        peerId: payload.peerId,
        senderName: peer?.nickname || peer?.user || 'IP Messenger',
        direction: 'incoming',
        text: `发送了文件 ${payload.fileName}`,
        timestamp: Date.now(),
        fileName: payload.fileName,
        fileSize: payload.size,
        offerId: payload.id,
      }, true);
    }),
  ];
}

async function startRuntime(): Promise<void> {
  if (!isTauri) throw new Error('内网通/IP Messenger 兼容模式仅支持桌面客户端');
  const user = useAuth.getState().user;
  if (!user) return;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  await wireEvents();
  let status: IpmsgStatus;
  try {
    status = await invoke<IpmsgStatus>('ipmsg_start', {
      userName: user.username,
      nickname: user.name || user.username,
      group: 'RocketX',
    });
  } catch (error) {
    for (const unlisten of unlisteners) unlisten();
    unlisteners = [];
    throw error;
  }
  useIpmsg.setState({
    running: status.enabled,
    port: status.port,
    intranetAvailable: status.intranetAvailable,
    error: null,
  });
  await useIpmsg.getState().refreshPeers();
  pollTimer = setInterval(() => void useIpmsg.getState().refreshPeers(), 3_000);
}

export async function stopIpmsgRuntime(): Promise<void> {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  for (const unlisten of unlisteners) unlisten();
  unlisteners = [];
  if (isTauri) await invoke('ipmsg_stop').catch(() => {});
  useIpmsg.setState({ running: false, intranetAvailable: false, peers: [], selectedPeerId: null });
}

export async function initializeIpmsgRuntime(): Promise<void> {
  await useIpmsg.getState().hydrate();
  if (!useIpmsg.getState().enabled) return;
  try {
    await startRuntime();
  } catch (error) {
    useIpmsg.setState({ running: false, error: errorText(error) });
  }
}

export const useIpmsg = create<IpmsgState>((set, get) => ({
  hydrated: false,
  enabled: false,
  running: false,
  port: 2425,
  intranetAvailable: false,
  error: null,
  peers: [],
  selectedPeerId: null,
  messages: [],
  unread: 0,

  hydrate: async () => {
    if (get().hydrated) return;
    const { kernelStore } = await import('../kernel/store');
    const saved = await kernelStore.appData.get<PersistedIpmsgState>(APP_ID, scope());
    set({
      hydrated: true,
      enabled: saved?.enabled ?? false,
      selectedPeerId: saved?.selectedPeerId ?? null,
      messages: (saved?.messages ?? []).map((message) =>
        message.offerId && !message.localPath
          ? { ...message, offerId: undefined, expired: true }
          : message,
      ),
    });
  },

  setEnabled: async (enabled) => {
    set({ enabled, error: null });
    await persist();
    if (!enabled) {
      await stopIpmsgRuntime();
      return;
    }
    try {
      await startRuntime();
    } catch (error) {
      set({ running: false, error: errorText(error) });
      throw error;
    }
  },

  selectPeer: (selectedPeerId) => {
    set({ selectedPeerId });
    void persist();
  },

  refreshPeers: async () => {
    if (!isTauri || !get().running) return;
    try {
      const peers = await invoke<IpmsgPeer[]>('ipmsg_peers');
      set((state) => ({
        peers,
        selectedPeerId: peers.some((peer) => peer.id === state.selectedPeerId)
          ? state.selectedPeerId
          : peers[0]?.id ?? null,
        error: null,
      }));
    } catch (error) {
      set({ error: errorText(error) });
    }
  },

  sendMessage: async (text) => {
    const clean = text.trim();
    if (!clean) return;
    const peer = currentPeer(get());
    const receipt = await invoke<IpmsgSendReceipt>('ipmsg_send_message', {
      peerId: peer.id,
      text: clean,
    });
    append({
      id: `sent:${receipt.packetNo}`,
      peerId: peer.id,
      senderName: useAuth.getState().user?.name || useAuth.getState().user?.username || '我',
      direction: 'outgoing',
      text: clean,
      timestamp: Date.now(),
      acknowledged: receipt.acknowledged,
    }, false);
  },

  offerFile: async (path) => {
    const peer = currentPeer(get());
    const offer = await invoke<IpmsgFileOfferEvent>('ipmsg_offer_file', { peerId: peer.id, path });
    append({
      id: `sent-file:${offer.id}`,
      peerId: peer.id,
      senderName: useAuth.getState().user?.name || useAuth.getState().user?.username || '我',
      direction: 'outgoing',
      text: `发送文件 ${offer.fileName}`,
      timestamp: Date.now(),
      acknowledged: true,
      fileName: offer.fileName,
      fileSize: offer.size,
    }, false);
  },

  downloadFile: async (messageId) => {
    const message = get().messages.find((item) => item.id === messageId);
    if (!message?.offerId) throw new Error('文件邀请已过期，请让对方重新发送');
    const receipt = await invoke<IpmsgFileReceipt>('ipmsg_download_file', { offerId: message.offerId });
    set((state) => ({
      messages: state.messages.map((item) =>
        item.id === messageId
          ? { ...item, offerId: undefined, localPath: receipt.localPath, expired: false }
          : item,
      ),
    }));
    await persist();
  },

  markRead: () => set({ unread: 0 }),
}));
