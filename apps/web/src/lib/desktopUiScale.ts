import { isTauri } from './http';
import type { UiScale } from './uiScale';

/** 调整原生 WebView；浏览器构建保持自己的缩放语义。 */
export async function applyDesktopUiScale(scale: UiScale): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().setZoom(scale / 100);
}
