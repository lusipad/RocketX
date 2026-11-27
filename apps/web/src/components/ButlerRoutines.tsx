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
import { useI18n, type MessageKey, type ResolvedLocale, type TranslateFn } from '../i18n';
import { formatDateTime } from '../i18n/format';
import { BUTLER_ABILITY_TEMPLATES, type ButlerAbilityTemplate } from '../lib/butlerAbilityTemplates';
import { isTauriRuntime } from '../lib/client';
import { pinyinMatch, usePinyinReady } from '../lib/pinyin';
import { openDesktopDialog } from '../platform/desktopDialog';
import { describeRrule } from '../lib/codexSchedule';
import { renderMarkdownDoc } from '../lib/markdown';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useRoutines, type Routine, type RoutineTrigger } from '../stores/routines';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import ButlerRoutineCreateDialog from './ButlerRoutineCreateDialog';
import { ConfirmDialog } from './Dialog';

type RoutineFilter = 'all' | 'active' | 'paused';
type DetailMode = 'details' | 'history' | 'edit' | 'create';

function triggerLabel(trigger: RoutineTrigger, t: TranslateFn): string {
  if (trigger.kind === 'event') {
    const label = t(`butler.routines.event.${trigger.eventType}` as MessageKey);
    return trigger.filter ? `${label} · ${trigger.filter}` : label;
  }
  if (trigger.kind === 'interval') {
    return trigger.window
      ? t('butler.routines.triggerWindowInterval', {
          start: trigger.window.start,
          end: trigger.window.end,
          minutes: trigger.everyMinutes,
        })
      : t('butler.routines.triggerInterval', { minutes: trigger.everyMinutes });
  }
  if (!trigger.days?.length) return t('butler.routines.triggerDaily', { time: trigger.time });
  const days = trigger.days
    .map((day) => t(`butler.routines.weekdayCompact.${day}` as MessageKey))
    .join(t('butler.listSeparator'));
  return t('butler.routines.triggerDays', { days, time: trigger.time });
}

function scheduleLabel(routine: Routine, t: TranslateFn): string {
  if (routine.rrule) return describeRrule(routine.rrule);
  return routine.trigger ? triggerLabel(routine.trigger, t) : t('butler.routines.scheduleNotSet');
}

function runTime(at: number, locale: ResolvedLocale): string {
  return formatDateTime(at, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }, locale);
}

function projectName(path: string | undefined, t: TranslateFn): string {
  if (!path || path === '~') return t('butler.routines.tempWorkspace');
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}

function templateDraft(template: ButlerAbilityTemplate, workspaceRoot: string, t: TranslateFn): Partial<Routine> {
  return {
    name: t(template.titleKey),
    prompt: template.promptKey ? t(template.promptKey) : undefined,
    skillName: template.skillName,
    templateId: template.id,
    precheck: template.precheck,
    trigger: template.defaultTrigger,
    kind: 'cron',
    workspaceRoot,
  };
}

