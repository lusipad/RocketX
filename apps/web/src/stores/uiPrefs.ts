import { create } from 'zustand';
import { normalizeUiScale, type UiScale } from '../lib/uiScale';

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
}

interface StoredUiPrefs {
  hoverDelayMs?: number;
  taskbarFlash?: boolean;
  uiScale?: unknown;
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
}));
