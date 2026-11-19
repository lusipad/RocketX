import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Activity as ActivityIcon,
  Bot,
  ChevronDown,
  FileCode2,
  FileText,
  ListOrdered,
  Plus,
  SquareKanban,
  X,
  Loader2,
  Check,
  CircleAlert,
  Sparkles,
} from 'lucide-react';
import { generatePersonalAssistantBrief } from '../agent/personalAssistant';
import { syncLiveSessionsIntoLedger } from '../agent/superAgentBridge';
import { buildWorkflowExecutionReport } from '../agent/workflowReport';
import type { CodexArtifact } from '../lib/codexArtifacts';
import type { WorkCardStage } from '../platform/desktopCommands';
import { resolvePortalWorkContext, workContextPathKey } from '../lib/workContext';
import { useAcpAgents } from '../stores/acpAgents';
import type { CodexWorkspaceEvent } from '../stores/codexWorkspace';
import { useUI } from '../stores/ui';
import { useWorkLedger } from '../stores/workLedger';
import { toast } from '../stores/toast';
import CodexArtifactPanel from './CodexArtifactPanel';
import WorkCardPortal from './WorkCardPortal';
import WorkflowReportCard from './WorkflowReportCard';
import { WORK_KANBAN_STAGES } from './WorkKanbanBoard';

const STAGE_LABEL_MAP: Record<WorkCardStage, string> = Object.fromEntries(
  WORK_KANBAN_STAGES.map((item) => [item.key, item.label]),
) as Record<WorkCardStage, string>;

export type PortalTab = 'workcard' | 'artifact' | 'activity' | 'report' | 'assistant';

interface ButlerWorkPortalDockProps {
  onClose: () => void;
  activeArtifact?: CodexArtifact | null;
  onCloseArtifact?: () => void;
  events?: CodexWorkspaceEvent[];
  initialTab?: PortalTab;
  onTabChange?: (tab: PortalTab) => void;
  activeThreadId?: string | null;
  activeWorkspaceRoot?: string;
  artifactThreadId?: string | null;
  currentRuntime?: 'pi' | 'codex';
}

