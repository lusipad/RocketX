import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ensureSiteUrl, getServerBase, isTauri } from '../lib/client';
import { useAuth } from '../stores/auth';
import type { LanDeviceKeyEnvelope } from './protocol';

export interface LanIdentityInfo {
  deviceId: string;
  deviceName: string;
  publicKey: string;
  protocolVersion: number;
}

export interface LanPeer {
  userId: string;
  deviceId: string;
  deviceName: string;
  ip: string;
  port: number;
  publicKey: string;
  trusted: boolean;
  source: 'mdns' | 'udp';
  lastSeenMs: number;
}

export interface LanMessageEvent {
  fromUserId: string;
  fromDeviceId: string;
  messageId: string;
  roomId: string;
  originalTs: number;
  text: string;
}

export interface LanFileEvent {
  fromUserId: string;
  fromDeviceId: string;
  messageId: string;
  roomId: string;
  originalTs: number;
  fileName: string;
  size: number;
  blake3: string;
  localPath: string;
}

export interface LanFileReceipt {
  messageId: string;
  fileName: string;
  size: number;
  blake3: string;
  bytesPerSecond: number;
}

interface LanProbeEvent {
  userId: string;
  deviceId: string;
  publicKey: string;
}

interface LanServiceInfo {
  identity: LanIdentityInfo;
  port: number;
}

type TrustedDevice = Pick<LanDeviceKeyEnvelope, 'userId' | 'deviceId' | 'publicKey'>;

