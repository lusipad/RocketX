import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookUser,
  Blocks,
  Calendar,
  LayoutGrid,
  Keyboard,
  ListTodo,
  LogOut,
  MessageCircle,
  MessageCirclePlus,
  Plus,
  Search,
  Settings,
  Users,
  UsersRound,
} from 'lucide-react';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { isOverdue, todayKey, useTodos } from '../stores/todos';
import { useCalendar, eventsForDate, isEventDone } from '../stores/calendar';
import { useUI } from '../stores/ui';
import { kernelRegistry, useKernelContributions } from '../kernel/registry';
import Avatar from './Avatar';
import UserCard from './UserCard';
import { ConfirmDialog } from './Dialog';
import { CreateGroupDialog, StartDMDialog } from './NewChatDialogs';

const MODULE_META: Record<string, {
  label: string;
  icon: typeof MessageCircle;
}> = {
  messages: { label: '消息', icon: MessageCircle },
  todos: { label: '待办', icon: ListTodo },
  calendar: { label: '日历', icon: Calendar },
  contacts: { label: '通讯录', icon: BookUser },
  workbench: { label: '工作台', icon: LayoutGrid },
};

const PRIMARY_MODULE_IDS = new Set(['messages', 'today', 'todos', 'calendar']);
const WORK_MODULE_IDS = new Set(['workbench', 'contacts']);
const AI_MODULE_IDS = new Set(['ai-assistant']);
const HIDDEN_MODULE_IDS = new Set(['codex']);
const KNOWN_CORE_MODULE_IDS = new Set([
  ...PRIMARY_MODULE_IDS,
  ...WORK_MODULE_IDS,
  ...AI_MODULE_IDS,
  'codex',
]);

