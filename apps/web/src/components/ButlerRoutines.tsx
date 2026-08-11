import { open } from '@tauri-apps/plugin-dialog';
import {
  AlertCircle,
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  CirclePlay,
  ExternalLink,
  History,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BUTLER_ABILITY_TEMPLATES, type ButlerAbilityTemplate } from '../lib/butlerAbilityTemplates';
import { isTauriRuntime } from '../lib/client';
import { describeRrule } from '../lib/codexSchedule';
import { renderMarkdown } from '../lib/markdown';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useRoutines, type Routine, type RoutineTrigger } from '../stores/routines';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import ButlerRoutineCreateDialog from './ButlerRoutineCreateDialog';

type RoutineFilter = 'all' | 'active' | 'paused';
type DetailMode = 'details' | 'history' | 'edit' | 'create';

const CODEX_CREATE_PROMPT = '我们来一起设置一个已安排任务。请逐项确认要完成什么、何时运行、运行在哪个项目，以及怎样算完成。确认后必须调用 create_scheduled_task 创建真实的 Codex automation.toml，并建议立即运行一次验证。';

function triggerLabel(trigger: RoutineTrigger): string {
  if (trigger.kind === 'interval') {
    return trigger.window
      ? `每天 ${trigger.window.start}–${trigger.window.end}，每 ${trigger.everyMinutes} 分钟`
      : `每 ${trigger.everyMinutes} 分钟`;
  }
  if (!trigger.days?.length) return `每天 ${trigger.time}`;
  const days = trigger.days.map((day) => `周${'日一二三四五六'[day]}`).join('、');
  return `${days} ${trigger.time}`;
}

function scheduleLabel(routine: Routine): string {
  if (routine.rrule) return describeRrule(routine.rrule);
  return routine.trigger ? triggerLabel(routine.trigger) : '未设置运行时间';
}

function runTime(at: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}

function projectName(path?: string): string {
  if (!path || path === '~') return '临时工作区';
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}

function templateDraft(template: ButlerAbilityTemplate, workspaceRoot: string): Partial<Routine> {
  return {
    name: template.title,
    prompt: template.prompt,
    skillName: template.skillName,
    templateId: template.id,
    precheck: template.precheck,
    trigger: template.defaultTrigger,
    kind: 'cron',
    workspaceRoot,
  };
}

