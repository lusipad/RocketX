import type { RcMessage } from '@rcx/rc-client';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { getServerBase, isTauri, rest } from '../lib/client';
import { useAuth } from '../stores/auth';
import {
  encodeLanDeviceKey,
  parseLanDeviceKey,
  type LanDeviceKeyEnvelope,
} from './protocol';

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
const exchangeAttempts = new Map<string, number>();
const repliedRooms = new Set<string>();

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
}

function localEnvelope(): LanDeviceKeyEnvelope | null {
  const user = useAuth.getState().user;
  if (!identity || !user) return null;
  return {
    version: 1,
    userId: user._id,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    publicKey: identity.publicKey,
  };
}

function messageId(): string {
  const value = crypto.randomUUID().replace(/-/g, '');
  return value.slice(0, 17);
}

async function sendIdentityToRoom(rid: string): Promise<void> {
  const envelope = localEnvelope();
  if (!envelope) return;
  await rest.sendMessageRaw({
    _id: messageId(),
    rid,
    msg: encodeLanDeviceKey(envelope),
  });
}

async function ensureKeyExchange(peer: LanPeer): Promise<void> {
  if (peer.trusted || peer.userId === useAuth.getState().user?._id) return;
  const key = `${peer.userId}:${peer.deviceId}`;
  const lastAttempt = exchangeAttempts.get(key) ?? 0;
  if (Date.now() - lastAttempt < 30_000) return;
  exchangeAttempts.set(key, Date.now());
  try {
    const user = await rest.getUserInfoById(peer.userId);
    const room = await rest.createDirectMessage(user.username);
    await sendIdentityToRoom(room._id);
  } catch {
    exchangeAttempts.delete(key);
  }
}

async function pollPeers(): Promise<void> {
  if (!isTauri || !identity) return;
  try {
    peerCache = await invoke<LanPeer[]>('lan_peers');
    for (const peer of peerCache) void ensureKeyExchange(peer);
  } catch {
    peerCache = [];
  }
}

export async function startLanRuntime(
  onMessage: (event: LanMessageEvent) => void | Promise<void>,
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
  const service = await invoke<LanServiceInfo>('lan_service_start', {
    serverUrl: getServerBase() || location.origin,
    userId: user._id,
    deviceName,
    trustedDevices,
  });
  identity = service.identity;
  unlistenMessage = await listen<LanMessageEvent>('rocketx://lan-message', ({ payload }) => {
    void onMessage(payload);
  });
  await pollPeers();
  pollTimer = setInterval(() => void pollPeers(), 3_000);
}

export async function stopLanRuntime(): Promise<void> {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  unlistenMessage?.();
  unlistenMessage = null;
  identity = null;
  peerCache = [];
  exchangeAttempts.clear();
  repliedRooms.clear();
  if (isTauri) await invoke('lan_service_stop').catch(() => {});
}

export async function handleLanControlMessage(message: RcMessage): Promise<boolean> {
  const envelope = parseLanDeviceKey(message.msg);
  if (!envelope) return false;
  if (message.u._id !== envelope.userId) return true;
  await pinTrustedDevice(envelope);
  if (!repliedRooms.has(message.rid)) {
    repliedRooms.add(message.rid);
    await sendIdentityToRoom(message.rid).catch(() => repliedRooms.delete(message.rid));
  }
  return true;
}

export function currentLanPeers(): LanPeer[] {
  return peerCache.slice();
}

export async function sendLanChat(
  userId: string,
  message: { messageId: string; roomId: string; originalTs: number; text: string },
): Promise<void> {
  if (!isTauri) throw new Error('局域网消息仅支持桌面端');
  await invoke('lan_send_chat', {
    userId,
    deviceId: null,
    messageId: message.messageId,
    roomId: message.roomId,
    originalTs: message.originalTs,
    text: message.text,
  });
}
