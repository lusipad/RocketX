import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { buildConversations, useChat } from '../stores/chat';
import { usePrefs } from '../stores/prefs';
import { useUI } from '../stores/ui';
import { kernelRegistry, useKernelContributions } from '../kernel/registry';
import { useFolders } from '../stores/folders';
import { clearTaskbarFlash, setTaskbarBadge } from '../lib/taskbar';
import { shortcutKeyOf } from '../lib/shortcutKey';
import {
  clearTrayAttention,
  formatTrayTooltip,
  hasTrayAttention,
  restoreTrayAttention,
  setTrayAttention,
  setTrayTooltip,
} from '../lib/tray';
import NavRail from '../components/NavRail';
import GroupFilter from '../components/GroupFilter';
import ConversationList from '../components/ConversationList';
import ChatArea from '../components/ChatArea';
import QuickSwitcher from '../components/QuickSwitcher';
import UploadConfirm from '../components/UploadConfirm';
import SettingsPage from './SettingsPage';
import { StartDMDialog } from '../components/NewChatDialogs';
import { useImLayout } from '../stores/imLayout';
import {
  MAX_CONVERSATION_WIDTH,
  MIN_CONVERSATION_WIDTH,
  clampConversationWidth,
} from '../lib/imLayout';
import {
  adjacentConversation,
  buildConversationView,
  flattenConversationView,
  nextUnreadConversation,
} from '../lib/conversationView';
import ShortcutHelpDialog from '../components/ShortcutHelpDialog';
import { useAuth } from '../stores/auth';
import { useNotificationAggregation } from '../stores/notificationAggregation';
import { desktopNotify } from '../lib/notify';
import {
  initialGroupFilterPanelState,
  nextGroupFilterPanelState,
} from '../lib/groupFilterPanel';
import {
  COMPACT_CONVERSATION_WIDTH,
  effectiveConversationWidth,
} from '../lib/conversationPanelLayout';
import { useCodexRuntime } from '../stores/codexRuntime';
import { useToday } from '../stores/today';

const NARROW_LAYOUT_WIDTH = 1180;
const MIN_CHAT_WIDTH = 420;
const NAV_WIDTH = 210;
const GROUP_WIDTH = 150;
const COLLAPSED_GROUP_WIDTH = 48;
const RESIZER_WIDTH = 6;

