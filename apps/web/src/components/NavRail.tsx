import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookUser,
  Blocks,
  Bot,
  Calendar,
  Hash,
  LayoutGrid,
  Keyboard,
  ListTodo,
  LogIn,
  LogOut,
  MessageCircle,
  MessageCirclePlus,
  MessagesSquare,
  PanelLeft,
  Plus,
  Rocket,
  Search,
  Settings,
  Smile,
  Timer,
  Users,
  UsersRound,
} from 'lucide-react';
import { useI18n, type MessageKey } from '../i18n';
import { useAuth } from '../stores/auth';
import { useCommandUi } from '../stores/commandUi';
import { useChat } from '../stores/chat';
import { hasAiParticipantDrag, hasButlerShareDrag } from '../lib/butlerChatBridge';
import { isOverdue, todayKey, useTodos } from '../stores/todos';
import { useCalendar, eventsForDate, isEventDone } from '../stores/calendar';
import { useUI } from '../stores/ui';
import { useFocus } from '../stores/focus';
import { countsTowardUnread, totalUnread } from '../lib/unread';
import { kernelRegistry, useKernelContributions } from '../kernel/registry';
import Avatar from './Avatar';
import UserCard from './UserCard';
import { ConfirmDialog } from './Dialog';
import FocusDialog, { formatRemaining, useNow } from './FocusDialog';
import { CreateGroupDialog, StartDMDialog } from './NewChatDialogs';
import CreateRoomDiscussionDialog from './CreateRoomDiscussionDialog';

const CORE_MODULE_ICONS: Record<string, typeof MessageCircle> = {
  messages: MessageCircle,
  todos: ListTodo,
  calendar: Calendar,
  contacts: BookUser,
  workbench: LayoutGrid,
};

const CORE_MODULE_LABEL_KEYS: Record<string, MessageKey> = {
  messages: 'nav.module.messages',
  workbench: 'nav.module.workbench',
  'butler-view': 'nav.module.butlerView',
  todos: 'nav.module.todos',
  calendar: 'nav.module.calendar',
  downloads: 'nav.module.downloads',
  contacts: 'nav.module.contacts',
};

const PRIMARY_MODULE_IDS = new Set(['messages', 'todos', 'calendar', 'downloads']);
const BUTLER_MODULE_IDS = new Set(['butler-view']);
const WORK_MODULE_IDS = new Set(['workbench', 'contacts']);
const HIDDEN_MODULE_IDS = new Set<string>();
const KNOWN_CORE_MODULE_IDS = new Set([
  ...PRIMARY_MODULE_IDS,
  ...BUTLER_MODULE_IDS,
  ...WORK_MODULE_IDS,
]);

