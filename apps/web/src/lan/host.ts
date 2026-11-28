import type { RcMessage } from '@rcx/rc-client';

export type LanPublicSettingResult =
  | { status: 'found'; value: unknown }
  | { status: 'missing' }
  | { status: 'failed' };

export interface LanTrustedDeviceRecord {
  userId: string;
  deviceId: string;
  publicKey: string;
}

export interface LanHostPort {
  currentUserId: () => string | null;
  ensureSiteUrl: () => Promise<string>;
  readPublicSettingResult: (id: string) => Promise<LanPublicSettingResult>;
  listTrustedDevices: (scope: string) => Promise<Array<{ key: string; value: LanTrustedDeviceRecord }>>;
  saveTrustedDevice: (scope: string, key: string, value: LanTrustedDeviceRecord) => Promise<void>;
  listOutbox: <T = unknown>() => Promise<Array<{ id: string; value: T }>>;
  setOutbox: (id: string, value: unknown) => Promise<void>;
  deleteOutbox: (id: string) => Promise<void>;
  sendRawMessage: (message: {
    _id?: string;
    rid: string;
    msg: string;
    customFields?: Record<string, unknown>;
  }) => Promise<RcMessage>;
  getRawMessage: (messageId: string) => Promise<RcMessage>;
}

const memoryTrustStore = new Map<string, Map<string, LanTrustedDeviceRecord>>();
const memoryOutboxStore = new Map<string, unknown>();

const defaultHost: LanHostPort = {
  currentUserId: () => {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem('rcx-auth');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { userId?: unknown } | null;
      return typeof parsed?.userId === 'string' && parsed.userId ? parsed.userId : null;
    } catch {
      return null;
    }
  },
  ensureSiteUrl: async () => '',
  readPublicSettingResult: async () => ({ status: 'missing' }),
  listTrustedDevices: async (scope) => {
    const bucket = memoryTrustStore.get(scope);
    if (!bucket) return [];
    return [...bucket.entries()].map(([key, value]) => ({ key, value }));
  },
  saveTrustedDevice: async (scope, key, value) => {
    let bucket = memoryTrustStore.get(scope);
    if (!bucket) {
      bucket = new Map();
      memoryTrustStore.set(scope, bucket);
    }
    bucket.set(key, value);
  },
  listOutbox: async <T = unknown>() =>
    [...memoryOutboxStore.entries()].map(([id, value]) => ({ id, value: value as T })),
  setOutbox: async (id, value) => {
    memoryOutboxStore.set(id, value);
  },
  deleteOutbox: async (id) => {
    memoryOutboxStore.delete(id);
  },
  sendRawMessage: async () => {
    throw new Error('LAN outbox sender is not registered');
  },
  getRawMessage: async () => {
    throw new Error('LAN outbox reader is not registered');
  },
};

let activeLanHost: LanHostPort = { ...defaultHost };

/** 由上层认证/通信/内核宿主注册，避免局域网传输层反向静态耦合 stores/client/kernel。 */
export function registerLanHost(partial: Partial<LanHostPort>): () => void {
  const previous = activeLanHost;
  activeLanHost = { ...activeLanHost, ...partial };
  return () => {
    activeLanHost = previous;
  };
}

export function getLanHost(): LanHostPort {
  return activeLanHost;
}
