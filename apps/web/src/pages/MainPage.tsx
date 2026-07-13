import { useEffect } from 'react';
import { useChat } from '../stores/chat';
import { usePrefs } from '../stores/prefs';
import { useUI } from '../stores/ui';
import NavRail from '../components/NavRail';
import GroupFilter from '../components/GroupFilter';
import ConversationList from '../components/ConversationList';
import ChatArea from '../components/ChatArea';
import ModulePlaceholder from '../components/ModulePlaceholder';
import QuickSwitcher from '../components/QuickSwitcher';
import UploadConfirm from '../components/UploadConfirm';
import ContactsPage from './ContactsPage';
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

  useEffect(() => {
    void init();
    void loadPrefs(); // 侧栏/消息/通知偏好（服务端持久化，跨设备同步）
    // 申请桌面通知权限（用于非活跃会话的新消息提醒）
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission().catch(() => {});
    }
  }, [init, loadPrefs]);

  // 标题栏未读数（免打扰会话不计入）
  useEffect(() => {
    const total = Object.values(subscriptions).reduce(
      (n, s) => n + (s.disableNotifications ? 0 : s.unread || 0),
      0,
    );
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) RocketChat X` : 'RocketChat X';
  }, [subscriptions]);

  // 全局快捷键：Ctrl/Cmd+K 快速切换会话，Esc 关闭右侧面板
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSwitcher(!useUI.getState().switcherOpen);
      } else if (e.key === 'Escape') {
        const state = useChat.getState();
        if (state.rightPanel) state.setPanel(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full overflow-hidden bg-fill-2">
      <NavRail />
      {module === 'messages' ? (
        <>
          <GroupFilter />
          <ConversationList />
          <ChatArea />
        </>
      ) : module === 'contacts' ? (
        <ContactsPage />
      ) : module === 'workbench' ? (
        <WorkbenchPage />
      ) : module === 'settings' ? (
        <SettingsPage />
      ) : (
        <ModulePlaceholder module={module} />
      )}
      {(connection === 'reconnecting' || connection === 'connecting') && (
        <div className="fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-1.5 text-xs text-white shadow-lg">
          连接中，消息推送可能延迟…
        </div>
      )}
      {switcher && <QuickSwitcher onClose={() => setSwitcher(false)} />}
      <UploadConfirm />
    </div>
  );
}