export default function ButlerWorkPortalDock({
  onClose,
  activeArtifact,
  onCloseArtifact,
  events = [],
  initialTab,
  onTabChange,
  activeThreadId,
  activeWorkspaceRoot,
  artifactThreadId,
  currentRuntime = 'pi',
}: ButlerWorkPortalDockProps) {
  const createCard = useWorkLedger((state) => state.createCard);
  const cards = useWorkLedger((state) => state.cards);
  const workSessions = useWorkLedger((state) => state.sessions);
  const workEvidences = useWorkLedger((state) => state.evidences);
  const workLinks = useWorkLedger((state) => state.links);
  const hydrateLedger = useWorkLedger((state) => state.hydrate);
  const setButlerView = useUI((state) => state.setButlerView);
  const acpSessionsMap = useAcpAgents((state) => state.sessions);

  const [activeTab, setActiveTab] = useState<PortalTab>(() => {
    if (initialTab) return initialTab;
    if (activeArtifact) return 'artifact';
    return 'workcard';
  });
  const selectTab = (tab: PortalTab) => {
    setActiveTab(tab);
    onTabChange?.(tab);
  };

  const contextKey = `${currentRuntime}:${activeThreadId ?? ''}:${workContextPathKey(activeWorkspaceRoot ?? '')}`;
  const [selection, setSelection] = useState<{ cardId: string; contextKey: string } | null>(null);
  const selectedCardId = selection?.contextKey === contextKey ? selection.cardId : null;
  const [creating, setCreating] = useState(false);
  const [newNote, setNewNote] = useState('');
  const creatingCardRef = useRef(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // 宽度拖拽与记忆 (340px ~ 560px, 默认 380px 统一工作台)
  const [width, setWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('rcx-portal-width');
      const parsed = saved ? parseInt(saved, 10) : 380;
      return isNaN(parsed) ? 380 : Math.min(560, Math.max(340, parsed));
    } catch {
      return 380;
    }
  });

  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    void syncLiveSessionsIntoLedger()
      .catch(() => undefined)
      .finally(() => {
        void hydrateLedger();
      });
  }, [hydrateLedger]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const newWidth = Math.min(560, Math.max(340, window.innerWidth - moveEvent.clientX));
      setWidth(newWidth);
      try {
        localStorage.setItem('rcx-portal-width', String(newWidth));
      } catch {
        // ignore
      }
    };

    const onMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const sortedCards = useMemo(() => {
    return [...cards].sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    });
  }, [cards]);

  const { card: activeCard, acpSession: activeAcpSession, showsCurrentConversation } = useMemo(
    () => resolvePortalWorkContext({
      cards, sessions: workSessions, acpSessions: Object.values(acpSessionsMap),
      activeThreadId, activeWorkspaceRoot, currentRuntime, selectedCardId,
    }),
    [cards, workSessions, acpSessionsMap, activeThreadId, activeWorkspaceRoot, currentRuntime, selectedCardId],
  );
  const visibleArtifact = showsCurrentConversation && activeThreadId && artifactThreadId === activeThreadId
    ? activeArtifact : null;
  const visibleEvents = showsCurrentConversation && activeThreadId ? events : [];

  const activeReport = useMemo(() => {
    if (!activeCard && !activeAcpSession) return null;
    const cardId = activeCard?.id;
    return buildWorkflowExecutionReport({
      card: activeCard ?? undefined,
      acpSession: activeAcpSession ?? undefined,
      sessions: cardId ? workSessions.filter((s) => s.todoId === cardId) : [],
      evidences: cardId ? workEvidences.filter((e) => e.todoId === cardId) : [],
      links: cardId ? workLinks.filter((l) => l.todoId === cardId) : [],
    });
  }, [activeAcpSession, activeCard, workEvidences, workLinks, workSessions]);

  const assistantBrief = useMemo(() => {
    if (activeTab !== 'assistant') return null;
    return generatePersonalAssistantBrief('focus_digest');
  }, [activeTab]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = newNote.trim();
    if (!trimmed || creatingCardRef.current) return;
    creatingCardRef.current = true;
    try {
      const created = await createCard({ title: trimmed });
      setNewNote((current) => current === newNote ? '' : current);
      setCreating(false);
      setSelection({ cardId: created.id, contextKey });
    } catch (error) {
      toast.error(error, '创建任务失败');
    } finally {
      creatingCardRef.current = false;
    }
  };

  return (
    <aside className="butler-portal-drawer-container" aria-label="统一工作台容器">
      <div
        className="butler-portal-backdrop"
        onClick={onClose}
        aria-hidden="true"
        title="点击关闭工作台抽屉"
      />
      <div
        aria-label="任务工作台面板"
        style={{ width: `${width}px` }}
        className="butler-work-portal-dock relative flex h-full shrink-0 flex-col border-l border-line bg-surface select-auto shadow-sm"
      >
      {/* 拖拽把手 (Left Edge Resize Handle) */}
      <div
        onMouseDown={handleMouseDown}
        title="拖拽调整工作台宽度 (340px ~ 560px)"
        className="group absolute -left-1.5 top-0 bottom-0 z-30 flex w-3 cursor-col-resize items-center justify-center transition-colors hover:bg-primary/20"
      >
        <div className="h-8 w-0.5 rounded bg-line-strong transition-colors group-hover:bg-primary" />
      </div>

      {/* Top Header & Segmented Tabs */}
      <div className="flex flex-col border-b border-line bg-surface-2">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          {/* Segmented Tab Pill */}
          <div className="flex items-center rounded-xl bg-fill-2/80 p-0.5 text-xs font-medium text-ink-3">
            <button
              type="button"
              onClick={() => selectTab('workcard')}
              className={`flex items-center gap-1 rounded-lg px-2.5 py-1 transition-all ${
                activeTab === 'workcard'
                  ? 'bg-surface-4 font-semibold text-ink shadow-raise'
                  : 'hover:text-ink'
              }`}
            >
              <ListOrdered size={12} />
              <span>任务卡</span>
            </button>
            <button
              type="button"
              onClick={() => selectTab('artifact')}
              className={`flex items-center gap-1 rounded-lg px-2.5 py-1 transition-all ${
                activeTab === 'artifact'
                  ? 'bg-surface-4 font-semibold text-ink shadow-raise'
                  : 'hover:text-ink'
              }`}
            >
              <FileCode2 size={12} />
              <span>产物</span>
              {visibleArtifact ? <span className="h-1.5 w-1.5 rounded-full bg-primary" /> : null}
            </button>
            <button
              type="button"
              onClick={() => selectTab('activity')}
              className={`flex items-center gap-1 rounded-lg px-2 py-1 transition-all ${
                activeTab === 'activity'
                  ? 'bg-surface-4 font-semibold text-ink shadow-raise'
                  : 'hover:text-ink'
              }`}
            >
              <ActivityIcon size={12} />
              <span>动态</span>
              {visibleEvents.length > 0 ? (
                <span className="text-xs text-ink-3">({visibleEvents.length})</span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => selectTab('report')}
              className={`flex items-center gap-1 rounded-lg px-2 py-1 transition-all ${
                activeTab === 'report'
                  ? 'bg-surface-4 font-semibold text-ink shadow-raise'
                  : 'hover:text-ink'
              }`}
            >
              <FileText size={12} />
              <span>汇报</span>
            </button>
            <button
              type="button"
              onClick={() => selectTab('assistant')}
              className={`flex items-center gap-1 rounded-lg px-2 py-1 transition-all ${
                activeTab === 'assistant'
                  ? 'bg-surface-4 font-semibold text-ink shadow-raise'
                  : 'hover:text-ink'
              }`}
            >
              <Sparkles size={12} />
              <span>助理</span>
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setButlerView('kanban')}
              title="打开全屏统一看板"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-primary"
            >
              <SquareKanban size={13} />
              看板
            </button>
            <button
              type="button"
              onClick={onClose}
              title="关闭工作台 (Alt+P)"
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 transition hover:bg-fill-hover hover:text-ink"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Tab-specific sub-toolbar if in workcard mode */}
        {activeTab === 'workcard' && (
          <div className="flex items-center justify-between border-t border-line/60 px-3 py-1.5">
            <div className="relative min-w-0 flex-1">
              {sortedCards.length > 0 ? (
                <button
                  type="button"
                  aria-label={activeCard ? undefined : '选择任务'}
                  onClick={() => setPickerOpen((prev) => !prev)}
                  className="flex w-full items-center justify-between gap-1.5 rounded border border-line bg-surface px-2 py-1 text-left text-xs text-ink transition hover:bg-fill-hover"
                >
                  <span className="truncate font-medium">
                    {activeCard ? activeCard.title || activeCard.note || '未命名任务' : '选择任务'}
                  </span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-ink-3">
                    {activeCard ? STAGE_LABEL_MAP[activeCard.state.stage] : '暂无关联'}
                    <ChevronDown size={11} />
                  </span>
                </button>
              ) : (
                <span className="text-xs text-ink-3">暂无关联卡片</span>
              )}

              {pickerOpen && sortedCards.length > 0 ? (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setPickerOpen(false)} />
                  <div className="absolute right-0 left-0 z-30 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-surface-4 py-1 shadow-lg">
                    {sortedCards.map((card) => {
                      const selected = card.id === activeCard?.id;
                      return (
                        <button
                          key={card.id}
                          type="button"
                          onClick={() => {
                            setSelection({ cardId: card.id, contextKey });
                            setPickerOpen(false);
                          }}
                          className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition ${
                            selected ? 'bg-primary-light font-medium text-primary' : 'text-ink hover:bg-fill-hover'
                          }`}
                        >
                          <span className="truncate">{card.title || card.note || '未命名任务'}</span>
                          <span className="shrink-0 text-xs text-ink-3">{STAGE_LABEL_MAP[card.state.stage]}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : null}
            </div>

            <button
              type="button"
              onClick={() => setCreating((prev) => !prev)}
              title="新建任务卡片"
              className="ml-2 flex h-6 items-center gap-1 rounded bg-fill-2 px-2 text-xs font-medium text-ink transition hover:bg-fill-hover"
            >
              <Plus size={12} />
              新建
            </button>
          </div>
        )}
      </div>

      {creating && activeTab === 'workcard' ? (
        <form onSubmit={handleCreate} className="flex items-center gap-1.5 border-b border-line bg-fill-1/50 px-3 py-2">
          <input
            autoFocus
            value={newNote}
            onChange={(event) => setNewNote(event.target.value)}
            placeholder="输入新任务卡片标题…"
            className="h-7 min-w-0 flex-1 rounded border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={!newNote.trim()}
            className="h-7 shrink-0 rounded bg-primary px-2.5 text-xs font-medium text-white disabled:opacity-50"
          >
            新建
          </button>
        </form>
      ) : null}

      {/* Portal Content Views */}
      <div className="min-h-0 flex-1 overflow-hidden [&>aside]:w-full [&>aside]:border-l-0">
        {activeTab === 'workcard' && (
          activeCard ? (
            <WorkCardPortal card={activeCard} onClose={onClose} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <SquareKanban size={28} className="text-ink-3" />
              <div className="text-sm font-medium text-ink">
                {selectedCardId ? '所选任务已不存在' : sortedCards.length > 0 ? '当前会话暂无关联任务' : '还没有任务卡片'}
              </div>
              <p className="text-xs leading-5 text-ink-3">
                {sortedCards.length > 0 ? '从上方选择任务以查看详情，或创建一项新工作。' : '创建任务后，可以在这里查看执行过程、成果和验证记录。'}
              </p>
              <form onSubmit={handleCreate} className="mt-1 flex w-full max-w-xs gap-1.5">
                <input
                  value={newNote}
                  onChange={(event) => setNewNote(event.target.value)}
                  placeholder="输入第一张任务卡标题…"
                  className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary"
                />
                <button
                  type="submit"
                  disabled={!newNote.trim()}
                  className="h-8 shrink-0 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-50"
                >
                  创建
                </button>
              </form>
            </div>
          )
        )}

        {activeTab === 'artifact' && (
          visibleArtifact ? (
            <CodexArtifactPanel artifact={visibleArtifact} onClose={() => onCloseArtifact?.()} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <FileCode2 size={32} className="text-ink-4" />
              <div className="text-sm font-medium text-ink">暂未选定产物</div>
              <p className="text-xs text-ink-3 max-w-xs">
                在对话中点击生成的 Markdown、Diff、代码或报告链接，产物将立即在此无损展示，不会遮挡左侧会话。
              </p>
            </div>
          )
        )}

        {activeTab === 'activity' && (
          <div className="h-full overflow-y-auto p-4 space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-line">
              <span className="text-xs font-semibold text-ink">执行步骤与检查器</span>
              <span className="text-xs text-ink-3">共 {visibleEvents.length} 项</span>
            </div>
            {visibleEvents.length === 0 ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-ink-3">
                <ActivityIcon size={28} className="text-ink-4" />
                <span className="text-xs">当前会话暂无执行活动</span>
                <span className="text-xs text-ink-4">发送任务后，工具调用与动态步骤将在此实时流式展示</span>
              </div>
            ) : (
              <div className="space-y-2">
                {visibleEvents.map((event) => {
                  const statusIcon = event.status === 'running'
                    ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none text-primary" />
                    : event.status === 'failed'
                      ? <CircleAlert size={13} className="text-danger" />
                      : <Check size={13} className="text-success" />;
                  return (
                    <details
                      key={event.id}
                      className="rounded-lg border border-line bg-surface-1 p-2.5 text-xs transition-all open:bg-surface-2"
                    >
                      <summary className="flex cursor-pointer items-center gap-2 font-medium text-ink outline-none">
                        {statusIcon}
                        <span className="flex-1 truncate">{event.title}</span>
                        {event.summary ? <span className="text-xs text-ink-3 truncate max-w-[120px]">{event.summary}</span> : null}
                      </summary>
                      {event.detail ? (
                        <pre className="mt-2 overflow-x-auto rounded bg-fill-2 p-2 font-mono text-xs leading-relaxed text-ink-2 whitespace-pre-wrap">
                          {event.detail}
                        </pre>
                      ) : null}
                    </details>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === 'report' && (
          <div className="h-full overflow-y-auto p-3.5">
            {activeReport ? (
              <WorkflowReportCard
                report={activeReport}
                compact
              />
            ) : (
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-ink-3">
                <FileText size={28} className="text-ink-4" />
                <span className="text-xs font-medium text-ink">暂无可汇总的进展汇报</span>
                <span className="text-xs text-ink-4">
                  选定任务卡或启动 ACP 会话后，可在此一键生成并沉淀结构化工作汇报
                </span>
              </div>
            )}
          </div>
        )}

        {activeTab === 'assistant' && assistantBrief && (
          <div className="h-full space-y-3 overflow-y-auto bg-surface-3/60 p-3.5 text-xs">
            <div className="rounded-xl border border-line bg-surface-4 p-3.5 shadow-raise">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">{assistantBrief.title}</span>
                <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-2xs text-primary">
                  专注焦点
                </span>
              </div>
              <p className="mt-1.5 leading-relaxed text-ink-2">
                待办 {assistantBrief.metrics.openTodos} 项（逾期 {assistantBrief.metrics.overdueTodos}）· 日程 {assistantBrief.metrics.todayEvents} 项 · 活跃工作流 {assistantBrief.metrics.activeWorkflows} 项 · 长期记忆 {assistantBrief.metrics.memoryCount} 条
              </p>
            </div>

            {assistantBrief.focusItems.length > 0 ? (
              <div className="rounded-xl border border-line bg-surface-4 p-3.5 shadow-raise">
                <div className="mb-2 font-semibold text-ink">当前优先事项</div>
                <ul className="space-y-1.5 text-ink-2">
                  {assistantBrief.focusItems.slice(0, 4).map((item) => (
                    <li key={item.id} className="rounded-lg border border-line/60 bg-surface-2 px-2.5 py-1.5">
                      <div className="font-medium text-ink">{item.title}</div>
                      <div className="text-ink-3">{item.reason}</div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {assistantBrief.actionItems.length > 0 ? (
              <div className="rounded-xl border border-line bg-surface-4 p-3.5 shadow-raise">
                <div className="mb-2 font-semibold text-ink">建议下一步</div>
                <ul className="space-y-1.5 text-ink-2">
                  {assistantBrief.actionItems.slice(0, 4).map((act, idx) => (
                    <li key={idx} className="flex items-start gap-1.5">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                      <span>{act}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setButlerView('assistant')}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
              >
                <Sparkles size={13} />
                打开个人助理与长期记忆中心
              </button>
              <button
                type="button"
                onClick={() => setButlerView('acp-hub')}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface-4 px-3 py-2 text-xs font-medium text-ink-2 shadow-raise transition hover:bg-fill-hover hover:text-ink"
              >
                <Bot size={13} />
                ACP 客户端
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  </aside>
);
}
