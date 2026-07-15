/**
 * 任务栏提醒：闪烁 + 未读角标。只在桌面端(Tauri)有效，浏览器端由标题栏 (N) 前缀充当角标。
 *
 * 提醒模型对标飞书/微信：会弹通知的消息才闪任务栏（一级提醒）；
 * 免打扰会话的消息只有未读角标（次级提示，见 setTaskbarBadge）。
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

/** Windows 覆盖图标用：画一个红底白字的数字圆徽 */
function drawBadge(text: string): ImageData {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f54a45';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${text.length >= 3 ? 14 : text.length === 2 ? 17 : 20}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 1);
  return ctx.getImageData(0, 0, size, size);
}

/**
 * 任务栏未读角标（次级提示的主体）：0 清除。
 * macOS/Linux 走原生 setBadgeCount；Windows 任务栏没有原生数字角标，
 * 用 setOverlayIcon 画一个红色数字圆徽盖在图标右下角（Slack/Teams 同款做法）。
 */
export async function setTaskbarBadge(count: number): Promise<void> {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    if (navigator.userAgent.includes('Windows')) {
      if (count <= 0) {
        await w.setOverlayIcon(undefined);
        return;
      }
      const { Image } = await import('@tauri-apps/api/image');
      const img = drawBadge(count > 99 ? '99+' : String(count));
      await w.setOverlayIcon(await Image.new(new Uint8Array(img.data.buffer), img.width, img.height));
    } else {
      await w.setBadgeCount(count > 0 ? count : undefined);
    }
  } catch {
    /* 权限不足 / 平台不支持时静默（角标是锦上添花，不该报错打扰） */
  }
}