/** 飞书网页版式深色导航栏：头像 + 发起会话 + 全局搜索 + 模块列表 */
export default function NavRail({ onOpenShortcuts }: { onOpenShortcuts: () => void }) {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const subscriptions = useChat((s) => s.subscriptions);
  const active = useUI((s) => s.module);
  const setModule = useUI((s) => s.setModule);
  const setSwitcherOpen = useUI((s) => s.setSwitcherOpen);
  const registeredModules = useKernelContributions('nav.module');
  const modules = [
    { key: 'messages', owner: 'core', ...MODULE_META.messages },
    ...registeredModules.map((module) => ({
      key: module.id,
      owner: kernelRegistry.ownerOf('nav.module', module),
      label: module.label,
      icon: module.icon ?? MODULE_META[module.id]?.icon ?? Blocks,
    })),
  ];
  const visibleModules = modules.filter((module) => !HIDDEN_MODULE_IDS.has(module.key));
  const moduleGroups = [
    visibleModules.filter((module) => PRIMARY_MODULE_IDS.has(module.key)),
    visibleModules.filter((module) => WORK_MODULE_IDS.has(module.key)),
    visibleModules.filter((module) => AI_MODULE_IDS.has(module.key)),
    visibleModules.filter((module) => module.owner === 'core' && !KNOWN_CORE_MODULE_IDS.has(module.key)),
    visibleModules.filter((module) => module.owner !== 'core'),
  ].filter((group) => group.length > 0);
  const [plusMenu, setPlusMenu] = useState(false);
  const [dialog, setDialog] = useState<'dm' | 'group' | 'team' | null>(null);
  const [selfCard, setSelfCard] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const plusButtonRef = useRef<HTMLButtonElement>(null);

  const closeCreateDialog = () => {
    setDialog(null);
    requestAnimationFrame(() => plusButtonRef.current?.focus());
  };

  useEffect(() => {
    if (!plusMenu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setPlusMenu(false);
      plusButtonRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [plusMenu]);

  const todos = useTodos((s) => s.todos);
  const { todoOpen, todoOverdue } = useMemo(() => {
    const today = todayKey();
    return {
      todoOpen: todos.filter((t) => !t.done).length,
      todoOverdue: todos.filter((t) => isOverdue(t, today)).length,
    };
  }, [todos]);

  const calendarEvents = useCalendar((s) => s.events);
  /**
   * 日历角标 = 今天的日程 + 今天到期的待办。
   * 之前只数日程，而日历页面里明明把「今天到期的待办」也一起展示了 ——
   * 于是会出现「角标不显示，点进日历今天躺着 3 条待办」。同一件事三处口径不能不一样。
   */
  const todayEventCount = useMemo(() => {
    const today = todayKey();
    return (
      eventsForDate(calendarEvents, today).filter((e) => !isEventDone(e, today)).length +
      todos.filter((t) => !t.done && t.due === today).length
    );
  }, [calendarEvents, todos]);

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
    <nav className="flex w-[210px] shrink-0 flex-col border-r border-line bg-surface-1 px-3 py-3 text-ink">
      {/* 头像 + 发起会话 */}
      <div className="flex items-center justify-between px-1 pb-3">
        <button onClick={() => setSelfCard(true)} title="个人信息">
          <Avatar name={user?.name || user?.username || '?'} username={user?.username} size={34} />
        </button>
        <div className="relative">
          <button
            ref={plusButtonRef}
            onClick={() => setPlusMenu((v) => !v)}
            title="发起聊天 / 创建群组"
            aria-haspopup="menu"
            aria-expanded={plusMenu}
            className="flex h-8 w-8 items-center justify-center rounded-full text-ink-2 transition hover:bg-fill-hover hover:text-ink"
          >
            <Plus size={19} />
          </button>
          {plusMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setPlusMenu(false)} />
              <div role="menu" className="absolute left-0 z-30 mt-1 w-36 rounded-lg border border-line bg-surface-4 py-1 shadow-[0_4px_16px_rgba(31,35,41,0.16)]">
                <button
                  onClick={() => {
                    setPlusMenu(false);
                    setDialog('dm');
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-ink hover:bg-fill-hover"
                >
                  <MessageCirclePlus size={15} className="text-ink-2" />
                  发起聊天
                </button>
                <button
                  onClick={() => {
                    setPlusMenu(false);
                    setDialog('group');
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-ink hover:bg-fill-hover"
                >
                  <UsersRound size={15} className="text-ink-2" />
                  创建群组
                </button>
                <button
                  onClick={() => {
                    setPlusMenu(false);
                    setDialog('team');
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-ink hover:bg-fill-hover"
                >
                  <Users size={15} className="text-ink-2" />
                  创建团队
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* 全局搜索（打开 Ctrl+K 快速切换） */}
      <button
        onClick={() => setSwitcherOpen(true)}
        className="mb-3 flex h-8 items-center gap-2 rounded-md bg-surface-2 px-2.5 text-xs text-ink-3 transition hover:bg-fill-hover"
      >
        <Search size={14} />
        搜索 (Ctrl+K)
      </button>

      {/* 模块列表 */}
      <div className="flex flex-1 flex-col gap-0.5">
        {moduleGroups.map((group, groupIndex) => (
          <div
            key={group[0].key}
            className={groupIndex === 0 ? 'flex flex-col gap-0.5' : 'mt-2 flex flex-col gap-0.5 border-t border-line pt-2'}
          >
            {group.map(({ key, label, icon: Icon }) => {
              const isActive = key === active;
              return (
                <button
                  key={key}
                  onClick={() => setModule(key)}
                  className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm transition ${
                    isActive
                      ? 'bg-fill-active font-medium text-ink'
                      : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
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
                      <span className="ml-auto flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-danger px-1.5 text-2xs font-medium text-white">
                        {unreadTotal > 99 ? '99+' : unreadTotal}
                      </span>
                    ) : hasAlert ? (
                      <span className="ml-auto h-2 w-2 rounded-full bg-danger" />
                    ) : null)}
                  {/* 日历：今日日程数 */}
                  {key === 'calendar' && todayEventCount > 0 && (
                    <span className="ml-auto flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-fill-active px-1.5 text-2xs font-medium text-ink-2">
                      {todayEventCount}
                    </span>
                  )}
                  {/* 待办：有逾期就标红，否则灰色计数 */}
                  {key === 'todos' && todoOpen > 0 && (
                    <span
                      className={`ml-auto flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1.5 text-2xs font-medium ${
                        todoOverdue > 0 ? 'bg-danger text-white' : 'bg-fill-active text-ink-2'
                      }`}
                      title={todoOverdue > 0 ? `${todoOverdue} 条已逾期` : `${todoOpen} 条待办`}
                    >
                      {todoOpen > 99 ? '99+' : todoOpen}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* 底部 */}
      <div className="flex flex-col gap-0.5 border-t border-line pt-2">
        <button
          onClick={onOpenShortcuts}
          className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-ink"
        >
          <Keyboard size={15} />
          快捷键
        </button>
        <button
          onClick={() => setModule('settings')}
          className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-xs transition ${
            active === 'settings'
              ? 'bg-fill-active font-medium text-ink'
              : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
          }`}
        >
          <Settings size={15} />
          设置
        </button>
        <button
          onClick={() => setConfirmLogout(true)}
          className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-danger"
        >
          <LogOut size={15} />
          退出登录
        </button>
      </div>

      {confirmLogout && (
        <ConfirmDialog
          title="退出登录"
          message="退出后需要重新输入账号密码。未发送的草稿会保留在本机。"
          confirmLabel="退出"
          onConfirm={() => void logout()}
          onClose={() => setConfirmLogout(false)}
        />
      )}

      {dialog === 'dm' && <StartDMDialog onClose={closeCreateDialog} />}
      {(dialog === 'group' || dialog === 'team') && (
        <CreateGroupDialog kind={dialog} onClose={closeCreateDialog} />
      )}
      {selfCard && user && (
        <UserCard
          user={{ username: user.username, name: user.name, status: user.status }}
          onClose={() => setSelfCard(false)}
        />
      )}
    </nav>
  );
}
