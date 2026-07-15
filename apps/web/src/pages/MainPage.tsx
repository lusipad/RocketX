import { useEffect, useRef } from 'react';
import { buildConversations, useChat } from '../stores/chat';
import { usePrefs } from '../stores/prefs';
import { type ModuleKey, useUI } from '../stores/ui';
import { requestNotifyPermission } from '../lib/notify';
import { clearTaskbarFlash, setTaskbarBadge } from '../lib/taskbar';
import NavRail from '../components/NavRail';
import GroupFilter from '../components/GroupFilter';
import ConversationList from '../components/ConversationList';
import ChatArea from '../components/ChatArea';
import QuickSwitcher from '../components/QuickSwitcher';
import UploadConfirm from '../components/UploadConfirm';
import Toaster from '../components/Toaster';
import ContactsPage from './ContactsPage';
import TodosPage from './TodosPage';
import CalendarPage from './CalendarPage';
import WorkbenchPage from './WorkbenchPage';
import SettingsPage from './SettingsPage';

export default function MainPage() {
  const init = useChat((s) => s.init);
  const connection = useChat((s) => s.connection);
  const subscriptions = useChat((s) => s.subscriptions);
  const module = useUI((s) => s.module);
  const switcher = useUI((s) => s.switcherOpen);
  const setSwitcher = useUI((s) => s.setSwitcherOpen);

  const loadPrefs = usePrefs((s) => s.load);
  const switcherTab = useRef<'messages' | undefined>(undefined);

  useEffect(() => {
    void init();
    void loadPrefs(); // 侧栏/消息/通知偏好（服务端持久化，跨设备同步）
    // 申请桌面通知权限（桌面端走系统通知插件，浏览器走 Web Notification）
    void requestNotifyPermission().catch(() => {});
  }, [init, loadPrefs]);

  // 用户点回窗口 → 停止任务栏闪烁（Windows 点开会自动停，macOS Dock 弹跳要手动清）
  useEffect(() => {
    const onFocus = () => void clearTaskbarFlash();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // 标题栏未读数 + 任务栏角标（免打扰会话不计入）。
  // 角标是群聊消息的次级提示主体：不弹窗，但任务栏图标上有数字（读完自动清）
  useEffect(() => {
    const total = Object.values(subscriptions).reduce(
      (n, s) => n + (s.disableNotifications ? 0 : s.unread || 0),
      0,
    );
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) RocketChat X` : 'RocketChat X';
    void setTaskbarBadge(total);
  }, [subscriptions]);

  // 全局快捷键
  useEffect(() => {
    const MODULES: ModuleKey[] = ['messages', 'todos', 'contacts', 'calendar', 'workbench', 'settings'];

    const switchConv = (delta: 1 | -1) => {
      const { subscriptions: subs, rooms: rms, activeRid } = useChat.getState();
      const list = buildConversations(subs, rms).sort((a, b) => b.lastTs - a.lastTs);
      if (!list.length) return;
      const idx = list.findIndex((c) => c.rid === activeRid);
      const next = list[Math.max(0, Math.min(list.length - 1, idx + delta))];
      if (next) useChat.getState().openRoom(next.rid);
    };

    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Ctrl+K 快速切换会话
      if (mod && key === 'k' && !e.shiftKey) { e.preventDefault(); switcherTab.current = undefined; setSwitcher(!useUI.getState().switcherOpen); return; }
      // Ctrl+Shift+F 全局搜索消息
      if (mod && e.shiftKey && key === 'f') { e.preventDefault(); switcherTab.current = 'messages'; setSwitcher(true); return; }
      // Ctrl+↑/↓ 上下切换会话
      if (mod && !e.shiftKey && e.key === 'ArrowUp') { e.preventDefault(); switchConv(-1); return; }
      if (mod && !e.shiftKey && e.key === 'ArrowDown') { e.preventDefault(); switchConv(1); return; }
      // Alt+↑/↓ 切换左侧模块
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const cur = MODULES.indexOf(useUI.getState().module);
        const next = e.key === 'ArrowUp' ? Math.max(0, cur - 1) : Math.min(MODULES.length - 1, cur + 1);
        useUI.getState().setModule(MODULES[next]);
        return;
      }
      // Alt+1~6 直接跳到指定模块
      if (e.altKey && !mod && key >= '1' && key <= '6') {
        e.preventDefault();
        useUI.getState().setModule(MODULES[Number(key) - 1]);
        return;
      }
      // Escape：优先退出多选（issue #19-2），其次关闭右侧面板。
      // 弹窗/灯箱等自己捕获 Esc 并 stopPropagation，不会走到这里。
      if (e.key === 'Escape') {
        const state = useChat.getState();
        if (state.selectMode) {
          state.exitSelectMode();
          return;
        }
        if (state.rightPanel) state.setPanel(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full min-h-[640px] min-w-[940px] overflow-hidden bg-fill-2">
      <NavRail />
      {module === 'messages' ? (
        <>
          <GroupFilter />
          <ConversationList />
          <ChatArea />
        </>
      ) : module === 'todos' ? (
        <TodosPage />
      ) : module === 'contacts' ? (
        <ContactsPage />
      ) : module === 'calendar' ? (
        <CalendarPage />
      ) : module === 'workbench' ? (
        <WorkbenchPage />
      ) : (
        <SettingsPage />
      )}
      {(connection === 'reconnecting' || connection === 'connecting') && (
        <div className="fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-1.5 text-xs text-white shadow-lg">
          连接中，消息推送可能延迟…
        </div>
      )}
      {switcher && <QuickSwitcher onClose={() => setSwitcher(false)} initialTab={switcherTab.current} />}
      <UploadConfirm />
      <Toaster />
    </div>
  );
}