export default function ButlerRoutines() {
  const { t, tp, locale } = useI18n();
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
  const dryRunRoutine = useRoutines((state) => state.dryRunRoutine);
  const markRunRead = useRoutines((state) => state.markRunRead);
  const archiveRuns = useRoutines((state) => state.archiveRuns);
  const removeRoutine = useRoutines((state) => state.removeRoutine);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailMode, setDetailMode] = useState<DetailMode>('details');
  const [draft, setDraft] = useState<Partial<Routine> | undefined>();
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [pendingDeleteRoutine, setPendingDeleteRoutine] = useState<Routine | null>(null);
  const [filter, setFilter] = useState<RoutineFilter>('all');
  usePinyinReady();
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
      if (!desktopRuntime) throw new Error(t('butler.routines.desktopOnlyCodex'));
      if (!workspaceRoot) {
        const path = await openDesktopDialog({ directory: true, multiple: false, title: t('butler.routines.chooseCodexWorkspace') });
        if (typeof path !== 'string') return;
        await setWorkspaceRoot(path);
        await connect();
      }
      await startThread(t('butler.routines.startCreateThreadTitle'));
      setButlerView('conversation');
      await send(t('butler.routines.codexCreatePrompt'));
    } catch (reason) {
      toast.error(reason, t('butler.routines.createWithCodexFailed'));
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
      toast.error(error, t('butler.routines.syncFailed'));
    }
  };

  const requestDeleteRoutine = (routine: Routine): void => {
    setActionMenuOpen(false);
    setPendingDeleteRoutine(routine);
  };

  const confirmDeleteRoutine = async (): Promise<void> => {
    const routine = pendingDeleteRoutine;
    if (!routine) return;
    setPendingDeleteRoutine(null);
    try {
      await deleteNative(routine.id);
      removeRoutine(routine.id);
      closePanel();
      toast.success(t('butler.routines.deletedToast'));
    } catch (error) {
      toast.error(error, t('butler.routines.deleteFailed'));
    }
  };

  const runNow = async (routine: Routine): Promise<void> => {
    setSelectedId(routine.id);
    setDetailMode('history');
    try {
      await runScheduledRoutine(routine.id, { triggerReason: 'manual' });
    } catch (error) {
      toast.error(error, t('butler.routines.runFailed'));
    }
  };

  const openRoutineThread = async (routine: Routine): Promise<void> => {
    setActionMenuOpen(false);
    const latest = routine.runs.find((run) => !run.archived);
    const threadId = routine.kind === 'heartbeat' ? routine.targetThreadId : latest?.threadId;
    if (!threadId) {
      toast.error(t('butler.routines.noThreadToOpen'));
      return;
    }
    setButlerView('conversation');
    await resumeThread(threadId);
  };

  const normalizedQuery = query.trim();
  const visibleRoutines = routines.filter((routine) => {
    if (routine.workTemplate) return false;
    if (filter === 'active' && !routine.enabled) return false;
    if (filter === 'paused' && routine.enabled) return false;
    if (!normalizedQuery) return true;
    return pinyinMatch(normalizedQuery, routine.name, routine.prompt, scheduleLabel(routine, t));
  });
  const suggestedTemplates = BUTLER_ABILITY_TEMPLATES.filter((template) => (
    !!template.promptKey && !template.params && !routines.some((routine) => routine.templateId === template.id)
  ));
  const unreadRuns = routines.flatMap((routine) => routine.runs
    .filter((run) => !run.archived && !run.readAt)
    .map((run) => ({ routineId: routine.id, runId: run.id })));

  return (
    <section aria-label={t('butler.routines.sectionAria')} className={`butler-scheduled-workbench${panelOpen ? ' has-detail' : ''}`}>
      <h1 className="sr-only">{t('butler.routines.pageHeading')}</h1>
      <div className="butler-scheduled-master">
        <header className="butler-scheduled-master-toolbar">
          <div role="tablist" aria-label={t('butler.routines.filterAria')}>
            {([
              ['all', 'butler.routines.filterAll'],
              ['active', 'butler.routines.filterActive'],
              ['paused', 'butler.routines.filterPaused'],
            ] as const).map(([value, labelKey]) => (
              <button key={value} type="button" role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>
                {t(labelKey)}
              </button>
            ))}
          </div>
          <div ref={createMenuRef} className="butler-create-split">
            <button type="button" aria-label={t('butler.routines.createWithCodexAria')} onClick={() => void createWithCodex()}>
              {t('butler.routines.createSubmit')}
            </button>
            <button type="button" aria-label={t('butler.routines.chooseCreateModeAria')} aria-haspopup="menu" aria-expanded={createMenuOpen} onClick={() => setCreateMenuOpen((open) => !open)}>
              <ChevronDown size={16} aria-hidden="true" />
            </button>
            {createMenuOpen ? (
              <div role="menu" aria-label={t('butler.routines.createMenuAria')} className="butler-create-menu">
                <button type="button" role="menuitem" onClick={() => void createWithCodex()}>
                  <MessageCircle size={17} aria-hidden="true" />{t('butler.routines.createWithCodex')}
                </button>
                <button type="button" role="menuitem" onClick={() => openManualCreate()}>
                  <Pencil size={17} aria-hidden="true" />{t('butler.routines.manualSetup')}
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <label className="butler-scheduled-search">
          <Search size={18} aria-hidden="true" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} aria-label={t('butler.routines.searchAria')} placeholder={t('butler.routines.searchAria')} />
        </label>

        {nativeStatus === 'loading' ? (
          <p className="butler-scheduled-native-status"><Loader2 size={13} className="animate-spin motion-reduce:animate-none" />{t('butler.routines.loadingNative')}</p>
        ) : null}
        {nativeError ? (
          <p role="alert" className="butler-scheduled-native-error"><AlertCircle size={14} />{t('butler.routines.nativeError', { error: nativeError })}</p>
        ) : null}

        <div className="butler-scheduled-definition-list">
          {visibleRoutines.length === 0 ? (
            <div className="butler-scheduled-empty">
              <CirclePlay size={24} aria-hidden="true" />
              <strong>{routines.length === 0 ? t('butler.routines.emptyTitle') : t('butler.routines.noMatchesTitle')}</strong>
              <span>{routines.length === 0 ? t('butler.routines.emptyDesc') : t('butler.routines.noMatchesDesc')}</span>
            </div>
          ) : visibleRoutines.map((routine) => {
            const running = runningIds.includes(routine.id);
            const unread = routine.runs.some((run) => !run.archived && !run.readAt);
            return (
              <button
                key={routine.id}
                type="button"
                aria-label={t('butler.routines.openDetailAria', { name: routine.name })}
                aria-current={selectedId === routine.id ? 'true' : undefined}
                onClick={() => selectRoutine(routine)}
                className="butler-scheduled-definition"
              >
                {running
                  ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <CirclePlay size={18} aria-hidden="true" />}
                <span>
                  <strong>{routine.name}</strong>
                  <small>{scheduleLabel(routine, t)}</small>
                </span>
                {unread ? <i aria-label={t('butler.routines.unreadResultAria')} /> : null}
              </button>
            );
          })}
        </div>

        {!normalizedQuery && filter === 'all' && suggestedTemplates.length > 0 ? (
          <section aria-label={t('butler.routines.suggestionsTitle')} className="butler-scheduled-suggestions">
            <h2>{t('butler.routines.suggestionsTitle')}</h2>
            {suggestedTemplates.map((template) => (
              <button key={template.id} type="button" onClick={() => openManualCreate(templateDraft(template, workspaceRoot, t))}>
                <span className={`butler-suggestion-icon is-${template.category}`}><Bell size={18} aria-hidden="true" /></span>
                <span>
                  <strong>{t(template.titleKey)}</strong>
                  <small>{triggerLabel(template.defaultTrigger, t)}</small>
                  <p>{t(template.descriptionKey)}</p>
                </span>
                <Plus size={17} aria-hidden="true" />
              </button>
            ))}
          </section>
        ) : null}
      </div>

      {panelOpen ? (
        <aside aria-label={t('butler.routines.detailPaneAria')} className="butler-scheduled-detail-pane">
          {detailMode === 'create' ? (
            <ButlerRoutineCreateDialog key={draft?.templateId ?? 'manual'} draft={draft} embedded onClose={closePanel} />
          ) : selected && detailMode === 'edit' ? (
            <ButlerRoutineCreateDialog key={selected.id} routine={selected} embedded onClose={() => setDetailMode('details')} />
          ) : selected ? (
            <>
              <header className="butler-scheduled-detail-header">
                <span>{selected.enabled ? t('butler.routines.statusActive') : t('butler.routines.statusPaused')}</span>
                <div>
                  <div ref={actionMenuRef} className="butler-scheduled-detail-menu">
                    <button type="button" aria-label={t('butler.routines.manageAria', { name: selected.name })} aria-haspopup="menu" aria-expanded={actionMenuOpen} onClick={() => setActionMenuOpen((open) => !open)}>
                      <MoreHorizontal size={18} aria-hidden="true" />
                    </button>
                    {actionMenuOpen ? (
                      <div role="menu">
                        <button type="button" role="menuitem" onClick={() => { setActionMenuOpen(false); setDetailMode('edit'); }}><Pencil size={15} />{t('common.edit')}</button>
                        <button type="button" role="menuitem" onClick={() => void toggleRoutine(selected)}>{selected.enabled ? <Pause size={15} /> : <Play size={15} />}{selected.enabled ? t('butler.routines.pause') : t('butler.routines.resume')}</button>
                        {(selected.targetThreadId || selected.runs.some((run) => run.threadId)) ? (
                          <button type="button" role="menuitem" onClick={() => void openRoutineThread(selected)}><ExternalLink size={15} />{t('butler.routines.openConversation')}</button>
                        ) : null}
                        <button type="button" role="menuitem" onClick={() => requestDeleteRoutine(selected)}><Trash2 size={15} />{t('common.delete')}</button>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    aria-label={t('butler.routines.dryRunAria', { name: selected.name })}
                    title={t('butler.routines.dryRunTitle')}
                    onClick={() => {
                      const preview = dryRunRoutine(selected.id);
                      toast.info(
                        t('butler.routines.dryRunSummary', {
                          status: preview.wouldRun ? t('butler.routines.dryRunReady') : preview.reason,
                          policy: preview.notificationPreview.reason,
                        }),
                      );
                    }}
                  >
                    <Bell size={16} aria-hidden="true" />
                  </button>
                  <button type="button" aria-label={t('butler.routines.runNowAria', { name: selected.name })} disabled={runningIds.includes(selected.id)} onClick={() => void runNow(selected)}>
                    {runningIds.includes(selected.id) ? <Loader2 size={18} className="animate-spin" /> : <CirclePlay size={18} />}
                  </button>
                  <button type="button" aria-label={t('butler.routines.closeDetailAria')} onClick={closePanel}><X size={18} /></button>
                </div>
              </header>
              <h2>{selected.name}</h2>
              <nav aria-label={t('butler.routines.detailTabsAria')}>
                <button type="button" aria-current={detailMode === 'details' ? 'page' : undefined} onClick={() => setDetailMode('details')}>{t('butler.routines.tabDetails')}</button>
                <button type="button" aria-current={detailMode === 'history' ? 'page' : undefined} onClick={() => setDetailMode('history')}>{t('butler.routines.tabHistory')}</button>
              </nav>

              {detailMode === 'history' ? (
                <section aria-label={t('butler.routines.runHistoryAria')} className="butler-scheduled-run-history">
                  <header>
                    <span>{tp(selected.runs.filter((run) => !run.archived).length, 'butler.routines.runCountOne', 'butler.routines.runCountOther')}</span>
                    <div>
                      <button type="button" disabled={!unreadRuns.some((run) => run.routineId === selected.id)} onClick={() => selected.runs.forEach((run) => markRunRead(selected.id, run.id, true))}>
                        <Check size={14} />{t('butler.routines.markAllRead')}
                      </button>
                      <button type="button" onClick={() => archiveRuns(selected.id)}>{t('butler.history.archive')}</button>
                    </div>
                  </header>
                  {selected.runs.filter((run) => !run.archived).length === 0 ? (
                    <div className="butler-scheduled-history-empty"><History size={22} /><span>{t('butler.routines.emptyHistory')}</span></div>
                  ) : selected.runs.filter((run) => !run.archived).map((run) => (
                    <details key={run.id} onToggle={(event) => { if (event.currentTarget.open) markRunRead(selected.id, run.id, true); }}>
                      <summary>
                        {run.status === 'ok' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                        <strong>{selected.name}</strong>
                        <small>{projectName(selected.workspaceRoot, t)}</small>
                        {run.triggerReason ? (
                          <span className="rounded-full bg-fill-1 px-2 py-0.5 text-2xs text-ink-2">
                            {t(`butler.routines.triggerReason.${run.triggerReason}` as MessageKey)}
                          </span>
                        ) : null}
                        <time>{runTime(run.at, locale)}</time>
                        {!run.readAt ? <i aria-label={t('butler.routines.unreadAria')} /> : null}
                      </summary>
                      <div className="butler-routine-result butler-conversation-markdown">{renderMarkdownDoc(run.text)}</div>
                    </details>
                  ))}
                </section>
              ) : (
                <div className="butler-scheduled-detail-content">
                  <section className="butler-scheduled-prompt"><p>{selected.prompt || (selected.skillName ? t('butler.routines.skillPromptFallback', { skillName: selected.skillName }) : t('butler.routines.noPromptFallback'))}</p></section>
                  <h3>{t('butler.routines.tabDetails')}</h3>
                  <dl>
                    <div><dt>{t('butler.routines.runTargetLabel')}</dt><dd>{selected.kind === 'heartbeat' ? t('butler.routines.kindHeartbeat') : t('butler.routines.runTargetNewChat')}</dd></div>
                    <div><dt>{t('butler.routines.fieldProject')}</dt><dd>{projectName(selected.workspaceRoot, t)}</dd></div>
                    <div><dt>{t('butler.routines.fieldModel')}</dt><dd>{selected.model || t('butler.routines.followCurrentSetting')}</dd></div>
                    <div><dt>{t('butler.routines.fieldReasoning')}</dt><dd>{selected.reasoningEffort || t('butler.routines.followCurrentSetting')}</dd></div>
                  </dl>
                  <h3>{t('butler.routines.frequencyHeading')}</h3>
                  <dl><div><dt>{t('butler.routines.fieldRepeat')}</dt><dd>{scheduleLabel(selected, t)}</dd></div><div><dt>{t('butler.routines.fieldNotification')}</dt><dd>{selected.notificationPolicy === 'failed_runs_only' ? t('butler.routines.notifyFailedOnly') : selected.notificationPolicy === 'important_updates' ? t('butler.routines.notifyImportant') : selected.notificationPolicy === 'silent' ? t('butler.routines.notifySilent') : selected.notificationPolicy === 'digest_only' ? t('butler.routines.notifyDigestOnly') : t('butler.routines.notifyAllRuns')}{selected.quietHours ? ` (${selected.quietHours.start}–${selected.quietHours.end})` : ''}</dd></div></dl>
                  <p className="butler-scheduled-file-note">{t('butler.routines.nativeFileNote')}</p>
                </div>
              )}
            </>
          ) : null}
        </aside>
      ) : null}
      {pendingDeleteRoutine ? (
        <ConfirmDialog
          title={t('butler.routines.deleteDialogTitle')}
          message={t('butler.routines.deleteConfirm', { name: pendingDeleteRoutine.name })}
          confirmLabel={t('common.delete')}
          danger
          onConfirm={() => void confirmDeleteRoutine()}
          onClose={() => setPendingDeleteRoutine(null)}
        />
      ) : null}
    </section>
  );
}
