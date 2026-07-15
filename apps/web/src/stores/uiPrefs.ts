import { create } from 'zustand';

/**
 * 本机界面偏好（不走 RC 服务端 prefs——那是固定 schema，塞不进自定义键）。
 * 目前只有悬浮工具栏的触发延迟；以后本地性质的界面偏好都放这。
 */
const KEY = 'rcx-ui-prefs';

interface UiPrefsState {
  /** 鼠标停留多久才弹出消息悬浮工具栏（毫秒）。按 issue #18.4 的要求默认 3 秒 */
  hoverDelayMs: number;
  setHoverDelayMs: (ms: number) => void;
}

function load(): { hoverDelayMs?: number } {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as { hoverDelayMs?: number };
  } catch {
    return {};
  }
}

export const useUiPrefs = create<UiPrefsState>((set) => ({
  hoverDelayMs: load().hoverDelayMs ?? 3000,
  setHoverDelayMs: (ms) => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...load(), hoverDelayMs: ms }));
    } catch {
      /* 存储满/无痕 */
    }
    set({ hoverDelayMs: ms });
  },
}));