export default function MainPage() {
  const init = useChat((s) => s.init);
  const connection = useChat((s) => s.connection);
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const rightPanel = useChat((s) => s.rightPanel);
  const rightPanelOpen = rightPanel !== null;
  const butlerPanelOpen = rightPanel?.kind === 'butler';
  const module = useUI((s) => s.module);
  const registeredModules = useKernelContributions('nav.module');
  const switcher = useUI((s) => s.switcherOpen);
  const switcherCommandCenter = useUI((s) => s.switcherCommandCenter);
  const setSwitcher = useUI((s) => s.setSwitcherOpen);
  const userId = useAuth((s) => s.user?._id);

  const loadPrefs = usePrefs((s) => s.load);
  const unreadAlert = usePrefs((s) => s.prefs.unreadAlert);
  const switcherTab = useRef<'messages' | undefined>(undefined);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [narrowGroupExpanded, setNarrowGroupExpanded] = useState(false);
  const [groupFilterPanelState, setGroupFilterPanelState] = useState(
    initialGroupFilterPanelState,
  );
  const [conversationPanelState, setConversationPanelState] = useState(
    initialGroupFilterPanelState,
  );
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const resizeStart = useRef<{
    x: number;
    width: number;
    currentWidth: number;
    moved: boolean;
  } | null>(null);
  const savedConversationWidth = useImLayout((s) => s.layout.conversationWidth);
  const savedGroupCollapsed = useImLayout((s) => s.layout.groupCollapsed);
  const setConversationWidth = useImLayout((s) => s.setConversationWidth);
  const resetConversationWidth = useImLayout((s) => s.resetConversationWidth);
  const setGroupCollapsed = useImLayout((s) => s.setGroupCollapsed);
  const ActiveModule = registeredModules.find((candidate) => candidate.id === module)?.render;
  const wasRightPanelOpen = useRef(rightPanelOpen);

  useEffect(() => {
    void init().then(() => useToday.getState().refreshMentions());
    void loadPrefs(); // 侧栏/消息/通知偏好（服务端持久化，跨设备同步）
    void useCodexRuntime.getState().probe();
  }, [init, loadPrefs]);

  useEffect(() => {
    if (!userId) return;
    useNotificationAggregation.getState().hydrate(userId);
    const flush = () => {
      const store = useNotificationAggregation.getState();
      const summaries = store.flushDue(Date.now());
      for (const summary of summaries) {
        void desktopNotify({
          title: `${summary.roomName} · ${summary.count} 条新消息`,
          body: `${summary.latestSenderName}：${summary.latestText}`.slice(0, 120),
          tag: `aggregate:${summary.roomId}`,
          rid: summary.roomId,
          mid: summary.latestMessageId,
          onClick: () => {
            window.focus();
            useUI.getState().setModule('messages');
            void useChat.getState().jumpToMessage(summary.latestMessageId, summary.roomId);
          },
        }).then((shown) => {
          const current = useNotificationAggregation.getState();
          const phase = current.state?.metrics.activePhase;
          if (shown && phase) current.recordPopup(phase, Date.now(), 'aggregate');
        }).catch(() => {});
      }
    };
    flush();
    const timer = window.setInterval(flush, 30_000);
    return () => window.clearInterval(timer);
  }, [userId]);

  // 用户点回窗口 → 停止任务栏闪烁（Windows 点开会自动停，macOS Dock 弹跳要手动清）
  useEffect(() => {
    void restoreTrayAttention();
    const onFocus = () => void clearTaskbarFlash();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      void clearTrayAttention();
    };
  }, []);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const narrowLayout = windowWidth < NARROW_LAYOUT_WIDTH;
  const userGroupCollapsed = narrowLayout ? !narrowGroupExpanded : savedGroupCollapsed;
  const groupCollapsed = groupFilterPanelState.panelCollapsed || userGroupCollapsed;
  const maxConversationWidth = Math.min(
    MAX_CONVERSATION_WIDTH,
    Math.max(
      MIN_CONVERSATION_WIDTH,
      windowWidth -
        NAV_WIDTH -
        (groupCollapsed ? COLLAPSED_GROUP_WIDTH : GROUP_WIDTH) -
        RESIZER_WIDTH -
        MIN_CHAT_WIDTH,
    ),
  );
  const conversationWidth = effectiveConversationWidth(
    savedConversationWidth,
    conversationPanelState.panelCollapsed,
    dragWidth,
    maxConversationWidth,
    butlerPanelOpen,
  );

  useEffect(() => {
    const wasOpen = wasRightPanelOpen.current;
    wasRightPanelOpen.current = rightPanelOpen;
    if (!wasOpen && rightPanelOpen) {
      setGroupFilterPanelState((state) => nextGroupFilterPanelState(state, {
        type: 'panel-open',
        groupCollapsed,
      }));
      setConversationPanelState((state) => nextGroupFilterPanelState(state, {
        type: 'panel-open',
        groupCollapsed: conversationWidth <= COMPACT_CONVERSATION_WIDTH,
      }));
    } else if (wasOpen && !rightPanelOpen) {
      setGroupFilterPanelState((state) => nextGroupFilterPanelState(state, { type: 'panel-close' }));
      setConversationPanelState((state) => nextGroupFilterPanelState(state, { type: 'panel-close' }));
    }
  }, [conversationWidth, groupCollapsed, rightPanelOpen]);

  const clearConversationPanelNarrowing = () => {
    setConversationPanelState((state) => nextGroupFilterPanelState(state, { type: 'manual-change' }));
  };

  const toggleGroupFilter = () => {
    const nextCollapsed = !groupCollapsed;
    setGroupFilterPanelState((state) => nextGroupFilterPanelState(state, { type: 'manual-change' }));
    if (narrowLayout) setNarrowGroupExpanded(!nextCollapsed);
    else setGroupCollapsed(nextCollapsed);
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = {
      x: event.clientX,
      width: conversationWidth,
      currentWidth: conversationWidth,
      moved: false,
    };
    setDragWidth(conversationWidth);
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current;
    if (!start) return;
    const next = Math.min(maxConversationWidth, clampConversationWidth(start.width + event.clientX - start.x));
    if (next !== start.width) start.moved = true;
    start.currentWidth = next;
    setDragWidth(next);
  };

  const finishResize = () => {
    const start = resizeStart.current;
    if (start?.moved) {
      setConversationWidth(start.currentWidth);
      clearConversationPanelNarrowing();
    }
    resizeStart.current = null;
    setDragWidth(null);
  };

  const allConversations = useMemo(
    () => buildConversations(subscriptions, rooms),
    [subscriptions, rooms],
  );
  const hasUnread = allConversations.some((conversation) => conversation.unread > 0 || conversation.alert);

  const openNextUnread = () => {
    const chat = useChat.getState();
    const next = nextUnreadConversation(
      buildConversations(chat.subscriptions, chat.rooms),
      chat.activeRid,
    );
    if (!next) return;
    const ui = useUI.getState();
    ui.setConvFilter('unread');
    ui.retainUnread(next.rid);
    ui.setModule('messages');
    void chat.openRoom(next.rid);
  };

  // 标题栏未读数 + 任务栏角标（免打扰会话不计入）。
  // 角标是群聊消息的次级提示主体：不弹窗，但任务栏图标上有数字（读完自动清）
  useEffect(() => {
    const total = Object.values(subscriptions).reduce(
      (n, s) => n + (s.disableNotifications ? 0 : s.unread || 0),
      0,
    );
    document.title = total > 0 ? `(${total > 99 ? '99+' : total}) RocketChat X` : 'RocketChat X';
    void setTaskbarBadge(total);
    void setTrayAttention(hasTrayAttention(subscriptions, unreadAlert));
    void setTrayTooltip(formatTrayTooltip(allConversations));
  }, [allConversations, subscriptions, unreadAlert]);

  // 全局快捷键
  useEffect(() => {
    const switchConv = (delta: 1 | -1) => {
      const { subscriptions: subs, rooms: rms, activeRid } = useChat.getState();
      const ui = useUI.getState();
      const prefs = usePrefs.getState().prefs;
      const folderState = useFolders.getState();
      const folder = folderState.folders.find((item) => item.id === ui.activeFolder);
      const sections = buildConversationView(buildConversations(subs, rms), {
        filter: ui.convFilter,
        folder,
        retainedUnreadRid: ui.retainedUnreadRid,
        groupByType: prefs.sidebarGroupByType,
        showUnread: prefs.sidebarShowUnread,
        showFavorites: prefs.sidebarShowFavorites,
        sortBy: prefs.sidebarSortby,
      });
      const visible = flattenConversationView(
        sections,
        folderState.collapsed,
        !folder && ui.convFilter === 'all' && prefs.sidebarGroupByType,
      );
      const next = adjacentConversation(visible, activeRid, delta);
      if (!next) return;
      if (ui.convFilter === 'unread') ui.retainUnread(next.rid);
      ui.setModule('messages');
      void useChat.getState().openRoom(next.rid);
    };

    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = shortcutKeyOf(e);
      // Ctrl+K 快速切换会话
      if (mod && key === 'k' && !e.shiftKey) { e.preventDefault(); switcherTab.current = undefined; setSwitcher(!useUI.getState().switcherOpen); return; }
      // Ctrl+Shift+F 全局搜索消息
      if (mod && e.shiftKey && key === 'f') { e.preventDefault(); switcherTab.current = 'messages'; setSwitcher(true); return; }
      // Ctrl+Shift+↓ 连续处理下一条未读
      if (mod && e.shiftKey && e.key === 'ArrowDown') { e.preventDefault(); openNextUnread(); return; }
      // Ctrl+↑/↓ 上下切换会话
      if (mod && !e.shiftKey && e.key === 'ArrowUp') { e.preventDefault(); switchConv(-1); return; }
      if (mod && !e.shiftKey && e.key === 'ArrowDown') { e.preventDefault(); switchConv(1); return; }
      // Alt+↑/↓ 切换左侧模块
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const moduleOrder = [
          'messages',
          ...kernelRegistry.get('nav.module').map((candidate) => candidate.id),
          'settings',
        ];
        const cur = moduleOrder.indexOf(useUI.getState().module);
        const next = e.key === 'ArrowUp' ? Math.max(0, cur - 1) : Math.min(moduleOrder.length - 1, cur + 1);
        useUI.getState().setModule(moduleOrder[next]);
        return;
      }
      // Alt+1~9 直接跳到当前可见模块
      if (e.altKey && !mod && key >= '1' && key <= '9') {
        e.preventDefault();
        const moduleOrder = [
          'messages',
          ...kernelRegistry.get('nav.module').map((candidate) => candidate.id),
          'settings',
        ];
        const target = moduleOrder[Number(key) - 1];
        if (target) useUI.getState().setModule(target);
        return;
      }
      if (mod && key === '/') {
        e.preventDefault();
        setShortcutsOpen(true);
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
      <NavRail onOpenShortcuts={() => setShortcutsOpen(true)} />
      {module === 'messages' ? (
        <>
          <GroupFilter collapsed={groupCollapsed} onCollapse={toggleGroupFilter} />
          <ConversationList width={conversationWidth} avatarOnly={butlerPanelOpen} />
          {!butlerPanelOpen && (
            <div
              role="separator"
              aria-label="调整会话列表宽度"
              aria-orientation="vertical"
              aria-valuemin={MIN_CONVERSATION_WIDTH}
              aria-valuemax={maxConversationWidth}
              aria-valuenow={Math.round(conversationWidth)}
              tabIndex={0}
              title="拖动调整会话列表宽度，双击恢复默认"
              onDoubleClick={() => {
                clearConversationPanelNarrowing();
                resetConversationWidth();
              }}
              onPointerDown={onResizePointerDown}
              onPointerMove={onResizePointerMove}
              onPointerUp={finishResize}
              onPointerCancel={finishResize}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  const delta = event.key === 'ArrowLeft' ? -10 : 10;
                  clearConversationPanelNarrowing();
                  setConversationWidth(Math.min(maxConversationWidth, conversationWidth + delta));
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  clearConversationPanelNarrowing();
                  resetConversationWidth();
                }
              }}
              style={{ touchAction: 'none' }}
              className="group flex w-1.5 shrink-0 cursor-col-resize items-stretch justify-center bg-surface-2 outline-none focus:bg-primary-light"
            >
              <span className="w-px bg-line transition group-hover:bg-primary group-focus:bg-primary" />
            </div>
          )}
          <ChatArea hasUnread={hasUnread} onNextUnread={openNextUnread} />
        </>
      ) : ActiveModule ? (
        <ActiveModule />
      ) : (
        <SettingsPage />
      )}
      {(connection === 'reconnecting' || connection === 'connecting') && (
        <div className="fixed top-3 left-1/2 z-50 -translate-x-1/2 rounded-full border border-line bg-fill-active px-4 py-1.5 text-xs text-ink shadow-lg">
          连接中，消息推送可能延迟…
        </div>
      )}
      {switcher && (
        <QuickSwitcher
          onClose={() => setSwitcher(false)}
          initialTab={switcherCommandCenter ? 'all' : switcherTab.current}
          commandCenter={switcherCommandCenter}
        />
      )}
      <UploadConfirm />
      {newChatOpen && <StartDMDialog onClose={() => setNewChatOpen(false)} />}
      {shortcutsOpen && <ShortcutHelpDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
