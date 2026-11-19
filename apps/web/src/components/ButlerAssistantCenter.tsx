import {
  Archive,
  BookmarkCheck,
  Brain,
  Calendar,
  CheckCircle2,
  Clock,
  Cpu,
  Edit3,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  History,
  Layers,
  Loader2,
  PanelLeft,
  PauseCircle,
  Pin,
  PinOff,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Sparkles,
  SquareKanban,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  buildAssistantAiSynthesisPrompt,
  generatePersonalAssistantBrief,
  saveAssistantSnapshotDigest,
  type PersonalAssistantBriefKind,
} from '../agent/personalAssistant';
import { isTauriRuntime } from '../lib/client';
import { renderMarkdownDoc } from '../lib/markdown';
import type {
  ButlerAssistantDigest,
  ButlerMemoryCategory,
  ButlerMemoryEntry,
} from '../platform/desktopCommands';
import { useAcpAgents } from '../stores/acpAgents';
import { isMemoryCurrent, isMemoryInWorkspace, useButlerMemory, validateMemoryNoSecrets } from '../stores/butlerMemory';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import { useWorkLedger } from '../stores/workLedger';

const BRIEF_TABS: ReadonlyArray<{
  kind: PersonalAssistantBriefKind;
  label: string;
  subtitle: string;
}> = [
  { kind: 'morning_brief', label: '晨间简报', subtitle: '今日截止 · 逾期盘点 · 优先级排序' },
  { kind: 'evening_review', label: '晚间复盘', subtitle: '完成回顾 · 风险收敛 · 记忆沉淀' },
  { kind: 'focus_digest', label: '聚焦摘要', subtitle: '实时工作流 · 审批队列 · 承诺跟进' },
];

const MEMORY_CATEGORIES: ReadonlyArray<{
  key: 'all' | ButlerMemoryCategory;
  label: string;
  badgeClass: string;
}> = [
  { key: 'all', label: '全部', badgeClass: 'bg-fill-2 text-ink-2' },
  { key: 'preference', label: '偏好习惯', badgeClass: 'bg-primary/10 text-primary' },
  { key: 'project_fact', label: '项目事实', badgeClass: 'bg-cyan-500/12 text-cyan-700 dark:text-cyan-300' },
  { key: 'workflow_habit', label: '工作流规范', badgeClass: 'bg-purple-500/12 text-purple-700 dark:text-purple-300' },
  { key: 'person_context', label: '协作关系', badgeClass: 'bg-amber-500/12 text-amber-700 dark:text-amber-300' },
  { key: 'episodic_summary', label: '阶段总结', badgeClass: 'bg-success/10 text-success' },
];

function categoryMeta(category: ButlerMemoryCategory) {
  return (
    MEMORY_CATEGORIES.find((c) => c.key === category) ?? {
      key: category,
      label: category,
      badgeClass: 'bg-fill-2 text-ink-2',
    }
  );
}

function formatDateTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ts);
}

