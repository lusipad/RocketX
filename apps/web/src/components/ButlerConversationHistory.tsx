import { open } from '@tauri-apps/plugin-dialog';
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  Blocks,
  CalendarClock,
  FolderOpen,
  GitPullRequest,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Pencil,
  Search,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { openCodexNewThread, openCodexSurface, openCodexThread } from '../agent/codexTransfer';
import { getServerBase, isTauriRuntime } from '../lib/client';
import { useAuth } from '../stores/auth';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';

function threadTitle(name: string | null, preview: string): string {
  return name?.trim() || preview.trim() || '新对话';
}

function ageLabel(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp * 1_000);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时`;
  return `${Math.floor(elapsed / 86_400_000)} 天`;
}

export default function ButlerConversationHistory({ onNavigate }: { onNavigate?: () => void }) {
  const userId = useAuth((state) => state.user?._id);
  const activeView = useUI((state) => state.butlerView);
  const setButlerView = useUI((state) => state.setButlerView);
  const setModule = useUI((state) => state.setModule);
  const setWorkbenchTab = useUI((state) => state.setWorkbenchTab);
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const status = useCodexWorkspace((state) => state.status);
  const error = useCodexWorkspace((state) => state.error);
  const threads = useCodexWorkspace((state) => state.threads);
  const activeThreadId = useCodexWorkspace((state) => state.activeThreadId);
  const activeTurnId = useCodexWorkspace((state) => state.activeTurnId);
  const hydrate = useCodexWorkspace((state) => state.hydrate);
  const setWorkspaceRoot = useCodexWorkspace((state) => state.setWorkspaceRoot);
  const connect = useCodexWorkspace((state) => state.connect);
  const startThread = useCodexWorkspace((state) => state.startThread);
  const resumeThread = useCodexWorkspace((state) => state.resumeThread);
  const renameThread = useCodexWorkspace((state) => state.renameThread);
  const archiveThread = useCodexWorkspace((state) => state.archiveThread);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [openingCodex, setOpeningCodex] = useState(false);
  const [menuThreadId, setMenuThreadId] = useState<string | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const desktopRuntime = isTauriRuntime();

  useEffect(() => {
    if (!userId) return;
    hydrate(`${getServerBase() || 'same-origin'}:${userId}`);
  }, [hydrate, userId]);

  useEffect(() => {
    if (!desktopRuntime || !workspaceRoot || status !== 'idle') return;
    void connect().catch(() => undefined);
  }, [connect, desktopRuntime, status, workspaceRoot]);

  useEffect(() => {
    if (!menuThreadId && !renamingThreadId) return;
    const close = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent && (event.target as HTMLElement).closest('.codex-native-thread-actions')) return;
      setMenuThreadId(null);
      if (event instanceof KeyboardEvent) setRenamingThreadId(null);
    };
    document.addEventListener('keydown', close, true);
    document.addEventListener('mousedown', close, true);
    return () => {
      document.removeEventListener('keydown', close, true);
      document.removeEventListener('mousedown', close, true);
    };
  }, [menuThreadId, renamingThreadId]);

  const visibleThreads = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN');
    if (!normalized) return threads;
    return threads.filter((thread) => (
      `${thread.name ?? ''}\n${thread.preview}`.toLocaleLowerCase('zh-CN').includes(normalized)
    ));
  }, [query, threads]);

  const chooseWorkspace = async (): Promise<boolean> => {
    if (!isTauriRuntime()) throw new Error('网页版没有本地 Codex 执行面，请使用 RocketX 桌面端');
    const path = await open({ directory: true, multiple: false, title: '选择 Codex 工作区' });
    if (typeof path !== 'string') return false;
    await setWorkspaceRoot(path);
    await connect();
    return true;
  };

  const createConversation = async (): Promise<void> => {
    try {
      if (!workspaceRoot && !await chooseWorkspace()) return;
      setButlerView('conversation');
      await startThread();
      onNavigate?.();
    } catch (reason) {
      toast.error(reason, '无法新建对话');
    }
  };

  const openCodex = async (): Promise<void> => {
    setOpeningCodex(true);
    try {
      const result = activeView === 'routines'
        ? await openCodexSurface('scheduled')
        : activeView === 'plugins'
          ? await openCodexSurface('plugins')
          : activeThreadId
            ? await openCodexThread(activeThreadId)
            : workspaceRoot
              ? await openCodexNewThread('', workspaceRoot)
              : 'unavailable';
      if (result === 'unavailable') throw new Error('Codex App 没有响应');
    } catch (reason) {
      toast.error(reason, '无法切换到 Codex App');
    } finally {
      setOpeningCodex(false);
    }
  };

  return (
    <aside className="butler-conversation-history" aria-label="Codex 对话列表">
      <div className="butler-codex-product-switcher">
        <button
          type="button"
          className="butler-codex-back-rocketx"
          aria-label="返回 RocketX"
          onClick={() => setModule('messages')}
        >
          <ArrowLeft size={16} aria-hidden="true" />
        </button>
        <div className="butler-codex-product-title">
          <strong>Codex</strong>
        </div>
        <button
          type="button"
          aria-label={searchOpen ? '关闭对话搜索' : '搜索对话'}
          aria-pressed={searchOpen}
          onClick={() => setSearchOpen((current) => !current)}
        >
          <Search size={16} aria-hidden="true" />
        </button>
        <button type="button" aria-label="切换到 Codex App" disabled={!desktopRuntime || openingCodex} onClick={() => void openCodex()}>
          {openingCodex
            ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : <ArrowUpRight size={13} aria-hidden="true" />}
        </button>
      </div>

      <header>
        <button type="button" disabled={!desktopRuntime} onClick={() => void createConversation()} aria-label="新对话">
          <MessageSquarePlus size={15} aria-hidden="true" />
          新对话
        </button>
        {searchOpen ? (
          <label className="butler-codex-task-search">
            <Search size={14} aria-hidden="true" />
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索对话"
              placeholder="搜索对话"
            />
          </label>
        ) : null}
      </header>

      <nav className="butler-codex-surface-nav" aria-label="Codex 工作区">
        <button
          type="button"
          onClick={() => {
            setWorkbenchTab('prs');
            setModule('workbench');
            onNavigate?.();
          }}
        >
          <GitPullRequest size={15} aria-hidden="true" />
          拉取请求
        </button>
        <button
          type="button"
          aria-current={activeView === 'routines' ? 'page' : undefined}
          onClick={() => { setButlerView('routines'); onNavigate?.(); }}
        >
          <CalendarClock size={15} aria-hidden="true" />
          已安排
        </button>
        <button
          type="button"
          aria-current={activeView === 'plugins' ? 'page' : undefined}
          onClick={() => { setButlerView('plugins'); onNavigate?.(); }}
        >
          <Blocks size={15} aria-hidden="true" />
          插件
        </button>
      </nav>

      <div className="butler-codex-thread-heading">
        <span>项目</span>
        <small>{threads.length}</small>
      </div>

      <button
        type="button"
        className="butler-codex-workspace-picker"
        disabled={!desktopRuntime}
        onClick={() => void chooseWorkspace().catch((reason) => toast.error(reason, '无法打开工作区'))}
        title={workspaceRoot || '选择工作区'}
      >
        {status === 'connecting'
          ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : <FolderOpen size={14} aria-hidden="true" />}
        <span>{workspaceRoot ? workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1) : '选择工作区'}</span>
      </button>

      <nav aria-label="Codex 对话历史">
        <ul>
          {visibleThreads.map((thread) => {
            const selected = thread.id === activeThreadId;
            const running = thread.status.type === 'active' || (selected && Boolean(activeTurnId));
            return (
              <li key={thread.id} className="codex-native-thread-row">
                {renamingThreadId === thread.id ? (
                  <form
                    className="codex-native-thread-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void renameThread(thread.id, renameValue)
                        .then(() => { setRenamingThreadId(null); setMenuThreadId(null); })
                        .catch((reason) => toast.error(reason, '无法重命名对话'));
                    }}
                  >
                    <input autoFocus aria-label="对话名称" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
                    <button type="submit" disabled={!renameValue.trim()}>保存</button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="codex-native-thread-main"
                      onClick={() => {
                        setButlerView('conversation');
                        onNavigate?.();
                        if (!selected) void resumeThread(thread.id).catch((reason) => toast.error(reason, '无法打开对话'));
                      }}
                      aria-current={selected ? 'page' : undefined}
                    >
                      <span className={`butler-conversation-history-status ${running ? 'is-running' : ''}`} />
                      <span className="butler-conversation-history-title">{threadTitle(thread.name, thread.preview)}</span>
                      <time dateTime={new Date(thread.updatedAt * 1_000).toISOString()}>{ageLabel(thread.updatedAt)}</time>
                    </button>
                    <div className="codex-native-thread-actions">
                      <button
                        type="button"
                        aria-label={`更多对话操作：${threadTitle(thread.name, thread.preview)}`}
                        aria-expanded={menuThreadId === thread.id}
                        onClick={() => setMenuThreadId((current) => current === thread.id ? null : thread.id)}
                      >
                        <MoreHorizontal size={14} aria-hidden="true" />
                      </button>
                      {menuThreadId === thread.id ? (
                        <div role="menu" aria-label="对话操作">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              setRenameValue(threadTitle(thread.name, thread.preview));
                              setRenamingThreadId(thread.id);
                              setMenuThreadId(null);
                            }}
                          >
                            <Pencil size={13} aria-hidden="true" />重命名
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => void archiveThread(thread.id)
                              .then(() => setMenuThreadId(null))
                              .catch((reason) => toast.error(reason, '无法归档对话'))}
                          >
                            <Archive size={13} aria-hidden="true" />归档
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        {desktopRuntime && status === 'unavailable' ? <p className="butler-codex-task-empty">{error}</p> : null}
        {(!desktopRuntime || status !== 'unavailable') && visibleThreads.length === 0 ? (
          <p className="butler-codex-task-empty">
            {!desktopRuntime ? '请使用 RocketX 桌面端运行 Codex 任务' : workspaceRoot ? '还没有对话' : '选择工作区后开始'}
          </p>
        ) : null}
      </nav>
    </aside>
  );
}
