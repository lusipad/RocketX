import { useMemo, useState } from 'react';
import {
  BookUser,
  Calendar,
  FileText,
  LayoutGrid,
  LogOut,
  MessageCircle,
  MessageCirclePlus,
  Plus,
  Search,
  Settings,
  UsersRound,
  Video,
} from 'lucide-react';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { useUI, type ModuleKey } from '../stores/ui';
import Avatar from './Avatar';
import UserCard from './UserCard';
import { CreateGroupDialog, StartDMDialog } from './NewChatDialogs';

const MODULES: { key: ModuleKey; label: string; icon: typeof MessageCircle }[] = [
  { key: 'messages', label: '消息', icon: MessageCircle },
  { key: 'meetings', label: '会议', icon: Video },
  { key: 'calendar', label: '日历', icon: Calendar },
  { key: 'docs', label: '云文档', icon: FileText },
  { key: 'contacts', label: '通讯录', icon: BookUser },
  { key: 'workbench', label: '工作台', icon: LayoutGrid },
];

/** 飞书网页版式深色导航栏：头像 + 发起会话 + 全局搜索 + 模块列表 */
export default function NavRail() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const subscriptions = useChat((s) => s.subscriptions);
  const active = useUI((s) => s.module);
  const setModule = useUI((s) => s.setModule);
  const setSwitcherOpen = useUI((s) => s.setSwitcherOpen);
  const [plusMenu, setPlusMenu] = useState(false);
  const [dialog, setDialog] = useState<'dm' | 'group' | null>(null);
  const [selfCard, setSelfCard] = useState(false);

  // 消息模块角标：@/私聊未读总数，否则有新消息显示红点（免打扰会话不计入）
  const { unreadTotal, hasAlert } = useMemo(() => {
    let unreadTotal = 0;
    let hasAlert = false;
    for (const s of Object.values(subscriptions)) {
      if (s.open === false || s.disableNotifications) continue;
      unreadTotal += s.unread || 0;
      if (s.alert) hasAlert = true;
    }
    return { unreadTotal, hasAlert };
  }, [subscriptions]);

  return (
    <nav className="flex w-[210px] shrink-0 flex-col bg-dark-1 px-3 py-3 text-dark-ink">
      {/* 头像 + 发起会话 */}
      <div className="flex items-center justify-between px-1 pb-3">
        <button onClick={() => setSelfCard(true)} title="个人信息">
          <Avatar name={user?.name || user?.username || '?'} username={user?.username} size={34} />
        </button>
        <div className="relative">
          <button
            onClick={() => setPlusMenu((v) => !v)}
            title="发起会话"
            className="flex h-8 w-8 items-center justify-center rounded-full text-dark-ink-2 transition hover:bg-dark-hover hover:text-dark-ink"
          >
            <Plus size={19} />
          </button>
          {plusMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setPlusMenu(false)} />
              <div className="absolute left-0 z-30 mt-1 w-36 rounded-lg border border-line bg-white py-1 shadow-[0_4px_16px_rgba(31,35,41,0.16)]">
                <button
                  onClick={() => {
                    setPlusMenu(false);
                    setDialog('dm');
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-ink hover:bg-fill-hover"
                >
                  <MessageCirclePlus size={15} className="text-ink-2" />
                  发起私聊
                </button>
                <button
                  onClick={() => {
                    setPlusMenu(false);
                    setDialog('group');
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-ink hover:bg-fill-hover"
                >
                  <UsersRound size={15} className="text-ink-2" />
                  创建群组
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 全局搜索（打开 Ctrl+K 快速切换） */}
      <button
        onClick={() => setSwitcherOpen(true)}
        className="mb-3 flex h-8 items-center gap-2 rounded-md bg-dark-3 px-2.5 text-[13px] text-dark-ink-3 transition hover:bg-dark-hover"
      >
        <Search size={14} />
        搜索 (Ctrl+K)
      </button>

      {/* 模块列表 */}
      <div className="flex flex-1 flex-col gap-0.5">
        {MODULES.map(({ key, label, icon: Icon }) => {
          const isActive = key === active;
          return (
            <button
              key={key}
              onClick={() => setModule(key)}
              className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] transition ${
                isActive
                  ? 'bg-dark-active font-medium text-white'
                  : 'text-dark-ink-2 hover:bg-dark-hover hover:text-dark-ink'
              }`}
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-md ${
                  isActive ? 'bg-primary text-white' : ''
                }`}
              >
                <Icon size={isActive ? 15 : 17} />
              </span>
              {label}
              {key === 'messages' &&
                (unreadTotal > 0 ? (
                  <span className="ml-auto flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-medium text-white">
                    {unreadTotal > 99 ? '99+' : unreadTotal}
                  </span>
                ) : hasAlert ? (
                  <span className="ml-auto h-2 w-2 rounded-full bg-danger" />
                ) : null)}
            </button>
          );
        })}
      </div>

      {/* 底部 */}
      <div className="flex flex-col gap-0.5 border-t border-dark-line pt-2">
        <button
          onClick={() => setModule('settings')}
          className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition ${
            active === 'settings'
              ? 'bg-dark-active font-medium text-white'
              : 'text-dark-ink-2 hover:bg-dark-hover hover:text-dark-ink'
          }`}
        >
          <Settings size={15} />
          设置
        </button>
        <button
          onClick={() => void logout()}
          className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-dark-ink-2 transition hover:bg-dark-hover hover:text-danger"
        >
          <LogOut size={15} />
          退出登录
        </button>
      </div>

      {dialog === 'dm' && <StartDMDialog onClose={() => setDialog(null)} />}
      {dialog === 'group' && <CreateGroupDialog onClose={() => setDialog(null)} />}
      {selfCard && user && (
        <UserCard
          user={{ username: user.username, name: user.name, status: user.status }}
          onClose={() => setSelfCard(false)}
        />
      )}
    </nav>
  );
}
