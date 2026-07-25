import { getServerBase, rest } from './client';
import { useAuth } from '../stores/auth';
// 只取类型：运行时依赖必须保持 runner → delivery 单向，否则成环
import type { StoredRoundsResult } from './butlerRoundsRunner';

/**
 * 简报投递进 Rocket.Chat：以普通消息发进「和自己的私聊」。
 *
 * 这是非桌面端的管家呈现方案（决策 13）：web / 内网 / 手机官方 App
 * 打开就能看到今天的简报——Rocket.Chat 本身就是同步层，零新基础设施。
 *
 * 授权边界：默认关闭；用户在简报页显式打开才开始投递，随时可关。
 * 自动投递每天至多一条，手动重发不受限。
 */

const DELIVERY_KEY_PREFIX = 'rcx-butler-v1:brief-delivery';

export interface ButlerBriefDeliverySettings {
  enabled: boolean;
  /** 最近一次自动投递的本地日期（YYYY-MM-DD），当天不重发 */
  lastDeliveredDate?: string;
}

export interface ButlerBriefDeliveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 发送通道：默认真实 REST，测试注入替身 */
export interface ButlerBriefDeliveryClient {
  createDirectMessage(usernames: string): Promise<{ _id: string }>;
  sendMessage(rid: string, msg: string): Promise<unknown>;
}

function browserStorage(): ButlerBriefDeliveryStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

/** 按 server+account 隔离——rid 与投递记录都不能跨服务器串用 */
function deliveryKey(): string | undefined {
  const account = useAuth.getState().user?._id;
  if (!account) return undefined;
  return `${DELIVERY_KEY_PREFIX}:${getServerBase() || 'same-origin'}:${account}`;
}

export function briefDeliverySettings(
  storage: ButlerBriefDeliveryStorage | undefined = browserStorage(),
): ButlerBriefDeliverySettings {
  const key = deliveryKey();
  if (!storage || !key) return { enabled: false };
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { enabled: false };
    const record = parsed as Record<string, unknown>;
    return {
      enabled: record.enabled === true,
      ...(typeof record.lastDeliveredDate === 'string'
        ? { lastDeliveredDate: record.lastDeliveredDate }
        : {}),
    };
  } catch {
    return { enabled: false };
  }
}

function saveSettings(
  settings: ButlerBriefDeliverySettings,
  storage: ButlerBriefDeliveryStorage | undefined,
): void {
  const key = deliveryKey();
  if (!storage || !key) return;
  try {
    storage.setItem(key, JSON.stringify(settings));
  } catch {
    /* 存储满时放弃记录；代价只是当天可能多收一条 */
  }
}

export function setBriefDeliveryEnabled(
  enabled: boolean,
  storage: ButlerBriefDeliveryStorage | undefined = browserStorage(),
): void {
  saveSettings({ ...briefDeliverySettings(storage), enabled }, storage);
}

function localDateKey(at: Date): string {
  const y = at.getFullYear();
  const m = `${at.getMonth() + 1}`.padStart(2, '0');
  const d = `${at.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 简报正文，Rocket.Chat markdown。ref 一律替换成人话标题。 */
export function renderBriefMessage(stored: StoredRoundsResult): string {
  const titleOf = (ref: string) => stored.refTitles[ref] ?? ref;
  const lines: string[] = [`*${stored.result.headline}*`];
  if (stored.result.summary) lines.push(stored.result.summary);
  const snoozed = new Set(stored.snoozedRefs ?? []);
  const items = stored.result.items.filter((item) => !snoozed.has(item.ref));
  if (items.length) {
    lines.push('');
    for (const item of items) {
      const action = item.suggestedAction ? ` → ${item.suggestedAction}` : '';
      lines.push(`- *${titleOf(item.ref)}*：${item.why}${action}`);
    }
  }
  const generated = new Date(stored.generatedAt);
  const stamp = Number.isNaN(generated.getTime()) ? '' : ` · ${localDateKey(generated)}`;
  lines.push('', `_RocketX 管家${stamp}_`);
  return lines.join('\n');
}

const defaultClient: ButlerBriefDeliveryClient = {
  createDirectMessage: (usernames) => rest.createDirectMessage(usernames),
  sendMessage: (rid, msg) => rest.sendMessage(rid, msg),
};

/**
 * 投递一份简报。自动模式（rounds 完成后调用）尊重开关与当天去重；
 * 手动模式（用户点了按钮）两者都跳过。
 * 返回是否真的发出去了。
 */
export async function deliverButlerBrief(
  stored: StoredRoundsResult,
  options?: {
    manual?: boolean;
    now?: Date;
    storage?: ButlerBriefDeliveryStorage;
    client?: ButlerBriefDeliveryClient;
  },
): Promise<boolean> {
  const storage = options?.storage ?? browserStorage();
  const client = options?.client ?? defaultClient;
  const manual = options?.manual === true;
  const today = localDateKey(options?.now ?? new Date());

  const settings = briefDeliverySettings(storage);
  if (!manual) {
    if (!settings.enabled) return false;
    if (settings.lastDeliveredDate === today) return false;
  }

  const username = useAuth.getState().user?.username;
  if (!username) {
    if (manual) throw new Error('还没登录，无法投递简报。');
    return false;
  }

  // 与自己的私聊：im.create 幂等，已有房间时直接返回。不缓存 rid，换服务器不会串。
  const room = await client.createDirectMessage(username);
  await client.sendMessage(room._id, renderBriefMessage(stored));

  saveSettings({ ...settings, lastDeliveredDate: today }, storage);
  return true;
}
