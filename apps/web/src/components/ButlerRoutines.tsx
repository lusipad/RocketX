import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  Loader2,
  Play,
  Plus,
  Search,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { openCodexSurface } from '../agent/codexTransfer';
import { isTauriRuntime } from '../lib/client';
import { useRoutines, type Routine } from '../stores/routines';
import { toast } from '../stores/toast';
import ButlerRoutineCreateDialog from './ButlerRoutineCreateDialog';

type RoutineFilter = 'all' | 'active' | 'paused';

function scheduleLabel(routine: Routine): string {
  if (routine.trigger.kind === 'interval') return `每 ${routine.trigger.everyMinutes} 分钟`;
  if (!routine.trigger.days?.length) return `每天 ${routine.trigger.time}`;
  const days = routine.trigger.days.map((day: number) => `周${'日一二三四五六'[day]}`).join('、');
  return `${days} ${routine.trigger.time}`;
}

function runTime(at: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at);
}

export default function ButlerRoutines() {
  const hydrate = useRoutines((state) => state.hydrate);
  const routines = useRoutines((state) => state.routines);
  const runningIds = useRoutines((state) => state.runningIds);
  const setEnabled = useRoutines((state) => state.setEnabled);
  const runScheduledRoutine = useRoutines((state) => state.runNow);
  const [createOpen, setCreateOpen] = useState(false);
  const [expandedRoutineId, setExpandedRoutineId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RoutineFilter>('all');
  const [query, setQuery] = useState('');
  const [seenRunIds, setSeenRunIds] = useState<Set<string>>(() => new Set());
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const desktopRuntime = isTauriRuntime();

  useEffect(() => hydrate(), [hydrate]);

  const openCodex = async (): Promise<void> => {
    if (!desktopRuntime) {
      toast.error('网页版无法打开本地 Codex App');
      return;
    }
    if (await openCodexSurface('scheduled') === 'opened') return;
    toast.error('无法打开 Codex App 的“已安排”页面');
  };

  const closeCreate = (): void => {
    setCreateOpen(false);
    requestAnimationFrame(() => createButtonRef.current?.focus());
  };

  const runNow = async (id: string, options: { triggerReason: 'manual' }): Promise<void> => {
    setExpandedRoutineId(null);
    await runScheduledRoutine(id, options);
    setExpandedRoutineId(id);
  };

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const visibleRoutines = routines.filter((routine) => {
    if (filter === 'active' && !routine.enabled) return false;
    if (filter === 'paused' && routine.enabled) return false;
    if (!normalizedQuery) return true;
    return `${routine.name}\n${routine.skillName ?? ''}`
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery);
  });
  const latestRunIds = routines.flatMap((routine) => routine.runs[0]?.id ? [routine.runs[0].id] : []);
  const unreadCount = latestRunIds.filter((id) => !seenRunIds.has(id)).length;

  return (
    <section aria-label="已安排" className="butler-codex-page">
      <div className="butler-codex-page-inner">
        <header className="butler-codex-page-header">
          <div>
            <h1>已安排</h1>
            <p>保存在此设备；执行时使用当前 Codex 工作区。</p>
          </div>
          <div>
            <button
              type="button"
              onClick={() => void openCodex()}
              aria-label="在 Codex App 管理"
              disabled={!desktopRuntime}
              title={desktopRuntime ? '在 Codex App 中打开已安排任务' : '仅桌面端可打开 Codex App'}
            >
              <ExternalLink size={14} aria-hidden="true" />
              Codex
            </button>
            <button
              ref={createButtonRef}
              type="button"
              aria-label="新建安排"
              onClick={() => setCreateOpen(true)}
              className="butler-codex-primary-action"
            >
              <Plus size={15} aria-hidden="true" />
              新建
            </button>
          </div>
        </header>

        <div className="butler-codex-list-tools">
          <label>
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索已安排任务"
              placeholder="搜索"
            />
          </label>
          <div role="tablist" aria-label="已安排任务状态">
            {([
              ['all', '全部'],
              ['active', '进行中'],
              ['paused', '已暂停'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={unreadCount === 0}
            onClick={() => setSeenRunIds(new Set(latestRunIds))}
            className="butler-codex-mark-read"
          >
            全部标为已读{unreadCount > 0 ? ` (${unreadCount})` : ''}
          </button>
        </div>

        <div className="butler-scheduled-list">
          {visibleRoutines.length === 0 ? (
            <div className="butler-codex-empty-list">
              <CalendarClock size={26} aria-hidden="true" />
              <h2>{routines.length === 0 ? '还没有已安排任务' : '没有匹配的任务'}</h2>
              <p>{routines.length === 0 ? '新建任务后，它会在这里显示状态和结果。' : '换个关键词或状态试试。'}</p>
            </div>
          ) : visibleRoutines.map((routine) => {
            const latest = routine.runs[0];
            const running = runningIds.includes(routine.id);
            const unread = !!latest && !seenRunIds.has(latest.id);
            return (
              <article key={routine.id} aria-busy={running} className="butler-scheduled-row">
                <div className="butler-scheduled-row-main">
                  <span className={`butler-scheduled-status-dot ${running ? 'is-running' : unread ? 'is-unread' : ''}`} />
                  <div className="butler-scheduled-copy">
                    <h2>{routine.name}</h2>
                    <p>
                      {scheduleLabel(routine)}
                      {routine.skillName ? ` · $${routine.skillName}` : ''}
                      {latest ? ` · 上次 ${runTime(latest.at)}` : ' · 尚未运行'}
                    </p>
                  </div>
                  <span
                    role="status"
                    aria-live="polite"
                    className={running ? 'text-primary' : routine.enabled ? 'text-success' : 'text-ink-3'}
                  >
                    {running ? '正在运行' : routine.enabled ? '已启用' : '已暂停'}
                  </span>
                  <div className="butler-scheduled-actions">
                    <button
                      type="button"
                      role="switch"
                      aria-label={`${routine.enabled ? '停用' : '启用'}${routine.name}`}
                      aria-checked={routine.enabled}
                      onClick={() => setEnabled(routine.id, !routine.enabled)}
                      className="butler-codex-switch"
                    >
                      <span className={routine.enabled ? 'is-on' : ''}><span /></span>
                    </button>
                    <button
                      type="button"
                      aria-label={`立即运行${routine.name}`}
                      disabled={running}
                      onClick={() => void runNow(routine.id, { triggerReason: 'manual' })}
                      className="butler-scheduled-run"
                    >
                      {running
                        ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        : <Play size={13} aria-hidden="true" />}
                      {running ? '运行中' : latest?.status === 'error' ? '重试' : '运行'}
                    </button>
                  </div>
                </div>
                {latest ? (
                  <details
                    open={expandedRoutineId === routine.id}
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setExpandedRoutineId(open ? routine.id : null);
                      if (open) setSeenRunIds((current) => new Set(current).add(latest.id));
                    }}
                    className="butler-scheduled-result"
                  >
                    <summary>
                      {latest.status === 'ok'
                        ? <CheckCircle2 size={13} className="text-success" aria-hidden="true" />
                        : <AlertCircle size={13} className="text-danger" aria-hidden="true" />}
                      <span>最近结果 · {latest.status === 'ok' ? '完成' : '失败'}</span>
                      <span>查看结果</span>
                      <ChevronDown size={14} aria-hidden="true" />
                    </summary>
                    <pre className="butler-routine-result">{latest.text}</pre>
                  </details>
                ) : null}
              </article>
            );
          })}
        </div>
      </div>
      {createOpen ? <ButlerRoutineCreateDialog onClose={closeCreate} /> : null}
    </section>
  );
}
