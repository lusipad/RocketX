/**
 * 桌面通知：桌面端(Tauri)走 tauri-plugin-notification,浏览器走 Web Notification。
 *
 * 为什么要分叉:Tauri 的 WebView2 里 Web Notification API 常年被判 denied
 * （issue #4「系统通知显示已拒绝」），必须改走系统通知插件才弹得出来。
 */
import { isTauri } from './http';

export interface DesktopNotifyOptions {
  title: string;
  body: string;
  /** 浏览器端用于去重(同一条消息不重复弹);桌面端插件不支持,忽略 */
  tag?: string;
  /** 浏览器端点击回调；Windows 桌面端通过 rid 走原生导航事件 */
  onClick?: () => void;
  /** Windows 桌面端点击通知后打开的 Rocket.Chat 房间 */
  rid?: string;
  /** Windows 桌面端点击通知后定位的消息 */
  mid?: string;
}

export type NotifyPermissionStatus = 'granted' | 'denied' | 'unavailable';

/** WebView2 的 Notification.permission 可能恒为 denied，桌面端状态必须问原生插件。 */
async function tauriPermissionGranted(): Promise<boolean> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<boolean>('plugin:notification|is_permission_granted');
}

/** 申请通知权限并保留 denied/unavailable 等真实结果，供首次设置逐项展示。 */
export async function requestNotifyPermissionStatus(): Promise<NotifyPermissionStatus> {
  if (isTauri) {
    const { requestPermission } = await import(
      '@tauri-apps/plugin-notification'
    );
    if (await tauriPermissionGranted()) return 'granted';
    return (await requestPermission()) === 'granted' ? 'granted' : 'denied';
  }
  if (typeof Notification === 'undefined') return 'unavailable';
  if (Notification.permission !== 'default') return Notification.permission;
  return (await Notification.requestPermission()) === 'granted' ? 'granted' : 'denied';
}

/** 申请通知权限,返回是否已授权。桌面端和浏览器端各走各的通道 */
export async function requestNotifyPermission(): Promise<boolean> {
  return (await requestNotifyPermissionStatus()) === 'granted';
}

/** 当前是否已授权(设置页展示用) */
export async function notifyPermissionGranted(): Promise<boolean> {
  if (isTauri) {
    return tauriPermissionGranted();
  }
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

/** 弹一条桌面通知(已在调用方做完免打扰/仅@我等过滤) */
export async function desktopNotify(opts: DesktopNotifyOptions): Promise<boolean> {
  if (isTauri) {
    const { sendNotification } = await import(
      '@tauri-apps/plugin-notification'
    );
    if (!(await tauriPermissionGranted())) return false;
    if (opts.rid && opts.mid && typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)) {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('show_message_notification', {
        title: opts.title,
        body: opts.body,
        rid: opts.rid,
        mid: opts.mid,
      });
      return true;
    }
    sendNotification({ title: opts.title, body: opts.body });
    return true;
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  const n = new Notification(opts.title, { body: opts.body, tag: opts.tag });
  if (opts.onClick) {
    n.onclick = () => {
      opts.onClick!();
      n.close();
    };
  }
  return true;
}
