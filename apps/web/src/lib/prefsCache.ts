import type { RcPreferences } from '@rcx/rc-client';
import { getLocalDataSchema, readLocalData, writeLocalData } from './localDataContract';
import { isTauri } from './http';

/**
 * 通知等偏好的本地镜像（issue #351）。
 *
 * 背景：desktopNotifications / unreadAlert 这类开关存在服务端 preferences，
 * 但写/读链路一旦失败（离线、超时、服务端 5xx）就会静默回退默认值，
 * 用户关掉「任务栏闪烁/通知」重启软件后又弹回来。
 * 与 presencePreference 同一思路：用户显式改过的键在服务端写成功后落一份本地镜像，
 * 启动拉取失败时用镜像兜底，而不是裸 DEFAULTS。
 *
 * 账号隔离不走 presencePreference 的「key 内嵌 server+userId」，而是沿用
 * accountScope.ts 的约定：裸 key 写入，换账号时由 ensureAccountScope 整体归档/还原
 * （SCOPED_KEYS 里有它），不串账号。
 */
export const PREFS_CACHE_KEY = 'rcx-prefs-cache';
const PREFS_CACHE_VERSION = getLocalDataSchema('preferences').version;

function decodePrefs(value: unknown): Partial<RcPreferences> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Partial<RcPreferences>;
}

/** 读本地镜像。任何损坏/存储不可用都按空镜像处理，不影响主流程。 */
export function loadPrefsCache(): Partial<RcPreferences> {
  return readLocalData(PREFS_CACHE_KEY, PREFS_CACHE_VERSION, {}, decodePrefs);
}

/** 把一次成功写入服务端的 patch 追加进镜像（同键覆盖，未动的键保留）。 */
export function mergePrefsCache(patch: Partial<RcPreferences>): void {
  try {
    writeLocalData(PREFS_CACHE_KEY, PREFS_CACHE_VERSION, { ...loadPrefsCache(), ...patch });
  } catch {
    // 无痕模式或存储不可用时，服务端已经生效，镜像只是兜底，丢了不阻塞。
  }
}

function desktopPreferenceScope(): string {
  try {
    return localStorage.getItem('rcx-owner') || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

/** Tauri 应用数据目录中的镜像，跨 WebView 存储目录变化保留。 */
export async function loadNativePrefsCache(): Promise<Partial<RcPreferences>> {
  if (!isTauri) return {};
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const value = await invoke<unknown | null>('read_desktop_preferences', {
      scope: desktopPreferenceScope(),
    });
    return decodePrefs(value) ?? {};
  } catch {
    return {};
  }
}

export async function mergeNativePrefsCache(patch: Partial<RcPreferences>): Promise<void> {
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_desktop_preferences', {
      scope: desktopPreferenceScope(),
      patch,
    });
  } catch {
    // 原生镜像只是升级后的兜底，服务端写入成功时不能阻塞设置操作。
  }
}
