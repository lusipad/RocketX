import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { ensureSiteUrl, getServerBase, isTauri, readPublicSettingResult } from '../lib/client';
import { resolveLanServerId } from '../lib/lanServerScope';
import { useAuth } from '../stores/auth';
import { UNKNOWN_LAN_FIREWALL, type LanFirewallStatus } from './firewall';
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
const confirmedLanDevices = new Map<string, string>();
/** 每次启动/停止都换代；等待服务器身份期间会话结束或重新启动时，旧的启动流程自行作废。 */
let lanGeneration = 0;
const lanStateListeners = new Set<() => void>();

function publishLanState(): void {
  for (const listener of lanStateListeners) listener();
}

function setPeerCache(peers: LanPeer[]): void {
  peerCache = peers;
  publishLanState();
}

function confirmLanDevice(userId: string, deviceId: string): void {
  if (confirmedLanDevices.get(userId) === deviceId) return;
  confirmedLanDevices.set(userId, deviceId);
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
  if (userId === useAuth.getState().user?._id) return false;
  const result = await invoke<TrustedDevice>('lan_probe_peer', {
    userId,
    deviceId: null,
  });
  const peer = peerCache.find(
    (candidate) =>
      candidate.userId === result.userId &&
      candidate.deviceId === result.deviceId &&
      candidate.publicKey === result.publicKey,
  );
  await pinTrustedDevice({
    version: 1,
    userId: result.userId,
    deviceId: result.deviceId,
    deviceName: peer?.deviceName ?? result.deviceId,
    publicKey: result.publicKey,
  });
  confirmLanDevice(result.userId, result.deviceId);
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
  const generation = ++lanGeneration;
  const superseded = () => generation !== lanGeneration;
  trustedDevices = await loadTrustedDevices();
  const deviceName =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    'RocketX desktop';
  // LAN 作用域使用 Rocket.Chat 的 canonical Site_Url，避免同一服务器一边用 IP、
  // 一边用域名时互相被发现过滤。这里只读取服务器设置，不发起 LAN 握手。
  const serverUrl = await ensureSiteUrl();
  // 服务器自报的 uniqueID 才是发现指纹的权威输入：Site_Url 未配置或两端各填各的
  // 入口地址时，按 URL 算出的指纹互不相等，公告会在原生端被静默丢掉（issue #369）。
  // 服务端确实没有才传 null（原生端退回 URL 归一化）；这次没读到（限流/网络）则退避
  // 重试，否则一端 server_id、一端 url，两端永远互相发现不了。serverUrl 保持不变——
  // 它同时是设备身份钥匙串的作用域。
  const { serverId, outcome } = await resolveLanServerId(() => readPublicSettingResult('uniqueID'), {
    isCancelled: superseded,
  });
  if (outcome === 'cancelled' || superseded()) return;
  if (outcome === 'unavailable') {
    console.warn(
      '[rcx] LAN 多次读取服务器身份（uniqueID）失败，本次按接入地址计算指纹；若对方读到了服务器身份，两端会互相发现不了，重启客户端可重试',
    );
  }
  const service = await invoke<LanServiceInfo>('lan_service_start', {
    serverUrl: serverUrl || getServerBase() || location.origin,
    serverId,
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
    void pinTrustedDevice({
      version: 1,
      userId: payload.userId,
      deviceId: payload.deviceId,
      deviceName: peer?.deviceName ?? payload.deviceId,
      publicKey: payload.publicKey,
    })
      .catch(() => {});
  });
  await pollPeers();
  pollTimer = setInterval(() => void pollPeers(), 3_000);
}

export async function stopLanRuntime(): Promise<void> {
  lanGeneration += 1;
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
  confirmedLanDevices.clear();
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
  return [...confirmedLanDevices.keys()];
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
  const deviceId = confirmedLanDevices.get(userId);
  if (!deviceId) throw new Error('P2P 握手已失效，请重新发起直传');
  const startedAt = performance.now();
  const receipt = await invoke<Omit<LanFileReceipt, 'bytesPerSecond'>>('lan_send_file', {
    userId,
    deviceId,
    path,
    messageId: payload.messageId,
    roomId: payload.roomId,
    originalTs: payload.originalTs,
  });
  const elapsedSeconds = Math.max((performance.now() - startedAt) / 1_000, 0.001);
  return { ...receipt, bytesPerSecond: receipt.size / elapsedSeconds };
}

/**
 * 等对方设备出现在发现列表里。刚放行防火墙时，对方的公告每 3 秒才广播一次，
 * 不等一下就握手必然报「没有发现对方设备」。
 */
export async function waitForLanPeer(userId: string, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await pollPeers();
    if (peerCache.some((peer) => peer.userId === userId)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * 只读判定本机防火墙对 RocketX 局域网入站的放行情况（原生端，无需提权）。
 * `userId` 是对方：原生端用对方已发现的地址定位局域网实际走的网卡。
 */
export async function checkLanFirewall(userId?: string): Promise<LanFirewallStatus> {
  if (!isTauri) return { ...UNKNOWN_LAN_FIREWALL, state: 'unsupported' };
  return invoke<LanFirewallStatus>('lan_firewall_check', { userId: userId ?? null });
}

/**
 * 弹一次 UAC，删除本程序的入站规则（含弹窗生成的阻止规则）并添加放行规则。
 * 只在用户点击 P2P 直传、且本机入站被挡（或直传失败后）时调用；用户拒绝提权时返回 null。
 */
export async function repairLanFirewall(userId?: string): Promise<LanFirewallStatus | null> {
  if (!isTauri) return { ...UNKNOWN_LAN_FIREWALL, state: 'unsupported' };
  try {
    return await invoke<LanFirewallStatus>('lan_firewall_repair', { userId: userId ?? null });
  } catch (error) {
    if (String(error) === 'cancelled') return null;
    throw error;
  }
}