export default function ButlerAssistantCenter() {
  const setButlerView = useUI((state) => state.setButlerView);
  const openAcpHub = useUI((state) => state.openAcpHub);
  const butlerSidebarCollapsed = useUI((state) => state.butlerSidebarCollapsed);
  const toggleButlerSidebarCollapsed = useUI((state) => state.toggleButlerSidebarCollapsed);

  const memories = useButlerMemory((state) => state.memories);
  const digests = useButlerMemory((state) => state.digests);
  const memoryPaused = useButlerMemory((state) => state.memoryPaused);
  const loading = useButlerMemory((state) => state.loading);
  const hydrateMemory = useButlerMemory((state) => state.hydrate);
  const setMemoryPaused = useButlerMemory((state) => state.setMemoryPaused);
  const upsertMemory = useButlerMemory((state) => state.upsertMemory);
  const correctMemory = useButlerMemory((state) => state.correctMemory);
  const expireMemory = useButlerMemory((state) => state.expireMemory);
  const accountScope = useButlerMemory((state) => state.accountScope);
  const deleteMemory = useButlerMemory((state) => state.deleteMemory);
  const togglePin = useButlerMemory((state) => state.togglePin);
  const toggleEnabled = useButlerMemory((state) => state.toggleEnabled);
  const clearScope = useButlerMemory((state) => state.clearScope);
  const deleteDigest = useButlerMemory((state) => state.deleteDigest);

  const acpAgents = useAcpAgents((state) => state.agents);
  const hydrateAcp = useAcpAgents((state) => state.hydrate);
  const startAcpSession = useAcpAgents((state) => state.startSession);
  const sendAcpPrompt = useAcpAgents((state) => state.sendPrompt);

  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const butlerWorkspaceRoot = useCodexWorkspace((state) => state.butlerWorkspaceRoot);
  const defaultWorkspaceRoot = useCodexWorkspace((state) => state.defaultWorkspaceRoot);
  const hydrateLedger = useWorkLedger((state) => state.hydrate);

  const [sectionTab, setSectionTab] = useState<'briefing' | 'memories' | 'archive'>('briefing');
  const [briefKind, setBriefKind] = useState<PersonalAssistantBriefKind>(() =>
    new Date().getHours() >= 17 ? 'evening_review' : 'morning_brief',
  );
  const [refreshTick, setRefreshTick] = useState(0);
  const [savingDigest, setSavingDigest] = useState(false);
  const [sendingToButler, setSendingToButler] = useState(false);
  const [dispatchingAcp, setDispatchingAcp] = useState(false);
  const [selectedAcpAgentId, setSelectedAcpAgentId] = useState<string>('');
  const [selectedDigest, setSelectedDigest] = useState<ButlerAssistantDigest | null>(null);

  // Memory Vault states
  const [memoryQuery, setMemoryQuery] = useState('');
  const [showMemoryHistory, setShowMemoryHistory] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<'all' | ButlerMemoryCategory>('all');
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [memTitle, setMemTitle] = useState('');
  const [memCategory, setMemCategory] = useState<ButlerMemoryCategory>('preference');
  const [memContent, setMemContent] = useState('');
  const [memTags, setMemTags] = useState('');
  const [memWorkspace, setMemWorkspace] = useState('');
  const [memPinned, setMemPinned] = useState(false);
  const [savingMem, setSavingMem] = useState(false);
  const [confirmClearScope, setConfirmClearScope] = useState(false);

  useEffect(() => {
    void hydrateMemory();
    void hydrateAcp();
    void hydrateLedger();
  }, [hydrateAcp, hydrateLedger, hydrateMemory]);

  const effectiveWorkspace =
    workspaceRoot || butlerWorkspaceRoot || defaultWorkspaceRoot || '';

  const enabledAcpAgents = useMemo(
    () => acpAgents.filter((a) => a.enabled),
    [acpAgents],
  );
  const resolvedAcpAgentId =
    selectedAcpAgentId || enabledAcpAgents[0]?.id || acpAgents[0]?.id || '';

  const snapshot = useMemo(() => {
    void refreshTick;
    return generatePersonalAssistantBrief(briefKind, new Date(), effectiveWorkspace);
  }, [briefKind, effectiveWorkspace, refreshTick, memories, memoryPaused]);

  const filteredMemories = useMemo(() => {
    const q = memoryQuery.trim().toLowerCase();
    return memories.filter((m) => {
      if (m.accountScope !== accountScope || !isMemoryInWorkspace(m, effectiveWorkspace)) return false;
      if (!showMemoryHistory && !isMemoryCurrent(m)) return false;
      if (categoryFilter !== 'all' && m.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        m.title.toLowerCase().includes(q) ||
        m.content.toLowerCase().includes(q) ||
        m.tags.some((t) => t.toLowerCase().includes(q)) ||
        (m.workspaceRoot?.toLowerCase().includes(q) ?? false) ||
        (m.sourceRef?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [accountScope, categoryFilter, effectiveWorkspace, memories, memoryQuery, showMemoryHistory]);

  const secretCheck = useMemo(
    () => validateMemoryNoSecrets(`${memTitle}\n${memContent}`),
    [memContent, memTitle],
  );

  const openNewMemoryEditor = () => {
    setEditingId(null);
    setMemTitle('');
    setMemCategory('preference');
    setMemContent('');
    setMemTags('');
    setMemWorkspace(effectiveWorkspace);
    setMemPinned(false);
    setEditorOpen(true);
  };

  const openEditMemoryEditor = (entry: ButlerMemoryEntry) => {
    setEditingId(entry.id);
    setMemTitle(entry.title);
    setMemCategory(entry.category);
    setMemContent(entry.content);
    setMemTags(entry.tags.join(', '));
    setMemWorkspace(entry.workspaceRoot ?? '');
    setMemPinned(entry.pinned);
    setEditorOpen(true);
  };

  const handleSaveMemory = async (event: FormEvent) => {
    event.preventDefault();
    if (!memTitle.trim() || !memContent.trim()) {
      toast.error('请填写记忆标题与内容');
      return;
    }
    if (!secretCheck.ok) {
      toast.error(secretCheck.reason || '检测到敏感凭据，禁止写入长期记忆');
      return;
    }
    setSavingMem(true);
    try {
      const tags = memTags
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const fields = {
        category: memCategory,
        title: memTitle.trim(),
        content: memContent.trim(),
        tags,
        workspaceRoot: memWorkspace.trim() || null,
        pinned: memPinned,
      };
      if (editingId) await correctMemory(editingId, fields);
      else await upsertMemory({ ...fields, sourceKind: 'manual', enabled: true });
      setEditorOpen(false);
      toast.success(editingId ? '记忆已纠正，旧版本不再召回' : '已存入长期记忆库');
    } catch (error) {
      toast.error(error, '保存记忆失败');
    } finally {
      setSavingMem(false);
    }
  };

  const handleSaveDigest = async () => {
    setSavingDigest(true);
    try {
      const saved = await saveAssistantSnapshotDigest(snapshot);
      setSelectedDigest(saved);
      toast.success('已归档本次助理简报');
    } catch (error) {
      toast.error(error, '归档简报失败');
    } finally {
      setSavingDigest(false);
    }
  };

  const handleSendToButler = async () => {
    setSendingToButler(true);
    try {
      const prompt = buildAssistantAiSynthesisPrompt(snapshot);
      const ws = useCodexWorkspace.getState();
      if (isTauriRuntime() && ws.status === 'ready') {
        await ws.startTask(prompt, snapshot.title);
        setButlerView('conversation');
        toast.success('已交给管家深度梳理并启动新对话');
      } else {
        ws.setComposerDraft(prompt);
        setButlerView('conversation');
        toast.info('已将深度梳理提示词填入管家输入框');
      }
    } catch (error) {
      toast.error(error, '交给管家处理失败');
    } finally {
      setSendingToButler(false);
    }
  };

  const handleDispatchToAcp = async () => {
    if (!resolvedAcpAgentId) {
      openAcpHub(null);
      toast.info('请先在 ACP 客户端工作台发现或添加本地 Agent');
      return;
    }
    if (!effectiveWorkspace) {
      openAcpHub(resolvedAcpAgentId);
      toast.info('请先在 ACP 工作台选择本地工作区目录');
      return;
    }
    setDispatchingAcp(true);
    try {
      const prompt = buildAssistantAiSynthesisPrompt(snapshot);
      const session = await startAcpSession({
        agentId: resolvedAcpAgentId,
        workspaceRoot: effectiveWorkspace,
        autonomyMode: 'confirm',
        title: snapshot.title,
      });
      openAcpHub(resolvedAcpAgentId);
      void sendAcpPrompt(session.sessionKey, prompt, { injectMemory: true }).catch((err) => {
        toast.error(err, 'ACP 客户端执行失败');
      });
      toast.success(`已派发给 ACP 客户端（${session.agentName}）`);
    } catch (error) {
      toast.error(error, '派发 ACP 客户端失败');
    } finally {
      setDispatchingAcp(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-surface-3">
      {/* 顶部栏：与管家/ACP 工作台等高齐平的 52px 栏 */}
      <header className="rcx-glass-header flex h-[52px] min-h-[52px] shrink-0 items-center justify-between gap-3 border-b border-line bg-surface-3 px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          {butlerSidebarCollapsed ? (
            <button
              type="button"
              onClick={toggleButlerSidebarCollapsed}
              title="展开会话列表 (Ctrl+B)"
              aria-label="展开会话列表"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
            >
              <PanelLeft size={16} />
            </button>
          ) : null}
          <Sparkles size={16} className="shrink-0 text-primary" />
          <h1 className="truncate text-sm font-semibold text-ink">个人助理</h1>
          <span
            className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-4 px-2.5 py-0.5 text-2xs font-medium text-ink-2"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${memoryPaused ? 'bg-warning' : 'bg-success'}`} />
            <span>{memoryPaused ? '记忆已暂停' : `记忆在线 (${snapshot.metrics.memoryCount})`}</span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* 隐私暂停开关 */}
          <button
            type="button"
            onClick={() => {
              setMemoryPaused(!memoryPaused);
              toast.info(
                !memoryPaused
                  ? '已暂停长期记忆召回与自动沉淀'
                  : '已恢复长期记忆召回与沉淀',
              );
            }}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
              memoryPaused
                ? 'border-warning/40 bg-warning/10 text-warning'
                : 'border-line bg-surface-4 text-ink-2 shadow-raise hover:bg-fill-hover hover:text-ink'
            }`}
            title="开启后不会向 AI 提示词注入任何长期记忆"
          >
            {memoryPaused ? <PlayCircle size={13} /> : <PauseCircle size={13} />}
            <span>{memoryPaused ? '恢复记忆召回' : '暂停记忆召回'}</span>
          </button>

          {/* 主分栏切换 */}
          <div className="flex items-center rounded-lg border border-line-soft bg-surface-2 p-0.5 text-xs">
            {[
              { id: 'briefing' as const, label: '今日助理', icon: Sparkles },
              { id: 'memories' as const, label: `长期记忆库 (${memories.length})`, icon: Brain },
              { id: 'archive' as const, label: `归档 (${digests.length})`, icon: History },
            ].map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSectionTab(tab.id)}
                  className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition ${
                    sectionTab === tab.id
                      ? 'bg-surface-4 font-semibold text-ink shadow-raise'
                      : 'text-ink-3 hover:text-ink'
                  }`}
                >
                  <Icon size={12} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </header>

      {/* 主内容区 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        {sectionTab === 'briefing' && (
          <div className="space-y-4">
            {/* 模式切换 + 操作工具条 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface-3 p-3 shadow-raise">
              <div className="flex flex-wrap items-center gap-1.5">
                {BRIEF_TABS.map((item) => (
                  <button
                    key={item.kind}
                    type="button"
                    onClick={() => setBriefKind(item.kind)}
                    className={`rounded-xl border px-3 py-1.5 text-left transition ${
                      briefKind === item.kind
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-line-soft bg-surface-4 text-ink-2 hover:bg-fill-hover'
                    }`}
                  >
                    <div className="text-xs font-semibold">{item.label}</div>
                    <div className="text-xs opacity-75">{item.subtitle}</div>
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRefreshTick((t) => t + 1)}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs font-medium text-ink-2 shadow-raise transition hover:bg-fill-hover hover:text-ink"
                >
                  <RefreshCw size={12} />
                  <span>刷新快照</span>
                </button>

                <button
                  type="button"
                  disabled={savingDigest}
                  onClick={() => void handleSaveDigest()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs font-medium text-ink shadow-raise transition hover:bg-fill-hover disabled:opacity-50"
                >
                  <BookmarkCheck size={12} className="text-success" />
                  <span>{savingDigest ? '归档中…' : '保存归档'}</span>
                </button>

                <button
                  type="button"
                  disabled={sendingToButler}
                  onClick={() => void handleSendToButler()}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover disabled:opacity-50"
                >
                  {sendingToButler ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Sparkles size={12} />
                  )}
                  <span>交给管家深度梳理</span>
                </button>

                <div className="flex items-center gap-1">
                  {acpAgents.length > 1 && (
                    <select
                      aria-label="选择 ACP 客户端"
                      value={resolvedAcpAgentId}
                      onChange={(e) => setSelectedAcpAgentId(e.target.value)}
                      className="h-8 rounded-xl border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
                    >
                      {acpAgents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    disabled={dispatchingAcp}
                    onClick={() => void handleDispatchToAcp()}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 text-xs font-medium text-purple-500 shadow-raise transition hover:bg-purple-500/20 disabled:opacity-50"
                  >
                    {dispatchingAcp ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Cpu size={12} />
                    )}
                    <span>派发 ACP 客户端执行</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Bento 指标卡 */}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-2xl border border-line bg-surface-4 p-3.5 shadow-raise">
                <div className="text-xs text-ink-3">未完成待办</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-lg font-bold text-ink">{snapshot.metrics.openTodos}</span>
                  {snapshot.metrics.overdueTodos > 0 && (
                    <span className="rounded-full bg-danger/15 px-2 py-0.5 text-2xs font-medium text-danger">
                      {snapshot.metrics.overdueTodos} 逾期
                    </span>
                  )}
                  {snapshot.metrics.dueTodayTodos > 0 && (
                    <span className="rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-medium text-warning">
                      {snapshot.metrics.dueTodayTodos} 今日截止
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-line bg-surface-4 p-3.5 shadow-raise">
                <div className="text-xs text-ink-3">今日日程</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-lg font-bold text-ink">{snapshot.metrics.todayEvents}</span>
                  <span className="text-xs text-ink-3">
                    已完成 {snapshot.metrics.completedTodayEvents}
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-line bg-surface-4 p-3.5 shadow-raise">
                <div className="text-xs text-ink-3">活跃工作流 / ACP</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="text-lg font-bold text-ink">{snapshot.metrics.activeWorkflows}</span>
                  <span className="text-xs text-ink-3">
                    ACP {snapshot.metrics.acpActiveSessions} · 阻塞 {snapshot.metrics.blockedCount}
                  </span>
                </div>
              </div>

              <div className="rounded-2xl border border-line bg-surface-4 p-3.5 shadow-raise">
                <div className="text-xs text-ink-3">待人工确认</div>
                <div className="mt-1 flex items-baseline gap-2">
                  <span
                    className={`text-lg font-bold ${
                      snapshot.metrics.waitingApprovalCount > 0 ? 'text-warning' : 'text-ink'
                    }`}
                  >
                    {snapshot.metrics.waitingApprovalCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => setButlerView('kanban')}
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    <SquareKanban size={11} />
                    查看看板
                  </button>
                </div>
              </div>
            </div>

            {/* 三栏结构化简报明细 */}
            <div className="grid gap-4 lg:grid-cols-3">
              {/* 左栏：焦点任务与承诺 */}
              <div className="space-y-4 lg:col-span-2">
                <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <Layers size={14} className="text-primary" />
                      <span>重点聚焦事项</span>
                    </h2>
                    <span className="text-xs text-ink-3">{snapshot.focusItems.length} 项</span>
                  </div>
                  {snapshot.focusItems.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-line p-5 text-center text-xs text-ink-3">
                      暂无未完成焦点待办，可前往统一看板或对话新建任务
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {snapshot.focusItems.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-line-soft bg-surface-4 px-3 py-2.5 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-semibold text-ink">{item.title}</div>
                            <div className="mt-0.5 text-xs text-ink-3">{item.reason}</div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span className="rounded-full bg-fill-2 px-2 py-0.5 text-2xs font-medium text-ink-2">
                              P{item.priority}
                            </span>
                            {item.stage && (
                              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary">
                                {item.stage}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* 承诺与协同 + 下一步行动 */}
                <div className="grid gap-4 md:grid-cols-2">
                  <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
                    <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <Clock size={14} className="text-warning" />
                      <span>承诺与等待协同</span>
                    </h2>
                    {snapshot.commitments.length === 0 ? (
                      <p className="text-xs text-ink-3">暂无记录在案的对外承诺或等待回复事项。</p>
                    ) : (
                      <div className="space-y-2">
                        {snapshot.commitments.map((c, idx) => (
                          <div
                            key={`${c.todoId}-${idx}`}
                            className="rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className={`rounded-full px-2 py-0.5 text-2xs font-medium ${
                                  c.direction === 'committed_to'
                                    ? 'bg-primary/10 text-primary'
                                    : 'bg-warning/15 text-warning'
                                }`}
                              >
                                {c.direction === 'committed_to'
                                  ? `我承诺 -> ${c.person}`
                                  : `等待 <- ${c.person}`}
                              </span>
                              {c.due && <span className="text-xs text-ink-3">截止 {c.due}</span>}
                            </div>
                            <div className="mt-1 truncate font-medium text-ink">{c.title}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
                    <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <CheckCircle2 size={14} className="text-success" />
                      <span>建议行动清单</span>
                    </h2>
                    <ul className="space-y-2 text-xs text-ink-2">
                      {snapshot.actionItems.map((act, idx) => (
                        <li
                          key={idx}
                          className="flex items-start gap-2 rounded-xl border border-line-soft bg-surface-4 px-3 py-2"
                        >
                          <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                          <span>{act}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>
              </div>

              {/* 右栏：今日日程、活跃会话、已召回记忆 */}
              <div className="space-y-4">
                <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
                  <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink">
                    <Calendar size={14} className="text-primary" />
                    <span>今日日程</span>
                  </h2>
                  {snapshot.schedule.length === 0 ? (
                    <p className="text-xs text-ink-3">今日暂无日历事件。</p>
                  ) : (
                    <div className="space-y-1.5">
                      {snapshot.schedule.map((ev) => (
                        <div
                          key={ev.id}
                          className="flex items-center justify-between gap-2 rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs"
                        >
                          <span className={ev.done ? 'text-ink-3 line-through' : 'font-medium text-ink'}>
                            {ev.title}
                          </span>
                          <span className="shrink-0 text-xs text-ink-3">
                            {ev.allDay
                              ? '全天'
                              : [ev.startTime, ev.endTime].filter(Boolean).join('-') || '全天'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <Brain size={14} className="text-primary" />
                      <span>置顶与相关记忆</span>
                    </h2>
                    <button
                      type="button"
                      onClick={() => setSectionTab('memories')}
                      className="text-xs text-primary hover:underline"
                    >
                      打开记忆库
                    </button>
                  </div>
                  {memoryPaused ? (
                    <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-xs text-warning">
                      当前已暂停记忆召回，向导与 ACP 会话将不会注入任何个人记忆。
                    </div>
                  ) : snapshot.relevantMemories.length === 0 ? (
                    <p className="text-xs text-ink-3">暂无长期记忆条目，可在记忆库中手动添加或从汇报沉淀。</p>
                  ) : (
                    <div className="space-y-1.5">
                      {snapshot.relevantMemories.map((m) => (
                        <div
                          key={m.id}
                          className="rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-semibold text-ink">{m.title}</span>
                            <span
                              className={`shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium ${
                                categoryMeta(m.category).badgeClass
                              }`}
                            >
                              {categoryMeta(m.category).label}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-ink-3">{m.content}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </div>
          </div>
        )}

        {sectionTab === 'memories' && (
          <div className="space-y-4">
            <p className="text-xs text-ink-3">当前目录与全局背景 · 记忆仅供参考，项目强制规则与权限以版本化资料和当前授权为准。</p>
            <label className="inline-flex items-center gap-2 text-xs text-ink-2"><input type="checkbox" checked={showMemoryHistory} onChange={(e) => setShowMemoryHistory(e.target.checked)} />显示停用、待确认、过期与已纠正的历史</label>
            {/* 记忆库搜索、分类与新增 */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface-3 p-3 shadow-raise">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex items-center">
                  <Search size={13} className="pointer-events-none absolute left-3 text-ink-3" />
                  <input
                    type="search"
                    value={memoryQuery}
                    onChange={(e) => setMemoryQuery(e.target.value)}
                    placeholder="搜索记忆标题、内容、标签或工作区…"
                    className="h-8 w-64 rounded-xl border border-line bg-surface-4 pl-8 pr-3 text-xs text-ink outline-none focus:border-primary"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-1">
                  {MEMORY_CATEGORIES.map((cat) => (
                    <button
                      key={cat.key}
                      type="button"
                      onClick={() => setCategoryFilter(cat.key)}
                      className={`rounded-full px-2.5 py-1 text-2xs font-medium transition ${
                        categoryFilter === cat.key
                          ? 'bg-primary text-white'
                          : 'bg-fill-2 text-ink-2 hover:bg-fill-hover'
                      }`}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                {memories.length > 0 && (
                  confirmClearScope ? (
                    <div className="flex items-center gap-1 rounded-xl border border-danger/40 bg-danger/10 px-2.5 py-1 text-xs">
                      <span className="text-danger">确认清空当前账号记忆？</span>
                      <button
                        type="button"
                        onClick={() =>
                          void clearScope().then((n) => {
                            setConfirmClearScope(false);
                            toast.success(`已清空 ${n} 条长期记忆`);
                          })
                        }
                        className="rounded bg-danger px-2 py-0.5 text-xs font-medium text-white"
                      >
                        确认
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmClearScope(false)}
                        className="rounded px-1.5 py-0.5 text-xs text-ink-3 hover:text-ink"
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmClearScope(true)}
                      className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface-4 px-2.5 py-1.5 text-xs text-ink-3 hover:border-danger/40 hover:text-danger"
                    >
                      <Trash2 size={12} />
                      <span>清空本账号记忆</span>
                    </button>
                  )
                )}

                <button
                  type="button"
                  onClick={openNewMemoryEditor}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-white shadow-raise transition hover:bg-primary-hover"
                >
                  <Plus size={13} />
                  <span>新增长期记忆</span>
                </button>
              </div>
            </div>

            {/* 新增 / 编辑记忆表单 */}
            {editorOpen && (
              <form
                onSubmit={(e) => void handleSaveMemory(e)}
                className="space-y-3 rounded-2xl border border-primary/30 bg-surface-3 p-4 shadow-card"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-ink">
                    {editingId ? '纠正长期记忆（保留旧版和来源）' : '新建长期记忆条目'}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setEditorOpen(false)}
                    className="rounded-lg p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"
                  >
                    <X size={15} />
                  </button>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink-2">标题</label>
                    <input
                      aria-label="记忆标题"
                      value={memTitle}
                      onChange={(e) => setMemTitle(e.target.value)}
                      placeholder="例如：代码提交前必须跑 regression 测试"
                      className="h-9 w-full rounded-xl border border-line bg-surface-4 px-3 text-xs text-ink outline-none focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink-2">记忆分类</label>
                    <select
                      value={memCategory}
                      onChange={(e) => setMemCategory(e.target.value as ButlerMemoryCategory)}
                      className="h-9 w-full rounded-xl border border-line bg-surface-4 px-3 text-xs text-ink outline-none focus:border-primary"
                    >
                      {MEMORY_CATEGORIES.filter((c) => c.key !== 'all').map((cat) => (
                        <option key={cat.key} value={cat.key}>
                          {cat.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-medium text-ink-2">
                    记忆内容（自动拦截 API Key / Token / 私钥）
                  </label>
                  <textarea
                    aria-label="记忆内容"
                    rows={3}
                    value={memContent}
                    onChange={(e) => setMemContent(e.target.value)}
                    placeholder="填写值得跨会话保留的偏好、项目架构约定、人物分工或踩坑经验…"
                    className="w-full rounded-xl border border-line bg-surface-4 p-3 text-xs text-ink outline-none focus:border-primary"
                  />
                  {!secretCheck.ok && (
                    <div className="mt-1.5 flex items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
                      <ShieldAlert size={13} />
                      <span>{secretCheck.reason}</span>
                    </div>
                  )}
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink-2">标签（逗号分隔）</label>
                    <input
                      value={memTags}
                      onChange={(e) => setMemTags(e.target.value)}
                      placeholder="rust, testing, ui"
                      className="h-9 w-full rounded-xl border border-line bg-surface-4 px-3 text-xs text-ink outline-none focus:border-primary"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-ink-2">限定工作区（留空则全局生效）</label>
                    <input
                      value={memWorkspace}
                      onChange={(e) => setMemWorkspace(e.target.value)}
                      placeholder="例如：d:\Repos\rocketchatx"
                      className="h-9 w-full rounded-xl border border-line bg-surface-4 px-3 text-xs text-ink outline-none focus:border-primary"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-2">
                    <input
                      type="checkbox"
                      checked={memPinned}
                      onChange={(e) => setMemPinned(e.target.checked)}
                      className="rounded border-line"
                    />
                    <span>置顶此记忆（优先在摘要和提示词中召回）</span>
                  </label>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditorOpen(false)}
                      className="rounded-xl border border-line bg-surface-4 px-3 py-1.5 text-xs text-ink-2 hover:bg-fill-hover"
                    >
                      取消
                    </button>
                    <button
                      type="submit"
                      disabled={savingMem || !secretCheck.ok}
                      className="rounded-xl bg-primary px-4 py-1.5 text-xs font-medium text-white shadow-raise hover:bg-primary-hover disabled:opacity-50"
                    >
                      {savingMem ? '保存中…' : '保存记忆'}
                    </button>
                  </div>
                </div>
              </form>
            )}

            {/* 记忆列表 */}
            {loading && memories.length === 0 ? (
              <div className="flex h-48 items-center justify-center text-xs text-ink-3">
                <Loader2 size={16} className="mr-2 animate-spin" />
                正在加载长期记忆…
              </div>
            ) : filteredMemories.length === 0 ? (
              <div className="flex h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface-3 p-6 text-center">
                <Brain size={28} className="mb-2 text-ink-3 opacity-50" />
                <div className="text-sm font-medium text-ink">
                  {memories.length === 0 ? '长期记忆库为空' : '没有匹配的记忆条目'}
                </div>
                <p className="mt-1 max-w-md text-xs text-ink-3">
                  你可以手动添加编码规范与偏好，也可以在工作流汇报或对话后点击「沉淀长期记忆」自动提取。
                </p>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {filteredMemories.map((entry) => {
                  const meta = categoryMeta(entry.category);
                  return (
                    <article
                      key={entry.id}
                      className={`flex flex-col justify-between gap-3 rounded-2xl border p-4 shadow-raise transition ${
                        isMemoryCurrent(entry)
                          ? 'border-line bg-surface-4'
                          : 'border-line-soft bg-surface-2 opacity-65'
                      }`}
                    >
                      <div className="space-y-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span
                                className={`rounded-full px-2 py-0.5 text-2xs font-medium ${meta.badgeClass}`}
                              >
                                {meta.label}
                              </span>
                              {entry.pinned && (
                                <span className="inline-flex items-center gap-0.5 rounded-full bg-warning/15 px-2 py-0.5 text-2xs font-medium text-warning">
                                  <Pin size={10} />
                                  置顶
                                </span>
                              )}
                              {!entry.enabled && (
                                <span className="rounded-full bg-fill-2 px-2 py-0.5 text-2xs text-ink-3">
                                  {entry.supersededBy ? '已纠正' : entry.expiresAt && entry.expiresAt <= Date.now() ? '已过期' : entry.sourceKind === 'workflow_report' ? '待确认背景' : '已停用'}
                                </span>
                              )}
                            </div>
                            <h3 className="mt-1.5 break-words text-sm font-semibold text-ink">
                              {entry.title}
                            </h3>
                          </div>

                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              disabled={Boolean(entry.supersededBy)}
                              onClick={() => void togglePin(entry.id)}
                              title={entry.pinned ? '取消置顶' : '置顶'}
                              className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"
                            >
                              {entry.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                            </button>
                            <button
                              type="button"
                              disabled={Boolean(entry.supersededBy) || (entry.expiresAt != null && entry.expiresAt <= Date.now())}
                              onClick={() => void toggleEnabled(entry.id).catch((error) => toast.error(error, '更新记忆失败'))}
                              title={entry.enabled ? '停用此记忆' : '启用此记忆'}
                              className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"
                            >
                              {entry.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
                            </button>
                            <button
                              type="button"
                              disabled={Boolean(entry.supersededBy)}
                              onClick={() => openEditMemoryEditor(entry)}
                              title="纠正记忆"
                              className="rounded-lg p-1.5 text-ink-3 hover:bg-fill-hover hover:text-ink"
                            >
                              <Edit3 size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                void deleteMemory(entry.id).then(() => toast.info('已删除记忆'))
                              }
                              title="删除"
                              className="rounded-lg p-1.5 text-ink-3 hover:bg-danger/10 hover:text-danger"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>

                        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-ink-2">
                          {entry.content}
                        </p>
                        <details className="text-xs text-ink-3">
                          <summary className="cursor-pointer">查看来源与有效性</summary>
                          <p className="mt-1 break-all">来源：{entry.sourceKind} · {entry.sourceRef || '用户手动输入'}<br />作用域：{entry.workspaceRoot || '全局'}<br />更新时间：{formatDateTime(entry.updatedAt)}</p>
                          {entry.supersededBy && <p className="break-all">已被纠正版本替代：{entry.supersededBy}</p>}
                          {entry.expiresAt != null && <p>失效时间：{formatDateTime(entry.expiresAt)}</p>}
                        </details>
                        {!entry.supersededBy && isMemoryCurrent(entry) && <button type="button" onClick={() => void expireMemory(entry.id).catch((error) => toast.error(error, '标记过期失败'))} className="text-xs text-warning hover:underline">这条信息已过期</button>}
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-2 text-xs text-ink-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {entry.workspaceRoot && (
                            <span
                              className="inline-flex max-w-[180px] items-center gap-1 truncate rounded-md bg-fill-1 px-1.5 py-0.5 font-mono"
                              title={entry.workspaceRoot}
                            >
                              <FolderOpen size={10} />
                              <span className="truncate">
                                {entry.workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)}
                              </span>
                            </span>
                          )}
                          {entry.tags.map((tag) => (
                            <span key={tag} className="rounded-md bg-fill-1 px-1.5 py-0.5">
                              #{tag}
                            </span>
                          ))}
                        </div>
                        <span>
                          召回 {entry.recallCount} 次 · {formatDateTime(entry.updatedAt)}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {sectionTab === 'archive' && (
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-2 lg:col-span-1">
              {digests.length === 0 ? (
                <div className="flex h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface-3 p-6 text-center">
                  <Archive size={24} className="mb-2 text-ink-3 opacity-50" />
                  <span className="text-xs font-medium text-ink">暂无归档简报</span>
                  <span className="mt-1 text-xs text-ink-3">在晨晚报页面点击「保存归档」即可保留记录</span>
                </div>
              ) : (
                digests.map((d) => (
                  <div
                    key={d.id}
                    onClick={() => setSelectedDigest(d)}
                    className={`cursor-pointer rounded-2xl border p-3 transition ${
                      selectedDigest?.id === d.id
                        ? 'border-primary bg-primary/5 shadow-card'
                        : 'border-line bg-surface-3 hover:bg-fill-hover'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-semibold text-ink">{d.title}</div>
                        <div className="mt-0.5 text-xs text-ink-3">
                          {d.dateKey} · {formatDateTime(d.createdAt)}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteDigest(d.id).then(() => {
                            if (selectedDigest?.id === d.id) setSelectedDigest(null);
                            toast.info('已删除归档');
                          });
                        }}
                        className="rounded p-1 text-ink-3 hover:bg-danger/10 hover:text-danger"
                        title="删除归档"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="lg:col-span-2">
              {selectedDigest ? (
                <div className="rounded-2xl border border-line bg-surface-3 p-5 shadow-card">
                  <div className="mb-3 flex items-center justify-between border-b border-line-soft pb-3">
                    <div>
                      <h2 className="text-sm font-semibold text-ink">{selectedDigest.title}</h2>
                      <p className="text-xs text-ink-3">{formatDateTime(selectedDigest.createdAt)}</p>
                    </div>
                    <FileText size={16} className="text-primary" />
                  </div>
                  <div className="butler-conversation-markdown text-sm">
                    {renderMarkdownDoc(selectedDigest.summaryMd)}
                  </div>
                </div>
              ) : (
                <div className="flex h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface-3 p-6 text-center text-xs text-ink-3">
                  <FileText size={26} className="mb-2 opacity-40" />
                  <span>从左侧选择一条历史晨晚报或聚焦摘要以查看完整内容</span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