export default function ButlerRoutines() {
  const setButlerView = useUI((state) => state.setButlerView);
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const setWorkspaceRoot = useCodexWorkspace((state) => state.setWorkspaceRoot);
  const connect = useCodexWorkspace((state) => state.connect);
  const startThread = useCodexWorkspace((state) => state.startThread);
  const resumeThread = useCodexWorkspace((state) => state.resumeThread);
  const send = useCodexWorkspace((state) => state.send);
  const hydrate = useRoutines((state) => state.hydrate);
  const hydrateNative = useRoutines((state) => state.hydrateNative);
  const routines = useRoutines((state) => state.routines);
  const runningIds = useRoutines((state) => state.runningIds);
  const nativeStatus = useRoutines((state) => state.nativeStatus);
  const nativeError = useRoutines((state) => state.nativeError);
  const setEnabled = useRoutines((state) => state.setEnabled);
  const syncNative = useRoutines((state) => state.syncNative);
  const deleteNative = useRoutines((state) => state.deleteNative);
  const runScheduledRoutine = useRoutines((state) => state.runNow);
  const markRunRead = useRoutines((state) => state.markRunRead);
  const archiveRuns = useRoutines((state) => state.archiveRuns);
  const removeRoutine = useRoutines((state) => state.removeRoutine);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<DetailMode>('details');
  const [draft, setDraft] = useState<Partial<Routine> | undefined>();
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [filter, setFilter] = useState<RoutineFilter>('all');
  const [query, setQuery] = useState('');
  const createMenuRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const desktopRuntime = isTauriRuntime();

  useEffect(() => {
    hydrate();
    void hydrateNative().catch(() => undefined);
  }, [hydrate, hydrateNative]);

  useEffect(() => {
    if (selectedId && !routines.some((routine) => routine.id === selectedId)) {
      setSelectedId(null);
      setDetailMode('details');
    }
  }, [routines, selectedId]);

  useEffect(() => {
    if (!createMenuOpen && !actionMenuOpen) return;
    const close = (event: KeyboardEvent | MouseEvent): void => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event instanceof MouseEvent) {
        const target = event.target as Node;
        if (createMenuRef.current?.contains(target) || actionMenuRef.current?.contains(target)) return;
      }
      setCreateMenuOpen(false);
      setActionMenuOpen(false);
    };
    document.addEventListener('keydown', close, true);
    document.addEventListener('mousedown', close, true);
    return () => {
      document.removeEventListener('keydown', close, true);
      document.removeEventListener('mousedown', close, true);
    };
  }, [actionMenuOpen, createMenuOpen]);

  const selected = routines.find((routine) => routine.id === selectedId);
  const panelOpen = detailMode === 'create' || !!selected;

  const createWithCodex = async (): Promise<void> => {
    setCreateMenuOpen(false);
    try {
      if (!desktopRuntime) throw new Error('网页版没有本地 Codex 执行面，请使用 RocketX 桌面端');
      if (!workspaceRoot) {
        const path = await open({ directory: true, multiple: false, title: '选择 Codex 工作区' });
        if (typeof path !== 'string') return;
        await setWorkspaceRoot(path);
        await connect();
      }
      await startThread('创建已安排任务');
      setButlerView('conversation');
      await send(CODEX_CREATE_PROMPT);
    } catch (reason) {
      toast.error(reason, '无法使用 Codex 创建安排');
    }
  };

  const openManualCreate = (nextDraft?: Partial<Routine>): void => {
    setCreateMenuOpen(false);
    setSelectedId(null);
    setDraft(nextDraft);
    setDetailMode('create');
  };

  const closePanel = (): void => {
    setSelectedId(null);
    setDraft(undefined);
    setDetailMode('details');
    setActionMenuOpen(false);
  };

  const selectRoutine = (routine: Routine): void => {
    setSelectedId(routine.id);
    setDraft(undefined);
    setDetailMode('details');
  };

  const toggleRoutine = async (routine: Routine): Promise<void> => {
    setActionMenuOpen(false);
    try {
      setEnabled(routine.id, !routine.enabled);
      await syncNative(routine.id, routine);
    } catch (error) {
      toast.error(error, '无法同步 Codex 已安排任务');
    }
  };

  const deleteRoutine = async (routine: Routine): Promise<void> => {
    setActionMenuOpen(false);
    if (!window.confirm(`删除“${routine.name}”？运行历史也会一并删除。`)) return;
    try {
      await deleteNative(routine.id);
      removeRoutine(routine.id);
      closePanel();
      toast.success('已删除任务');
    } catch (error) {
      toast.error(error, '无法删除任务');
    }
  };

  const runNow = async (routine: Routine): Promise<void> => {
    setSelectedId(routine.id);
    setDetailMode('history');
    try {
      await runScheduledRoutine(routine.id, { triggerReason: 'manual' });
    } catch (error) {
      toast.error(error, '任务运行失败');
    }
  };

  const openRoutineThread = async (routine: Routine): Promise<void> => {
    setActionMenuOpen(false);
    const latest = routine.runs.find((run) => !run.archived);
    const threadId = routine.kind === 'heartbeat' ? routine.targetThreadId : latest?.threadId;
    if (!threadId) {
      toast.error('这个任务还没有可打开的 Codex 对话');
      return;
    }
    setButlerView('conversation');
    await resumeThread(threadId);
  };

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const visibleRoutines = routines.filter((routine) => {
    if (filter === 'active' && !routine.enabled) return false;
    if (filter === 'paused' && routine.enabled) return false;
    if (!normalizedQuery) return true;
    return `${routine.name}\n${routine.prompt ?? ''}\n${scheduleLabel(routine)}`
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery);
  });
  const suggestedTemplates = BUTLER_ABILITY_TEMPLATES.filter((template) => (
    !!template.prompt && !template.params && !routines.some((routine) => routine.templateId === template.id)
  ));
  const unreadRuns = routines.flatMap((routine) => routine.runs
    .filter((run) => !run.archived && !run.readAt)
    .map((run) => ({ routineId: routine.id, runId: run.id })));

  return (
    <section aria-label="已安排" className={`butler-scheduled-workbench${panelOpen ? ' has-detail' : ''}`}>
      <h1 className="sr-only">已安排的任务</h1>
      <div className="butler-scheduled-master">
        <header className="butler-scheduled-master-toolbar">
          <div role="tablist" aria-label="已安排任务状态">
            {([
              ['all', '全部'],
              ['active', '已开启'],
              ['paused', '已暂停'],
            ] as const).map(([value, label]) => (
              <button key={value} type="button" role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>
                {label}
              </button>
            ))}
          </div>
          <div ref={createMenuRef} className="butler-create-split">
            <button type="button" aria-label="使用 Codex 创建已安排任务" onClick={() => void createWithCodex()}>
              创建
            </button>
            <button type="button" aria-label="选择创建方式" aria-haspopup="menu" aria-expanded={createMenuOpen} onClick={() => setCreateMenuOpen((open) => !open)}>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            {createMenuOpen ? (
              <div role="menu" aria-label="创建方式" className="butler-create-menu">
                <button type="button" role="menuitem" onClick={() => void createWithCodex()}>
                  <MessageCircle size={17} aria-hidden="true" />使用 Codex 创建
                </button>
                <button type="button" role="menuitem" onClick={() => openManualCreate()}>
                  <Pencil size={17} aria-hidden="true" />手动设置
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <label className="butler-scheduled-search">
          <Search size={18} aria-hidden="true" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索已安排任务" placeholder="搜索已安排任务" />
        </label>

        {nativeStatus === 'loading' ? (
          <p className="butler-scheduled-native-status"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" />正在读取 Codex 计划文件…</p>
        ) : null}
        {nativeError ? (
          <p role="alert" className="butler-scheduled-native-error"><AlertCircle size={14} />Codex 计划文件读取失败：{nativeError}</p>
        ) : null}

        <div className="butler-scheduled-definition-list">
          {visibleRoutines.length === 0 ? (
            <div className="butler-scheduled-empty">
              <CirclePlay size={24} aria-hidden="true" />
              <strong>{routines.length === 0 ? '还没有已安排任务' : '没有匹配的任务'}</strong>
              <span>{routines.length === 0 ? '使用 Codex 创建，或从下面的建议开始。' : '换个关键词或状态试试。'}</span>
            </div>
          ) : visibleRoutines.map((routine) => {
            const running = runningIds.includes(routine.id);
            const unread = routine.runs.some((run) => !run.archived && !run.readAt);
            return (
              <button
                key={routine.id}
                type="button"
                aria-label={`打开${routine.name}详情`}
                aria-current={selectedId === routine.id ? 'true' : undefined}
                onClick={() => selectRoutine(routine)}
                className="butler-scheduled-definition"
              >
                {running
                  ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <CirclePlay size={18} aria-hidden="true" />}
                <span>
                  <strong>{routine.name}</strong>
                  <small>{scheduleLabel(routine)}</small>
                </span>
                {unread ? <i aria-label="有未读结果" /> : null}
              </button>
            );
          })}
        </div>

        {!normalizedQuery && filter === 'all' && suggestedTemplates.length > 0 ? (
          <section aria-label="建议" className="butler-scheduled-suggestions">
            <h2>建议</h2>
            {suggestedTemplates.map((template) => (
              <button key={template.id} type="button" onClick={() => openManualCreate(templateDraft(template, workspaceRoot))}>
                <span className={`butler-suggestion-icon is-${template.category}`}><Bell size={18} aria-hidden="true" /></span>
                <span>
                  <strong>{template.title}</strong>
                  <small>{triggerLabel(template.defaultTrigger)}</small>
                  <p>{template.description}</p>
                </span>
                <Plus size={17} aria-hidden="true" />
              </button>
            ))}
          </section>
        ) : null}
      </div>

      {panelOpen ? (
        <aside aria-label="已安排任务详情" className="butler-scheduled-detail-pane">
          {detailMode === 'create' ? (
            <ButlerRoutineCreateDialog key={draft?.templateId ?? 'manual'} draft={draft} embedded onClose={closePanel} />
          ) : selected && detailMode === 'edit' ? (
            <ButlerRoutineCreateDialog key={selected.id} routine={selected} embedded onClose={() => setDetailMode('details')} />
          ) : selected ? (
            <>
              <header className="butler-scheduled-detail-header">
                <span>{selected.enabled ? '已开启' : '已暂停'}</span>
                <div>
                  <div ref={actionMenuRef} className="butler-scheduled-detail-menu">
                    <button type="button" aria-label={`管理${selected.name}`} aria-haspopup="menu" aria-expanded={actionMenuOpen} onClick={() => setActionMenuOpen((open) => !open)}>
                      <MoreHorizontal size={18} aria-hidden="true" />
                    </button>
                    {actionMenuOpen ? (
                      <div role="menu">
                        <button type="button" role="menuitem" onClick={() => { setActionMenuOpen(false); setDetailMode('edit'); }}><Pencil size={15} />编辑</button>
                        <button type="button" role="menuitem" onClick={() => void toggleRoutine(selected)}>{selected.enabled ? <Pause size={15} /> : <Play size={15} />}{selected.enabled ? '暂停' : '恢复'}</button>
                        {(selected.targetThreadId || selected.runs.some((run) => run.threadId)) ? (
                          <button type="button" role="menuitem" onClick={() => void openRoutineThread(selected)}><ExternalLink size={15} />打开对话</button>
                        ) : null}
                        <button type="button" role="menuitem" onClick={() => void deleteRoutine(selected)}><Trash2 size={15} />删除</button>
                      </div>
                    ) : null}
                  </div>
                  <button type="button" aria-label={`立即运行${selected.name}`} disabled={runningIds.includes(selected.id)} onClick={() => void runNow(selected)}>
                    {runningIds.includes(selected.id) ? <Loader2 size={18} className="animate-spin" /> : <CirclePlay size={18} />}
                  </button>
                  <button type="button" aria-label="关闭已安排任务详情" onClick={closePanel}><X size={18} /></button>
                </div>
              </header>
              <h2>{selected.name}</h2>
              <nav aria-label="已安排任务详情视图">
                <button type="button" aria-current={detailMode === 'details' ? 'page' : undefined} onClick={() => setDetailMode('details')}>详情</button>
                <button type="button" aria-current={detailMode === 'history' ? 'page' : undefined} onClick={() => setDetailMode('history')}>运行历史记录</button>
              </nav>

              {detailMode === 'history' ? (
                <section aria-label="运行历史记录" className="butler-scheduled-run-history">
                  <header>
                    <span>{selected.runs.filter((run) => !run.archived).length} 次运行</span>
                    <div>
                      <button type="button" disabled={!unreadRuns.some((run) => run.routineId === selected.id)} onClick={() => selected.runs.forEach((run) => markRunRead(selected.id, run.id, true))}>
                        <Check size={14} />全部标为已读
                      </button>
                      <button type="button" onClick={() => archiveRuns(selected.id)}>归档</button>
                    </div>
                  </header>
                  {selected.runs.filter((run) => !run.archived).length === 0 ? (
                    <div className="butler-scheduled-history-empty"><History size={22} /><span>还没有运行记录</span></div>
                  ) : selected.runs.filter((run) => !run.archived).map((run) => (
                    <details key={run.id} onToggle={(event) => { if (event.currentTarget.open) markRunRead(selected.id, run.id, true); }}>
                      <summary>
                        {run.status === 'ok' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                        <strong>{selected.name}</strong>
                        <small>{projectName(selected.workspaceRoot)}</small>
                        <time>{runTime(run.at)}</time>
                        {!run.readAt ? <i aria-label="未读" /> : null}
                      </summary>
                      <div className="butler-routine-result butler-conversation-markdown">{renderMarkdown(run.text)}</div>
                    </details>
                  ))}
                </section>
              ) : (
                <div className="butler-scheduled-detail-content">
                  <section className="butler-scheduled-prompt"><p>{selected.prompt || (selected.skillName ? `使用 $${selected.skillName} 执行。` : '未提供任务说明。')}</p></section>
                  <h3>详情</h3>
                  <dl>
                    <div><dt>运行于</dt><dd>{selected.kind === 'heartbeat' ? '现有会话' : '新聊天'}</dd></div>
                    <div><dt>项目</dt><dd>{projectName(selected.workspaceRoot)}</dd></div>
                    <div><dt>模型</dt><dd>{selected.model || '跟随当前设置'}</dd></div>
                    <div><dt>推理</dt><dd>{selected.reasoningEffort || '跟随当前设置'}</dd></div>
                  </dl>
                  <h3>频率</h3>
                  <dl><div><dt>重复</dt><dd>{scheduleLabel(selected)}</dd></div><div><dt>通知</dt><dd>{selected.notificationPolicy === 'failed_runs_only' ? '仅失败' : selected.notificationPolicy === 'important_updates' ? '仅重要更新' : '所有运行'}</dd></div></dl>
                  <p className="butler-scheduled-file-note">任务定义来自 Codex 原生 automation.toml。</p>
                </div>
              )}
            </>
          ) : null}
        </aside>
      ) : null}
    </section>
  );
}
