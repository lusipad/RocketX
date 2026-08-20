import { create } from 'zustand';
import { normalizeUiScale, type UiScale } from '../lib/uiScale';
import { normalizeLanFileMinBytes } from '../lan/routing';

/**
 * 本机界面偏好（不走 RC 服务端 prefs——那是固定 schema，塞不进自定义键）。
 * 只保存设备本地的界面偏好，不跟随账号同步。
 */
const KEY = 'rcx-ui-prefs';

interface UiPrefsState {
  /** 鼠标停留多久才弹出消息悬浮工具栏（毫秒）。issue #19-4 要求从 3 秒改为默认 2 秒 */
  hoverDelayMs: number;
  setHoverDelayMs: (ms: number) => void;
  /** Windows 任务栏是否持续闪烁；与托盘图标闪烁分开控制。 */
  taskbarFlash: boolean;
  setTaskbarFlash: (enabled: boolean) => void;
  /** 桌面端原生界面缩放；只允许固定六档，设备本地保存。 */
  uiScale: UiScale;
  setUiScale: (scale: UiScale) => void;
  /** 达到该大小的文件才尝试局域网 P2P 直传（字节）；0 表示任何大小都尝试。 */
  lanFileMinBytes: number;
  setLanFileMinBytes: (bytes: number) => void;
  /** 首次 P2P 直传成功后已做过一次性说明。 */
  lanP2pExplained: boolean;
  markLanP2pExplained: () => void;
}

interface StoredUiPrefs {
  hoverDelayMs?: number;
  taskbarFlash?: boolean;
  uiScale?: unknown;
  lanFileMinBytes?: unknown;
  lanP2pExplained?: boolean;
}

function load(): StoredUiPrefs {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as StoredUiPrefs;
  } catch {
    return {};
  }
}

function save(next: StoredUiPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 存储满/无痕 */
  }
}

const initial = load();

export const useUiPrefs = create<UiPrefsState>((set) => ({
  hoverDelayMs: initial.hoverDelayMs ?? 2000,
  taskbarFlash: initial.taskbarFlash ?? true,
  uiScale: normalizeUiScale(initial.uiScale),
  lanFileMinBytes: normalizeLanFileMinBytes(initial.lanFileMinBytes),
  lanP2pExplained: initial.lanP2pExplained ?? false,
  setHoverDelayMs: (ms) => {
    save({ ...load(), hoverDelayMs: ms });
    set({ hoverDelayMs: ms });
  },
  setTaskbarFlash: (enabled) => {
    save({ ...load(), taskbarFlash: enabled });
    set({ taskbarFlash: enabled });
  },
  setUiScale: (scale) => {
    save({ ...load(), uiScale: normalizeUiScale(scale) });
    set({ uiScale: normalizeUiScale(scale) });
  },
  setLanFileMinBytes: (bytes) => {
    const normalized = normalizeLanFileMinBytes(bytes);
    save({ ...load(), lanFileMinBytes: normalized });
    set({ lanFileMinBytes: normalized });
  },
  markLanP2pExplained: () => {
    save({ ...load(), lanP2pExplained: true });
    set({ lanP2pExplained: true });
  },
}));
