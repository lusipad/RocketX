/**
 * 任务栏图标闪烁：有新消息且窗口不在前台时，闪任务栏图标提醒（issue：未读闪烁）。
 * 只在桌面端(Tauri)有效，走 requestUserAttention;浏览器端无此能力，静默跳过。
 */
import { isTauri } from './http';

/** 新消息到达、窗口不在前台时闪任务栏(Windows 持续闪到用户点开;macOS 弹跳 Dock) */
export async function flashTaskbar(): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    // 已经在看着了就别闪
    if (await w.isFocused()) return;
    await w.requestUserAttention(UserAttentionType.Critical);
  } catch {
    /* 权限不足 / 平台不支持时静默 */
  }
}

/** 窗口重新聚焦时停止闪烁 */
export async function clearTaskbarFlash(): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().requestUserAttention(null);
  } catch {
    /* 静默 */
  }
}