/** 飞书网页版式深色导航栏：头像 + 发起会话 + 全局搜索 + 模块列表（支持 60px 紧凑/210px 展开切换） */
export default function NavRail({ onOpenShortcuts }: { onOpenShortcuts: () => void }) {
  const { t, tp } = useI18n();
  const user = useAuth((s) => s.user);
  const localMode = useAuth((s) => s.localMode);
  const needsReauth = useAuth((s) => s.needsReauth);
  const exitLocalMode = useAuth((s) => s.exitLocalMode);
  const offlineAuthPrompt = localMode || needsReauth;
  const logout = useAuth((s) => s.logout);
  const subscriptions = useChat((s) => s.subscriptions);
  const active = useUI((s) => s.module);
  const setModule = useUI((s) => s.setModule);
  const setSwitcherOpen = useUI((s) => s.setSwitcherOpen);
  const navRailCollapsed = useUI((s) => s.navRailCollapsed);
  const toggleNavRailCollapsed = useUI((s) => s.toggleNavRailCollapsed);

  const registeredModules = useKernelContributions('nav.module');
  const resolveModuleLabel = (id: string, owner: string | undefined, fallback: string): string => {
    if (owner === 'core') {
      const labelKey = CORE_MODULE_LABEL_KEYS[id];
      if (labelKey) return t(labelKey);
    }
    return fallback;
  };
  const modules = [
    {
      key: 'messages',
      owner: 'core',
      label: t(CORE_MODULE_LABEL_KEYS.messages),
      icon: CORE_MODULE_ICONS.messages,
    },
    ...registeredModules.map((module) => {
      const owner = kernelRegistry.ownerOf('nav.module', module);
      return {
        key: module.id,
        owner,
        label: resolveModuleLabel(module.id, owner, module.label),
        icon: module.icon ?? CORE_MODULE_ICONS[module.id] ?? Blocks,
      };
    }),
  ];
  const visibleModules = modules.filter((module) => {
    if (HIDDEN_MODULE_IDS.has(module.key)) return false;
    if (localMode && (module.key === 'messages' || module.key === 'contacts')) return false;
    if (needsReauth && module.key === 'contacts') return false;
    return true;
  });
  const moduleSections = [
    {
      id: 'primary',
      ariaLabel: t('nav.section.primary'),
      modules: visibleModules.filter((module) => PRIMARY_MODULE_IDS.has(module.key)),
    },
    {
      id: 'butler',
      ariaLabel: t('nav.section.butler'),
      modules: visibleModules.filter((module) => BUTLER_MODULE_IDS.has(module.key)),
    },
    {
      id: 'work',
      ariaLabel: t('nav.section.work'),
      modules: visibleModules.filter((module) => WORK_MODULE_IDS.has(module.key)),
    },
    {
      id: 'core',
      ariaLabel: t('nav.section.otherTools'),
      modules: visibleModules.filter((module) => module.owner === 'core' && !KNOWN_CORE_MODULE_IDS.has(module.key)),
    },
    {
      id: 'apps',
      ariaLabel: t('nav.section.apps'),
      modules: visibleModules.filter((module) => module.owner !== 'core'),
    },
  ].filter((section) => section.modules.length > 0);
  const displaySections = localMode
    ? [
        ...moduleSections.filter((sec) => sec.id === 'butler'),
        ...moduleSections.filter((sec) => sec.id !== 'butler'),
      ]
    : moduleSections;
  const [plusMenu, setPlusMenu] = useState(false);
  const [dialog, setDialog] = useState<'dm' | 'group' | 'team' | 'discussion' | 'ai-discussion' | null>(null);
  const [selfCard, setSelfCard] = useState(false);
  // 专注模式一级入口（daily-loop 规格 v1）
  const [focusDialog, setFocusDialog] = useState(false);
  const focusSession = useFocus((s) => s.session);
  const discussionsEnabled = useChat((s) => s.discussionsEnabled);
  const focusNow = useNow(!!focusSession);
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
  const todayEventCount = useMemo(() => {
    const today = todayKey();
    return (
      eventsForDate(calendarEvents, today).filter((e) => !isEventDone(e, today)).length +
      todos.filter((t) => !t.done && t.due === today).length
    );
  }, [calendarEvents, todos]);

  const { unreadTotal, hasAlert } = useMemo(
    () => ({
      unreadTotal: totalUnread(subscriptions),
      hasAlert: Object.values(subscriptions).some((s) => countsTowardUnread(s) && s.alert),
    }),
    [subscriptions],
  );

  const [localExpanded, setLocalExpanded] = useState(false);
  const messagesDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (messagesDragTimerRef.current) clearTimeout(messagesDragTimerRef.current);
  }, []);
  const isCollapsed = localMode ? !localExpanded : navRailCollapsed;
  const toggleCollapse = () => {
    if (localMode) {
      setLocalExpanded((v) => !v);
    } else {
      toggleNavRailCollapsed();
    }
  };

  const plusMenuPopup = plusMenu ? (
    <>
      <div className="fixed inset-0 z-20" onClick={() => setPlusMenu(false)} />
      <div role="menu" className="absolute left-0 z-30 mt-1.5 w-38 rounded-xl border border-line bg-surface-4 py-1.5 shadow-pop">
        <button
          onClick={() => {
            setPlusMenu(false);
            setDialog('dm');
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-ink hover:bg-fill-hover"
        >
          <MessageCirclePlus size={14} className="text-ink-2" />
          {t('nav.plus.newChat')}
        </button>
        <button
          onClick={() => {
            setPlusMenu(false);
            setDialog('group');
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-ink hover:bg-fill-hover"
        >
          <UsersRound size={14} className="text-ink-2" />
          {t('nav.plus.createGroup')}
        </button>
        <button
          onClick={() => {
            setPlusMenu(false);
            setDialog('team');
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-ink hover:bg-fill-hover"
        >
          <Users size={14} className="text-ink-2" />
          {t('nav.plus.createTeam')}
        </button>
        {/* Rocket.Chat 允许不选消息直接开讨论；服务端关掉讨论后不给入口 */}
        {discussionsEnabled && (
          <button
            onClick={() => {
              setPlusMenu(false);
              setDialog('discussion');
            }}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-ink hover:bg-fill-hover"
          >
            <MessagesSquare size={14} className="text-ink-2" />
            {t('nav.plus.createDiscussion')}
          </button>
        )}
        {discussionsEnabled && (
          <button
            onClick={() => {
              setPlusMenu(false);
              setDialog('ai-discussion');
            }}
            className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-primary hover:bg-primary-light/60"
          >
            <Bot size={14} className="text-primary" />
            {t('nav.plus.createAiDiscussion')}
          </button>
        )}
        <div className="my-1 h-px bg-line" />
        <button
          onClick={() => {
            setPlusMenu(false);
            useCommandUi.getState().open({ kind: 'join', prefill: '' });
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-ink hover:bg-fill-hover"
        >
          <Hash size={14} className="text-ink-2" />
          {t('nav.plus.joinChannel')}
        </button>
        <button
          onClick={() => {
            setPlusMenu(false);
            useCommandUi.getState().open({ kind: 'status', prefill: '' });
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs text-ink hover:bg-fill-hover"
        >
          <Smile size={14} className="text-ink-2" />
          {t('nav.plus.setStatus')}
        </button>
      </div>
    </>
  ) : null;

  return (
    <nav
      aria-label={t('nav.rail.ariaLabel')}
      className={`flex ${isCollapsed ? 'w-[56px] px-2' : 'w-[208px] px-2.5'} shrink-0 flex-col border-r border-line bg-surface-1 pb-3 text-ink transition-[width,padding] duration-150`}
    >
      {/* 头像 + 发起会话 */}
      <div className={`flex h-[52px] shrink-0 items-center ${isCollapsed ? 'justify-center' : 'justify-between gap-1.5 px-0.5'} border-b border-line-soft mb-2`}>
        <button
          onClick={() => (localMode ? setModule('settings') : setSelfCard(true))}
          title={localMode ? t('nav.rail.localModeProfileTitle') : (user?.name || user?.username || t('nav.rail.profile'))}
          className={`flex min-w-0 items-center rounded-xl transition hover:bg-fill-hover ${isCollapsed ? 'h-9 w-9 justify-center' : 'flex-1 gap-2.5 p-1'}`}
        >
          <div className="relative shrink-0">
            {localMode ? (
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-line-strong bg-surface-4 text-ink">
                <Rocket size={15} strokeWidth={2} aria-hidden="true" />
              </div>
            ) : (
              <Avatar
                name={user?.name || user?.username || '?'}
                username={user?.username}
                size={32}
                status={user?.status === 'online' ? undefined : user?.status}
              />
            )}
            {localMode ? (
              <span className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-surface-1">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" title={t('nav.rail.localWorkspaceReady')} />
              </span>
            ) : null}
          </div>
          {!isCollapsed && (
            localMode ? (
              <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-2xs font-semibold text-emerald-500">{t('nav.rail.localMode')}</span>
            ) : (
              <span className="min-w-0 truncate text-left text-xs font-medium text-ink">
                {user?.name || user?.username || t('nav.rail.signedIn')}
              </span>
            )
          )}
        </button>
        {!localMode && !isCollapsed ? (
          <div className="relative shrink-0">
            <button
              ref={plusButtonRef}
              onClick={() => {
                setPlusMenu((v) => !v);
              }}
              title={t('nav.rail.newChatOrGroup')}
              aria-haspopup="menu"
              aria-expanded={plusMenu}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 transition hover:bg-fill-hover hover:text-ink"
            >
              <Plus size={16} />
            </button>
            {plusMenuPopup}
          </div>
        ) : null}
      </div>

      {!localMode && isCollapsed ? (
        <div className="relative mb-1 flex justify-center shrink-0">
          <button
            ref={plusButtonRef}
            onClick={() => {
              setPlusMenu((v) => !v);
            }}
            title={t('nav.rail.newChatOrGroup')}
            aria-haspopup="menu"
            aria-expanded={plusMenu}
            className="mx-auto flex h-9 w-9 items-center justify-center rounded-xl text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            <Plus size={17} />
          </button>
          {plusMenuPopup}
        </div>
      ) : null}

      {/* 全局搜索（打开 Ctrl+K 快速切换） */}
      <button
        onClick={() => setSwitcherOpen(true)}
        title={t('nav.rail.searchTitle')}
        className={isCollapsed
          ? 'mx-auto mb-1 flex h-9 w-9 items-center justify-center rounded-xl text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink'
          : 'mb-1.5 flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 text-xs text-ink-3 transition hover:border-line-hover hover:text-ink-2'}
      >
        <Search size={isCollapsed ? 17 : 14} className="shrink-0" />
        {!isCollapsed ? (
          <>
            <span>{t('common.search')}</span>
            <kbd className="ml-auto rounded border border-line bg-surface-3 px-1.5 py-0.5 font-sans text-2xs font-medium text-ink-3">Ctrl+K</kbd>
          </>
        ) : null}
      </button>

      {/* 专注模式入口：进行中显示倒计时（daily-loop 规格 v1） */}
      <button
        onClick={() => setFocusDialog(true)}
        title={focusSession ? t('nav.rail.focusing', { remaining: formatRemaining(focusSession.endsAt, focusNow) }) : t('nav.rail.focusMode')}
        className={isCollapsed
          ? `mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
              focusSession
                ? 'bg-primary-light text-primary'
                : 'text-ink-3 hover:bg-fill-hover hover:text-ink'
            }`
          : `mb-2 flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-xs transition-colors ${
              focusSession
                ? 'bg-primary-light font-medium text-primary'
                : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
            }`}
      >
        <Timer size={isCollapsed ? 17 : 15} className="shrink-0" />
        {!isCollapsed ? (focusSession ? t('nav.rail.focusing', { remaining: formatRemaining(focusSession.endsAt, focusNow) }) : t('nav.rail.focus')) : null}
      </button>

      {/* 模块列表 */}
      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden">
        {displaySections.map((section, sectionIndex) => (
          <section
            key={section.id}
            aria-label={section.ariaLabel}
            className={sectionIndex === 0 ? 'flex flex-col gap-1' : 'mt-2 flex flex-col gap-1 border-t border-line-soft pt-2'}
          >
            {section.modules.map(({ key, label, icon: Icon }) => {
              const isActive = key === active;
              const hasBadge = (key === 'messages' && (unreadTotal > 0 || hasAlert))
                || (key === 'calendar' && todayEventCount > 0)
                || (key === 'todos' && todoOpen > 0);

              return (
                <button
                  key={key}
                  onClick={() => setModule(key)}
                  onDragOver={(e) => {
                    if (key !== 'messages' || (!hasButlerShareDrag(e.dataTransfer) && !hasAiParticipantDrag(e.dataTransfer))) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                    if (!messagesDragTimerRef.current && active !== 'messages') {
                      messagesDragTimerRef.current = setTimeout(() => {
                        messagesDragTimerRef.current = null;
                        setModule('messages');
                      }, 350);
                    }
                  }}
                  onDragLeave={() => {
                    if (key === 'messages' && messagesDragTimerRef.current) {
                      clearTimeout(messagesDragTimerRef.current);
                      messagesDragTimerRef.current = null;
                    }
                  }}
                  title={label}
                  className={isCollapsed
                    ? `relative mx-auto flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
                        isActive
                          ? 'bg-fill-active text-ink'
                          : 'text-ink-3 hover:bg-fill-hover hover:text-ink'
                      }`
                    : `relative flex h-8.5 w-full items-center gap-2.5 rounded-lg px-2.5 text-xs transition-colors ${
                        isActive
                          ? 'bg-fill-active font-medium text-ink'
                          : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
                      }`}
                >
                  {isActive ? (
                    <span
                      aria-hidden="true"
                      className={`absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-primary ${
                        isCollapsed ? '-left-2' : 'left-0'
                      }`}
                    />
                  ) : null}
                  {isCollapsed ? (
                    <Icon size={18} strokeWidth={isActive ? 2.1 : 1.8} />
                  ) : (
                    <>
                      <Icon size={16} className={isActive ? 'shrink-0 text-primary' : 'shrink-0 text-ink-3'} />
                      <span className="truncate">{label}</span>
                    </>
                  )}

                  {/* 展开态：右侧完整 Badge */}
                  {!isCollapsed && key === 'messages' && (
                    unreadTotal > 0 ? (
                      <span className="ml-auto flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-danger px-1.5 text-2xs font-medium text-white">
                        {unreadTotal > 99 ? '99+' : unreadTotal}
                      </span>
                    ) : hasAlert ? (
                      <span className="ml-auto h-2 w-2 rounded-full bg-danger" />
                    ) : null
                  )}
                  {!isCollapsed && key === 'calendar' && todayEventCount > 0 && (
                    <span className="ml-auto flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-fill-active px-1.5 text-2xs font-medium text-ink-2">
                      {todayEventCount}
                    </span>
                  )}
                  {!isCollapsed && key === 'todos' && todoOpen > 0 && (
                    <span
                      className={`ml-auto flex h-4.5 min-w-4.5 items-center justify-center rounded-full px-1.5 text-2xs font-medium ${
                        todoOverdue > 0 ? 'bg-danger text-white' : 'bg-fill-active text-ink-2'
                      }`}
                      title={
                        todoOverdue > 0
                          ? tp(todoOverdue, 'nav.rail.todosOverdueOne', 'nav.rail.todosOverdueOther')
                          : tp(todoOpen, 'nav.rail.todosOpenOne', 'nav.rail.todosOpenOther')
                      }
                    >
                      {todoOpen > 99 ? '99+' : todoOpen}
                    </span>
                  )}

                  {/* 折叠态：右上角微型红点或角标 */}
                  {isCollapsed && hasBadge && (
                    <span className="absolute top-1.5 right-1.5 flex h-2 w-2 rounded-full bg-danger" />
                  )}
                </button>
              );
            })}
          </section>
        ))}
      </div>

      {/* 底部功能栏 */}
      <div className="flex flex-col gap-1 border-t border-line-soft pt-2.5">
        <button
          onClick={onOpenShortcuts}
          title={t('nav.rail.shortcuts')}
          className={isCollapsed
            ? 'mx-auto flex h-9 w-9 items-center justify-center rounded-xl text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink'
            : 'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-xs text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink'}
        >
          <Keyboard size={isCollapsed ? 17 : 15} />
          {!isCollapsed ? t('nav.rail.shortcuts') : null}
        </button>
        <button
          onClick={() => setModule('settings')}
          title={t('nav.rail.settings')}
          className={isCollapsed
            ? `mx-auto flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
                active === 'settings'
                  ? 'bg-fill-active text-ink'
                  : 'text-ink-3 hover:bg-fill-hover hover:text-ink'
              }`
            : `flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-xs transition-colors ${
                active === 'settings'
                  ? 'bg-fill-active font-medium text-ink'
                  : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
              }`}
        >
          <Settings size={isCollapsed ? 17 : 15} />
          {!isCollapsed ? t('nav.rail.settings') : null}
        </button>
        <button
          onClick={() => (offlineAuthPrompt ? void exitLocalMode() : setConfirmLogout(true))}
          title={offlineAuthPrompt ? t('nav.rail.connectRocketChat') : t('nav.rail.logout')}
          className={isCollapsed
            ? `mx-auto flex h-9 w-9 items-center justify-center rounded-xl transition-colors ${
                offlineAuthPrompt ? 'text-ink-2 hover:bg-fill-hover hover:text-primary' : 'text-ink-3 hover:bg-fill-hover hover:text-danger'
              }`
            : `flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-xs transition-colors ${
                offlineAuthPrompt ? 'font-medium text-ink-2 hover:bg-fill-hover hover:text-primary' : 'text-ink-2 hover:bg-fill-hover hover:text-danger'
              }`}
        >
          {offlineAuthPrompt ? <LogIn size={isCollapsed ? 17 : 15} /> : <LogOut size={isCollapsed ? 17 : 15} />}
          {!isCollapsed ? (offlineAuthPrompt ? t('nav.rail.connectRocketChat') : t('nav.rail.logout')) : null}
        </button>

        {/* 展开/折叠切换按钮 */}
        <button
          type="button"
          onClick={toggleCollapse}
          title={isCollapsed ? t('nav.rail.expand') : t('nav.rail.collapse')}
          aria-label={isCollapsed ? t('nav.rail.expand') : t('nav.rail.collapse')}
          className={isCollapsed
            ? 'mx-auto flex h-9 w-9 items-center justify-center rounded-xl text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink'
            : 'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-xs text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink'}
        >
          <PanelLeft size={isCollapsed ? 17 : 15} />
          {!isCollapsed ? <span>{t('nav.rail.collapseShort')}</span> : null}
        </button>
      </div>

      {confirmLogout && (
        <ConfirmDialog
          title={t('nav.rail.logout')}
          message={t('nav.rail.logoutConfirmMessage')}
          confirmLabel={t('nav.rail.logoutConfirmAction')}
          onConfirm={() => void logout()}
          onClose={() => setConfirmLogout(false)}
        />
      )}

      {dialog === 'dm' && <StartDMDialog onClose={closeCreateDialog} />}
      {(dialog === 'group' || dialog === 'team') && (
        <CreateGroupDialog kind={dialog} onClose={closeCreateDialog} />
      )}
      {dialog === 'discussion' && <CreateRoomDiscussionDialog onClose={closeCreateDialog} />}
      {dialog === 'ai-discussion' && <CreateRoomDiscussionDialog defaultAi onClose={closeCreateDialog} />}
      {focusDialog && <FocusDialog onClose={() => setFocusDialog(false)} />}
      {selfCard && user && (
        <UserCard
          user={{ username: user.username, name: user.name, status: user.status }}
          onClose={() => setSelfCard(false)}
        />
      )}
    </nav>
  );
}