let identity: LanIdentityInfo | null = null;
let trustedDevices: TrustedDevice[] = [];
let peerCache: LanPeer[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unlistenMessage: UnlistenFn | null = null;
let unlistenFile: UnlistenFn | null = null;
let unlistenProbe: UnlistenFn | null = null;
let confirmedLanUserIds: string[] = [];
const lanStateListeners = new Set<() => void>();

function publishLanState(): void {
  for (const listener of lanStateListeners) listener();
}

function setPeerCache(peers: LanPeer[]): void {
  peerCache = peers;
  const availableUsers = new Set(
    peers.filter((peer) => peer.trusted).map((peer) => peer.userId),
  );
  confirmedLanUserIds = confirmedLanUserIds.filter((userId) => availableUsers.has(userId));
  publishLanState();
}

function confirmLanUser(userId: string): void {
  if (confirmedLanUserIds.includes(userId)) return;
  confirmedLanUserIds = [...confirmedLanUserIds, userId];
  publishLanState();
}

async function appDataStore() {
  return (await import('../kernel/store')).kernelStore.appData;
}

function scope(): string {
  const userId = useAuth.getState().user?._id ?? 'guest';
  return `system:lan:${encodeURIComponent(getServerBase() || 'same-origin')}:${userId}`;
}

function deviceKey(device: TrustedDevice): string {
  return `${device.userId}:${device.deviceId}`;
}

async function loadTrustedDevices(): Promise<TrustedDevice[]> {
  const entries = await (await appDataStore()).list<TrustedDevice>(scope());
  const unique = new Map<string, TrustedDevice>();
  for (const { value } of entries) {
    if (value?.userId && value.deviceId && value.publicKey) unique.set(deviceKey(value), value);
  }
  return [...unique.values()];
}

async function pinTrustedDevice(device: LanDeviceKeyEnvelope): Promise<void> {
  const trusted: TrustedDevice = {
    userId: device.userId,
    deviceId: device.deviceId,
    publicKey: device.publicKey,
  };
  await (await appDataStore()).set(scope(), deviceKey(trusted), trusted);
  trustedDevices = await loadTrustedDevices();
  if (isTauri) await invoke('lan_trust_replace', { trustedDevices });
  setPeerCache(peerCache.map((peer) => (
    peer.userId === trusted.userId && peer.deviceId === trusted.deviceId
      ? { ...peer, trusted: true }
      : peer
  )));
}

/** 仅在发送文件时调用；发一次原生通信请求，不创建或发送 Rocket.Chat 消息。 */
export async function probeLanPeer(userId: string): Promise<boolean> {
  if (!isTauri) return false;
  const peer = peerCache.find((candidate) => candidate.userId === userId);
  if (!peer || peer.userId === useAuth.getState().user?._id) return false;
  const result = await invoke<TrustedDevice>('lan_probe_peer', {
    userId: peer.userId,
    deviceId: peer.deviceId,
  });
  await pinTrustedDevice({
    version: 1,
    userId: result.userId,
    deviceId: result.deviceId,
    deviceName: peer.deviceName,
    publicKey: result.publicKey,
  });
  confirmLanUser(result.userId);
  return true;
}

async function pollPeers(): Promise<void> {
  if (!isTauri || !identity) return;
  try {
    setPeerCache(await invoke<LanPeer[]>('lan_peers'));
  } catch {
    setPeerCache([]);
  }
}

export async function startLanRuntime(
  onMessage: ((event: LanMessageEvent) => void | Promise<void>) | undefined,
  onFile?: (event: LanFileEvent) => void | Promise<void>,
): Promise<void> {
  if (!isTauri) return;
  const user = useAuth.getState().user;
  if (!user) return;
  await stopLanRuntime();
  trustedDevices = await loadTrustedDevices();
  const deviceName =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    'RocketX desktop';
  // LAN 作用域使用 Rocket.Chat 的 canonical Site_Url，避免同一服务器一边用 IP、
  // 一边用域名时互相被发现过滤。这里只读取服务器设置，不发起 LAN 握手。
  const serverUrl = await ensureSiteUrl();
  const service = await invoke<LanServiceInfo>('lan_service_start', {
    serverUrl: serverUrl || getServerBase() || location.origin,
    userId: user._id,
    deviceName,
    trustedDevices,
  });
  identity = service.identity;
  if (onMessage) {
    unlistenMessage = await listen<LanMessageEvent>('rocketx://lan-message', ({ payload }) => {
      void onMessage(payload);
    });
  }
  if (onFile) {
    unlistenFile = await listen<LanFileEvent>('rocketx://lan-file', ({ payload }) => {
      void onFile(payload);
    });
  }
  unlistenProbe = await listen<LanProbeEvent>('rocketx://lan-peer-probed', ({ payload }) => {
    const peer = peerCache.find(
      (candidate) =>
        candidate.userId === payload.userId &&
        candidate.deviceId === payload.deviceId &&
        candidate.publicKey === payload.publicKey,
    );
    if (!peer) return;
    void pinTrustedDevice({
      version: 1,
      userId: peer.userId,
      deviceId: peer.deviceId,
      deviceName: peer.deviceName,
      publicKey: peer.publicKey,
    })
      .then(() => confirmLanUser(peer.userId))
      .catch(() => {});
  });
  await pollPeers();
  pollTimer = setInterval(() => void pollPeers(), 3_000);
}

export async function stopLanRuntime(): Promise<void> {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  unlistenMessage?.();
  unlistenMessage = null;
  unlistenFile?.();
  unlistenFile = null;
  unlistenProbe?.();
  unlistenProbe = null;
  identity = null;
  peerCache = [];
  confirmedLanUserIds = [];
  publishLanState();
  if (isTauri) await invoke('lan_service_stop').catch(() => {});
}

export function currentLanPeers(): LanPeer[] {
  return peerCache.slice();
}

export function subscribeLanState(listener: () => void): () => void {
  lanStateListeners.add(listener);
  return () => lanStateListeners.delete(listener);
}

export function confirmedLanUsersSnapshot(): readonly string[] {
  return confirmedLanUserIds;
}

export function redactedLanPeers(peers: LanPeer[] = peerCache) {
  return peers.map(({ userId, deviceId, deviceName, trusted, source, lastSeenMs }) => ({
    userId,
    deviceId,
    deviceName,
    trusted,
    source,
    lastSeenMs,
  }));
}

export async function sendLanFile(
  userId: string,
  path: string,
  payload: { messageId: string; roomId: string; originalTs: number },
): Promise<LanFileReceipt> {
  if (!isTauri) throw new Error('LAN file transfer is only available in the desktop app');
  const startedAt = performance.now();
  const receipt = await invoke<Omit<LanFileReceipt, 'bytesPerSecond'>>('lan_send_file', {
    userId,
    deviceId: null,
    path,
    messageId: payload.messageId,
    roomId: payload.roomId,
    originalTs: payload.originalTs,
  });
  const elapsedSeconds = Math.max((performance.now() - startedAt) / 1_000, 0.001);
  return { ...receipt, bytesPerSecond: receipt.size / elapsedSeconds };
}
