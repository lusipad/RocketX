import {
  AlertCircle,
  AtSign,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import ButlerConnectionsPanel from '../components/ButlerConnectionsPanel';
import ButlerConversation from '../components/ButlerConversation';
import ButlerErrandRunCard from '../components/ButlerErrandRunCard';
import ButlerIdentityPage from '../components/ButlerIdentityPage';
import ButlerInlineExchange from '../components/ButlerInlineExchange';
import ButlerRoutineCreateDialog from '../components/ButlerRoutineCreateDialog';
import ButlerRoutines from '../components/ButlerRoutines';
import ButlerWorkspaceNav from '../components/ButlerWorkspaceNav';
import ButlerSkillMenu, { useButlerSkillMenu } from '../components/ButlerSkillMenu';
import {
  butlerOperationJournal,
  createExplicitButlerSkillDraft,
  recordButlerConversationTurn,
} from '../butler/extensions/learning/runtime';
import { isButlerSkillDraftRequest } from '../butler/extensions/learning/conversationReceipt';
import type { ButlerOperationInput } from '../butler/extensions/learning/operationJournalExtension';
import {
  buildButlerPaperViewModel,
  butlerBriefForDate,
  butlerPaperDateKey,
  formatButlerPaperDate,
  shiftButlerPaperDate,
  shouldExpandButlerConversation,
} from '../lib/butlerPaper';
import { renderMarkdown } from '../lib/markdown';
import {
  runDailyButlerRoundsIfNeeded,
  runButlerRoundsNow,
  restoreButlerRoundsItem,
  snoozeButlerRoundsItem,
  useButlerRoundsRunner,
  visibleButlerRoundItems,
} from '../lib/butlerRoundsRunner';
import {
  buildButlerWorkspaceModel,
  type ButlerWorkspaceView,
} from '../lib/butlerWorkspace';
import { useAuth } from '../stores/auth';
import { useButlerAttention } from '../stores/butlerAttention';
import { useButlerIdentity } from '../stores/butlerIdentity';
import { appendButlerLine, useButler } from '../stores/butler';
import { useChat } from '../stores/chat';
import {
  useRoutines,
  type ButlerEventCard,
  type Routine,
  type RoutineRun,
} from '../stores/routines';
import { dueLabel, isOverdue, useTodos, type Todo } from '../stores/todos';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';

const BRIEF_PAGE_SIZE = 5;
const TODO_PAGE_SIZE = 5;

function paperTodoTitle(todo: Todo): string {
  return todo.note || todo.excerpt || todo.title || '（无文字内容）';
}

interface RoutinePaperReport {
  routine: Routine;
  run: RoutineRun;
}

function displayAutomationTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function automationPreview(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line
      .replace(/^\s*(?:#{1,6}|[-*+]|\d+\.)\s*/, '')
      .replace(/[*_`]/g, '')
      .trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' · ');
}

function eventRoomLabel(card: ButlerEventCard): string {
  return card.title
    .replace(/^@我未回应：/, '')
    .replace(/（\d+小时前）$/, '')
    .trim() || '对应房间';
}

function ButlerAutomationPaper({
  reports,
  eventCards,
  interactive,
  onRunNow,
  onOpenEvent,
  onDismissEvent,
}: {
  reports: RoutinePaperReport[];
  eventCards: ButlerEventCard[];
  interactive: boolean;
  onRunNow: (id: string) => Promise<void>;
  onOpenEvent: (card: ButlerEventCard) => Promise<void>;
  onDismissEvent: (id: string) => void;
}) {
  if (reports.length === 0 && eventCards.length === 0) return null;

  return (
    <section aria-label="消息与提醒">
      <h2 className="text-base font-semibold text-ink">消息与提醒</h2>
      <div className="mt-2 border-y border-line/70">
        {eventCards.map((card) => {
          const room = eventRoomLabel(card);
          return (
            <div
              key={card.id}
              className="flex min-w-0 items-center gap-3 border-b border-line/70 px-1 py-3 last:border-b-0"
            >
              <AtSign size={15} className="shrink-0 text-primary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{card.title}</p>
                <p className="mt-0.5 truncate text-xs text-ink-3">{card.detail}</p>
              </div>
              {interactive ? (
                <>
                  <button
                    type="button"
                    aria-label={`查看 ${room} 的 @我`}
                    onClick={() => void onOpenEvent(card)}
                    className="shrink-0 rounded px-1.5 py-1 text-xs text-primary transition-colors hover:bg-fill-hover hover:text-primary-hover"
                  >
                    去看看
                  </button>
                  <button
                    type="button"
                    aria-label={`关闭提醒${card.title}`}
                    title="关闭提醒"
                    onClick={() => onDismissEvent(card.id)}
                    className="shrink-0 rounded p-1 text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
                  >
                    <X size={13} />
                  </button>
                </>
              ) : null}
            </div>
          );
        })}
        {reports.map((report) => (
          <details
            key={`${report.routine.id}:${report.run.id}`}
            className="group border-b border-line/70 px-1 py-3 last:border-b-0"
          >
            <summary
              role="button"
              aria-label={`展开${report.routine.name}报告`}
              className="flex cursor-pointer list-none items-center gap-3 outline-none [&::-webkit-details-marker]:hidden"
            >
              {report.run.status === 'ok' ? (
                <CheckCircle2 size={15} className="shrink-0 text-success" aria-hidden="true" />
              ) : (
                <AlertCircle size={15} className="shrink-0 text-danger" aria-hidden="true" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">
                  {report.run.status === 'ok'
                    ? report.routine.name
                    : `${report.routine.name}没有生成`}
                </span>
                <span
                  aria-label={`${report.routine.name}摘要`}
                  className="mt-0.5 block truncate text-xs font-normal text-ink-3 group-open:hidden"
                >
                  {automationPreview(report.run.text)}
                </span>
              </span>
              <span className="shrink-0 text-xs text-ink-3">
                {displayAutomationTime(report.run.at)}
              </span>
              <ChevronRight
                size={13}
                aria-hidden="true"
                className="shrink-0 text-ink-3 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
              />
            </summary>
            <div className="ml-7 mt-2 text-sm leading-6 text-ink-2">
              {report.run.status === 'ok'
                ? renderMarkdown(report.run.text)
                : <p className="text-danger">{report.run.text}</p>}
              {interactive && report.run.status === 'error' ? (
                <button
                  type="button"
                  aria-label={`重试${report.routine.name}`}
                  onClick={() => void onRunNow(report.routine.id)}
                  className="mt-2 rounded px-1.5 py-1 text-xs text-primary transition-colors hover:bg-fill-hover hover:text-primary-hover"
                >
                  重试
                </button>
              ) : null}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

export default function ButlerPage() {
  const identity = useButlerIdentity((state) => state.identity);
  const today = butlerPaperDateKey(new Date());
  const [briefOffset, setBriefOffset] = useState(0);
  const [routineCreateOpen, setRoutineCreateOpen] = useState(false);
  const [input, setInput] = useState('');
  const skillMenu = useButlerSkillMenu(input, setInput);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const [inlineRange, setInlineRange] = useState<{
    start: number;
    end: number | null;
  } | null>(null);
  const activeView = useUI((state) => state.butlerView);
  const paperDate = useUI((state) => state.butlerPaperDate);
  const paperConversation = useUI((state) => state.butlerPaperConversation);
  const setSelectedDate = useUI((state) => state.setButlerPaperDate);
  const setPaperConversation = useUI((state) => state.setButlerPaperConversation);
  const setModule = useUI((state) => state.setModule);
  const openConversationStore = useUI((state) => state.openButlerConversation);
  const openManage = useUI((state) => state.openButlerManage);
  const setButlerView = useUI((state) => state.setButlerView);
  const lines = useButler((state) => state.lines);
  const activeSessionId = useButler((state) => state.activeSessionId);
  const errands = useButler((state) => state.errands);
  const butlerRunning = useButler((state) => state.running);
  const butlerActivity = useButler((state) => state.activity);
  const askButler = useButler((state) => state.ask);
  const stopButler = useButler((state) => state.stop);
  const hydrateButler = useButler((state) => state.hydrate);
  const userId = useAuth((state) => state.user?._id);
  const acknowledgedNeedIds = useButlerAttention((state) => state.acknowledgedNeedIds);
  const acknowledgeNeed = useButlerAttention((state) => state.acknowledge);
  const restoreNeed = useButlerAttention((state) => state.restore);
  const lastResult = useButlerRoundsRunner((state) => state.lastResult);
  const roundsRunning = useButlerRoundsRunner((state) => state.running);
  const roundsError = useButlerRoundsRunner((state) => state.error);
  const routines = useRoutines((state) => state.routines);
  const eventCards = useRoutines((state) => state.eventCards);
  const runRoutineNow = useRoutines((state) => state.runNow);
  const dismissCard = useRoutines((state) => state.dismissCard);
  const hydrateRoutines = useRoutines((state) => state.hydrate);
  const loadRoutineTemplate = useRoutines((state) => state.loadTemplate);
  const setRoutineEnabled = useRoutines((state) => state.setEnabled);
  const recordOperation = (
    action: ButlerOperationInput['action'],
    intentKey: string,
    surface: string,
    options: Omit<ButlerOperationInput, 'action' | 'intentKey' | 'surface'> = {},
  ): void => {
    butlerOperationJournal.record({ action, intentKey, surface, ...options });
  };
  const todos = useTodos((state) => state.todos);
  const addTodo = useTodos((state) => state.add);
  const removeTodo = useTodos((state) => state.remove);
  const toggleTodo = useTodos((state) => state.toggle);
  const watchedCount = routines.filter((routine) => routine.enabled).length;
  const selectedDate = paperDate ?? today;
  const selectedBrief = useMemo(
    () => butlerBriefForDate(lastResult, selectedDate),
    [lastResult, selectedDate],
  );
  const paper = useMemo(
    () => buildButlerPaperViewModel({
      dateKey: selectedDate,
      todayKey: today,
      runs: errands,
      todos,
      brief: selectedBrief,
    }),
    [errands, selectedBrief, selectedDate, today, todos],
  );
  const isToday = paper.isToday;
  const sections = paper.errands;
  const archivedRuns = paper.archived;
  const paperTodos = paper.todos;
  const visiblePaperTodos = paperTodos.slice(0, TODO_PAGE_SIZE);
  const remainingTodos = Math.max(0, paperTodos.length - TODO_PAGE_SIZE);
  const paperBrief = paper.brief;
  const allBriefItems = useMemo(() => visibleButlerRoundItems(paperBrief), [paperBrief]);
  const paperTodoRefs = useMemo(
    () => new Set(paperTodos.map((todo) => `todo:${todo.id}`)),
    [paperTodos],
  );
  const briefItems = useMemo(
    () => (
      isToday
        ? allBriefItems.filter((item) => !paperTodoRefs.has(item.ref))
        : allBriefItems
    ),
    [allBriefItems, isToday, paperTodoRefs],
  );
  const routineReports = useMemo<RoutinePaperReport[]>(
    () => routines
      .flatMap((routine) => {
        const run = routine.runs.find(
          (candidate) => butlerPaperDateKey(new Date(candidate.at)) === selectedDate,
        );
        return run ? [{ routine, run }] : [];
      })
      .sort((left, right) => right.run.at - left.run.at),
    [routines, selectedDate],
  );
  const paperEventCards = isToday ? eventCards : [];
  const visibleBriefItems = briefItems.slice(briefOffset, briefOffset + BRIEF_PAGE_SIZE);
  const paperConversationMatches = paperConversation?.date === selectedDate
    && paperConversation.sessionId === activeSessionId;
  const retainedQuestionIndex = paperConversationMatches
    && paperConversation.questionId
    ? lines.findIndex((line) => line.id === paperConversation.questionId)
    : -1;
  const retainedQuestionEnd = retainedQuestionIndex < 0
    ? -1
    : lines.findIndex(
      (line, index) => index > retainedQuestionIndex && line.role === 'user',
    );
  const retainedInlineLines = retainedQuestionIndex < 0
    ? []
    : lines.slice(
      retainedQuestionIndex,
      retainedQuestionEnd < 0 ? undefined : retainedQuestionEnd,
    );
  const inlineLines = !paperConversationMatches
    ? []
    : inlineRange === null
      ? retainedInlineLines
      : lines.slice(inlineRange.start, inlineRange.end ?? undefined);
  const inlineQuestion = [...inlineLines].reverse().find((line) => line.role === 'user');
  const inlineError = inlineQuestion?.id === paperConversation?.questionId
    ? paperConversation?.error ?? null
    : null;
  const paperEmpty = sections.approvals.length === 0
    && sections.active.length === 0
    && paperTodos.length === 0
    && briefItems.length === 0
    && routineReports.length === 0
    && paperEventCards.length === 0
    && !roundsRunning
    && !roundsError;
  const workspace = useMemo(
    () => buildButlerWorkspaceModel({
      errands,
      todos,
      routines,
      eventCards,
      rounds: lastResult,
      acknowledgedNeedIds,
    }),
    [acknowledgedNeedIds, errands, eventCards, lastResult, routines, todos],
  );
  const visibleErrands = useMemo(
    () => errands.filter((run) => !run.archivedAt),
    [errands],
  );

  useEffect(() => {
    void runDailyButlerRoundsIfNeeded();
    hydrateRoutines();
  }, [hydrateRoutines]);

  useEffect(() => {
    if (userId) void hydrateButler();
  }, [hydrateButler, userId]);

  useEffect(() => {
    setBriefOffset(0);
  }, [selectedDate]);

  const askFromPaper = async (question: string, advanceRound = true): Promise<void> => {
    const text = question.trim();
    if (!text || butlerRunning) return;
    await hydrateButler();
    if (useButler.getState().running) return;
    const sessionId = useButler.getState().activeSessionId;
    const before = useButler.getState();
    if (isButlerSkillDraftRequest(text) && before.taskState?.status === 'completed') {
      const start = before.lines.length;
      const sourceLineIds = before.lines.slice(-2).map((line) => line.id);
      setInput('');
      openConversationStore();
      appendButlerLine('user', text);
      appendButlerLine('assistant', '我已经把刚才的做法整理成草稿。先看一遍，确认后才会保存到技能中心。');
      const current = useButler.getState();
      createExplicitButlerSkillDraft({
        task: before.taskState,
        sessionId,
        lineIds: [...sourceLineIds, ...current.lines.slice(start).map((line) => line.id)],
        steps: before.steps,
      });
      return;
    }
    const previousPaperConversation = useUI.getState().butlerPaperConversation;
    const previousRound = (
      previousPaperConversation?.date === selectedDate
        && previousPaperConversation.sessionId === sessionId
        ? previousPaperConversation.rounds
        : 0
    );
    const nextRound = advanceRound ? previousRound + 1 : Math.max(previousRound, 1);
    setPaperConversation({
      date: selectedDate,
      sessionId,
      rounds: nextRound,
      questionId: previousPaperConversation?.date === selectedDate
        && previousPaperConversation.sessionId === sessionId
        ? previousPaperConversation.questionId
        : null,
      error: null,
    });
    setInput('');
    const start = useButler.getState().lines.length;
    if (shouldExpandButlerConversation(nextRound)) {
      openConversationStore();
      try {
        await askButler(text);
      } finally {
        const current = useButler.getState();
        recordButlerConversationTurn({
          task: current.taskState,
          surface: 'now',
          sessionId: current.activeSessionId,
          lineIds: current.lines.slice(start).map((line) => line.id),
          steps: current.steps,
        });
      }
      const submittedQuestion = useButler.getState().lines
        .slice(start)
        .find((line) => line.role === 'user');
      setPaperConversation({
        date: selectedDate,
        sessionId,
        rounds: nextRound,
        questionId: submittedQuestion?.id ?? null,
        error: useButler.getState().error,
      });
      return;
    }
    setInlineRange({ start, end: null });
    try {
      await askButler(text);
    } finally {
      const latestLines = useButler.getState().lines;
      const current = useButler.getState();
      recordButlerConversationTurn({
        task: current.taskState,
        surface: 'now',
        sessionId: current.activeSessionId,
        lineIds: latestLines.slice(start).map((line) => line.id),
        steps: current.steps,
      });
      const end = latestLines.length;
      const submittedQuestion = latestLines
        .slice(start)
        .find((line) => line.role === 'user');
      setPaperConversation({
        date: selectedDate,
        sessionId,
        rounds: nextRound,
        questionId: submittedQuestion?.id ?? null,
        error: useButler.getState().error,
      });
      setInlineRange((current) => (
        current?.start === start ? { start, end } : current
      ));
    }
  };

  const submitQuestion = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void askFromPaper(input);
  };

  const openEventCard = async (card: ButlerEventCard): Promise<void> => {
    recordOperation('open-view', 'view:mention-context', 'now');
    setModule('messages');
    if (card.rid) await useChat.getState().openRoom(card.rid);
  };

  const enableStarterRoutine = (): void => {
    const routine = loadRoutineTemplate('mention-triage');
    if (routine && !routine.enabled) setRoutineEnabled(routine.id, true);
    if (routine) recordOperation('run-routine', 'routine:butler-reply-guardian', 'routines');
  };

  const acceptSuggestion = (item: {
    ref: string;
    why: string;
    suggestedAction?: string;
  }): void => {
    const title = paperBrief?.refTitles[item.ref] ?? '管家主动发现';
    const id = addTodo({
      source: 'manual',
      title,
      note: item.suggestedAction || item.why,
    });
    recordOperation('create-task', 'task:from-butler-suggestion', 'now');
    snoozeButlerRoundsItem(item.ref);
    toast.undo(`已转为待办：「${title}」`, () => {
      removeTodo(id);
      restoreButlerRoundsItem(item.ref);
    });
  };

  const dismissSuggestion = (ref: string): void => {
    if (!snoozeButlerRoundsItem(ref)) return;
    recordOperation('dismiss-suggestion', 'suggestion:proactive', 'now');
    toast.undo('已忽略这条建议', () => restoreButlerRoundsItem(ref));
  };

  const selectButlerView = (view: ButlerWorkspaceView): void => {
    setButlerView(view);
    recordOperation('open-view', `view:${view}`, 'butler-workspace');
  };

  const runRoutineFromPaper = async (id: string): Promise<void> => {
    await runRoutineNow(id);
    recordOperation('run-routine', `routine:${id}`, 'now');
  };

  const acknowledgeNeedToKnow = (id: string): void => {
    acknowledgeNeed(id);
    toast.undo('已标记为知道了，原责任仍然保留', () => restoreNeed(id));
  };

  return (
    <div className="butler-workspace">
      <ButlerWorkspaceNav
        active={activeView}
        delegationAttention={workspace.delegations.filter((task) => (
          task.state === 'needs-user' || task.state === 'delivered' || task.state === 'failed'
        )).length}
        routineFailures={workspace.summary.routineFailures}
        onSelect={selectButlerView}
      />
      <div className="butler-workspace-stage flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-3">
      {activeView === 'now' ? (
        <header className="shrink-0 px-6 pb-0 pt-3">
          <div className="mx-auto flex w-full max-w-[1080px] items-center justify-end">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label="前一天"
                title="看前一天"
                onClick={() => setSelectedDate(shiftButlerPaperDate(selectedDate, -1))}
                className="flex h-7 w-7 items-center justify-center rounded text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
              >
                <ChevronLeft size={16} />
              </button>
              <h1 className="text-xs font-medium text-ink-3">
                {formatButlerPaperDate(selectedDate)}
              </h1>
              <button
                type="button"
                aria-label="后一天"
                title={isToday ? '已经是今天' : '看后一天'}
                disabled={isToday}
                onClick={() => setSelectedDate(shiftButlerPaperDate(selectedDate, 1))}
                className="flex h-7 w-7 items-center justify-center rounded text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink disabled:text-ink-3/35 disabled:hover:bg-transparent"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </header>
      ) : null}

      <main
        className={`min-h-0 flex-1 ${
          activeView === 'conversation' ? 'overflow-hidden p-0' : 'overflow-y-auto px-6 pb-10'
        }`}
      >
        <div
          className={activeView === 'now'
            ? 'butler-workspace-content'
            : `mx-auto w-full ${
              activeView === 'conversation' ? 'h-full' : 'max-w-[760px] space-y-9'
            }`
          }
        >
          <div className={
            activeView === 'now'
              ? 'butler-workspace-main space-y-9'
              : activeView === 'conversation'
                ? 'h-full min-h-0'
                : undefined
          }>
          {activeView === 'conversation' ? (
            <section aria-label="完整对话" className="h-full">
              <ButlerConversation embedded />
            </section>
          ) : activeView === 'routines' ? (
            <section aria-label="定时任务">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <span className="butler-eyebrow">自动执行</span>
                  <h2 className="butler-page-title">定时任务</h2>
                  <p className="mt-1 text-sm text-ink-2">
                    只在你设定的时间运行；在这里检查状态、最近结果和失败原因。
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="新建定时任务"
                  onClick={() => setRoutineCreateOpen(true)}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded bg-primary px-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
                >
                  <Plus size={15} aria-hidden="true" />
                  新建定时任务
                </button>
              </div>
              <div className="mt-8">
                <ButlerRoutines />
              </div>
              {routineCreateOpen ? (
                <ButlerRoutineCreateDialog onClose={() => setRoutineCreateOpen(false)} />
              ) : null}
            </section>
          ) : activeView === 'memory' ? (
            <ButlerIdentityPage initialTab="memory" />
          ) : activeView === 'connections' ? (
            <ButlerConnectionsPanel />
          ) : activeView === 'tasks' ? (
            <section aria-label="管家委托">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <span className="butler-eyebrow">异步执行</span>
                  <h2 className="butler-page-title">委托</h2>
                  <p className="mt-1 text-sm text-ink-2">
                    这里只放明确交给管家执行的工作；你的普通待办仍留在“待办”。
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="新建委托"
                  onClick={() => selectButlerView('conversation')}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded bg-primary px-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover"
                >
                  <Plus size={15} aria-hidden="true" />
                  新建委托
                </button>
              </div>
              {visibleErrands.length > 0 ? (
                <div className="mt-8">
                  <ButlerErrandRunCard runs={visibleErrands} onAsk={askFromPaper} />
                </div>
              ) : (
                <div className="mt-10 border-l-2 border-line pl-4">
                  <h3 className="text-sm font-medium text-ink">还没有委托</h3>
                  <p className="mt-1 text-sm text-ink-2">
                    在对话里明确说“帮我完成”或从消息、PR 上选择“交给管家”，才会在这里启动运行。
                  </p>
                  <button
                    type="button"
                    onClick={() => selectButlerView('conversation')}
                    className="mt-3 text-sm text-primary hover:underline"
                  >
                    去和管家对话
                  </button>
                </div>
              )}
            </section>
          ) : isToday ? (
            <>
              <section aria-label="管家今日概况">
                <span className="butler-eyebrow">主动工作驾驶舱</span>
                <h2 className="butler-page-title">
                  {workspace.summary.needsAttention > 0
                    ? `早上好，今天有 ${workspace.summary.needsAttention} 件事值得你先看`
                    : '早上好，现在没有需要你处理的'}
                </h2>
                <p className="mt-1 text-sm text-ink-2">
                  我看过最近的消息、责任和运行状态；正在照看 {workspace.summary.watched} 项例行责任，
                  推进 {workspace.summary.activeDelegations} 项委托。
                </p>
              </section>

              <section aria-label="统一 Composer" className="butler-composer">
                <div className="butler-composer-context">
                  <span>#当前工作面</span>
                  <button type="button" onClick={() => selectButlerView('tasks')}>引用任务</button>
                  <button type="button" onClick={() => selectButlerView('routines')}>创建例行照看</button>
                </div>
                <form onSubmit={submitQuestion} className="relative">
                  <ButlerSkillMenu
                    options={skillMenu.options}
                    activeIndex={skillMenu.activeIndex}
                    onPick={skillMenu.pick}
                    onHover={skillMenu.setActiveIndex}
                  />
                  <input
                    ref={composerInputRef}
                    value={input}
                    onChange={(event) => {
                      setInput(event.target.value);
                      skillMenu.reopen();
                    }}
                    onKeyDown={(event) => {
                      if (skillMenu.handleKeyDown(event, skillMenu.pick)) return;
                    }}
                    onBlur={() => skillMenu.dismiss()}
                    placeholder="问、交代或创建，例如：把这个 PR 的风险查清，下午三点前给我结论"
                    aria-label="跟管家说件事"
                  />
                  <div className="butler-composer-actions">
                    <div>
                      <button type="button" onClick={() => selectButlerView('routines')}>
                        创建
                        <ChevronDown size={13} />
                      </button>
                    </div>
                    {butlerRunning ? (
                      <button type="button" aria-label="停止回答" onClick={() => void stopButler()}>
                        <Square size={14} />
                        停止
                      </button>
                    ) : (
                      <button type="submit" disabled={!input.trim()} className="butler-composer-submit">
                        交给{identity.displayName}
                        <Send size={14} />
                      </button>
                    )}
                  </div>
                </form>
                <button
                  type="button"
                  aria-label={watchedCount > 0
                    ? `正在照看 ${watchedCount} 项责任，打开管理`
                    : '自动整理未开启，打开设置'}
                  onClick={openManage}
                  className="butler-composer-status"
                >
                  {watchedCount > 0
                    ? `已在照看 ${watchedCount} 项责任`
                    : '自动整理未开启 · 设置'}
                </button>
              </section>

              {workspace.summary.activationNeeded ? (
                <section aria-label="管家首次启用" className="butler-activation">
                  <div>
                    <span className="butler-eyebrow">第一次价值</span>
                    <h2>不用搭建，从一件真实工作开始</h2>
                    <p>
                      管家可以先只读整理最近工作，也可以开启对未回应 @ 的持续检查。
                      它不会因为启用而获得发送或修改权限。
                    </p>
                  </div>
                  <div className="butler-activation-actions">
                    <button
                      type="button"
                      onClick={() => void runButlerRoundsNow(new Date(), 'first-value')}
                      disabled={roundsRunning}
                    >
                      {roundsRunning ? '正在扫描…' : '扫描最近工作'}
                    </button>
                    <button type="button" onClick={enableStarterRoutine}>
                      开启待回复守护
                    </button>
                    <button
                      type="button"
                      onClick={() => composerInputRef.current?.focus()}
                    >
                      先交代一件事
                    </button>
                  </div>
                  {roundsError ? (
                    <p className="butler-activation-error">
                      最近一次扫描没有完成：{roundsError}
                      <button type="button" onClick={() => void runButlerRoundsNow(new Date(), 'first-value-retry')}>
                        重试
                      </button>
                    </p>
                  ) : null}
                </section>
              ) : null}

              {workspace.needToKnow.length > 0 ? (
                <section aria-label="需要知道">
                  <div className="flex items-baseline gap-2">
                    <h2 className="text-base font-semibold text-ink">需要知道</h2>
                    <span className="text-xs text-danger">{workspace.needToKnow.length}</span>
                  </div>
                  <div className="mt-2 border-y border-line/70">
                    {workspace.needToKnow.slice(0, 3).map((item) => (
                      <article key={item.id} className="flex gap-3 border-b border-line/70 px-1 py-3.5 last:border-b-0">
                        <AlertCircle size={16} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                          <h3 className="text-sm font-semibold text-ink">{item.title}</h3>
                          <p className="mt-1 text-xs leading-5 text-ink-2">{item.whyNow}</p>
                          <p className="text-xs leading-5 text-ink-3">{item.consequence}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {item.kind === 'stale-mention' ? (
                            <button
                              type="button"
                              onClick={() => {
                                const card = eventCards.find((candidate) => candidate.id === item.sourceId);
                                if (card) void openEventCard(card);
                              }}
                              className="h-8 rounded px-2 text-xs text-primary hover:bg-fill-hover"
                            >
                              去处理
                            </button>
                          ) : item.kind === 'routine-failure' ? (
                            <button
                              type="button"
                              onClick={() => selectButlerView('routines')}
                              className="h-8 rounded px-2 text-xs text-primary hover:bg-fill-hover"
                            >
                              查看并修复
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => selectButlerView('tasks')}
                              className="h-8 rounded px-2 text-xs text-primary hover:bg-fill-hover"
                            >
                              查看任务
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => acknowledgeNeedToKnow(item.id)}
                            className="h-8 rounded px-2 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink"
                          >
                            知道了
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              {briefItems.length > 0 ? (
                <section aria-label="我主动发现">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="flex items-baseline gap-2">
                      <h2 className="text-base font-semibold text-ink">我主动发现</h2>
                      <span className="text-xs text-ink-3">{briefItems.length}</span>
                    </div>
                    <span className="text-[11px] text-ink-3">根据真实工作变化生成</span>
                  </div>
                  <div className="mt-2 border-y border-line/70">
                    {visibleBriefItems.map((item, index) => (
                      <article key={`${item.ref}:${briefOffset + index}`} className="border-b border-line/70 py-3.5 last:border-b-0">
                        <div className="flex items-start gap-3">
                          <Sparkles size={15} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-semibold text-ink">
                              {paperBrief?.refTitles[item.ref] ?? '相关事项'}
                            </h3>
                            <p className="mt-1 text-xs leading-5 text-ink-2">{item.why}</p>
                            {item.suggestedAction ? (
                              <p className="text-xs leading-5 text-ink-3">{item.suggestedAction}</p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {item.suggestedAction ? (
                              <button
                                type="button"
                                onClick={() => acceptSuggestion(item)}
                                className="h-8 rounded bg-fill-1 px-2.5 text-xs text-ink hover:bg-fill-hover"
                              >
                                转为待办
                              </button>
                            ) : null}
                            <button
                              type="button"
                              aria-label={`忽略建议${paperBrief?.refTitles[item.ref] ?? item.ref}`}
                              onClick={() => dismissSuggestion(item.ref)}
                              className="h-8 rounded px-2 text-xs text-ink-3 hover:bg-fill-hover hover:text-ink"
                            >
                              忽略
                            </button>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              <ButlerErrandRunCard onAsk={askFromPaper} />

              {paperTodos.length > 0 ? (
                <section aria-label="待办">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-baseline gap-2">
                      <h2 className="text-base font-semibold text-ink">待办</h2>
                      <span className="text-xs text-ink-3">{paperTodos.length}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setModule('todos')}
                      aria-label="查看全部待办"
                      title="打开待办"
                      className="flex items-center gap-0.5 rounded px-1 py-0.5 text-xs text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
                    >
                      全部
                      <ChevronRight size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <div className="mt-2 border-y border-line/70">
                    {visiblePaperTodos.map((todo) => {
                      const title = paperTodoTitle(todo);
                      const overdue = isOverdue(todo, today);
                      const insight = allBriefItems.find(
                        (item) => item.ref === `todo:${todo.id}`,
                      );
                      return (
                        <div
                          key={todo.id}
                          className="group flex items-start gap-3 border-b border-line/70 px-1 py-3.5 transition-colors last:border-b-0 hover:bg-fill-hover/30"
                        >
                          <button
                            type="button"
                            onClick={() => toggleTodo(todo.id)}
                            aria-label={`完成待办：${title}`}
                            title="标记为完成"
                            className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line-strong text-ink-2 transition hover:border-primary hover:bg-primary-light hover:text-primary active:scale-90 motion-reduce:transition-none"
                          >
                            <Check size={14} strokeWidth={2} />
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className="break-words text-base font-medium leading-6 text-ink">
                              {title}
                            </p>
                            {todo.due || todo.committedTo || todo.waitingFor || todo.roomName ? (
                              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                                {todo.due ? (
                                  <span className={overdue ? 'font-medium text-danger' : undefined}>
                                    {dueLabel(todo.due, today)}
                                  </span>
                                ) : null}
                                {todo.committedTo ? <span>答应给 {todo.committedTo}</span> : null}
                                {todo.waitingFor ? <span>在等 {todo.waitingFor}</span> : null}
                                {todo.roomName ? <span>{todo.roomName}</span> : null}
                              </div>
                            ) : null}
                            {insight ? (
                              <details className="mt-1.5 text-xs text-ink-2 [&[open]_.todo-insight-chevron]:rotate-90">
                                <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-primary-light [&::-webkit-details-marker]:hidden">
                                  <ChevronRight
                                    size={12}
                                    aria-hidden="true"
                                    className="todo-insight-chevron transition-transform duration-150 motion-reduce:transition-none"
                                  />
                                  查看原因与建议
                                </summary>
                                <div className="ml-[5px] mt-2 grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2 gap-y-1 border-l border-line pl-3 leading-5">
                                  <span className="text-ink-3">原因</span>
                                  <p>{insight.why}</p>
                                  {insight.suggestedAction ? (
                                    <>
                                      <span className="text-primary">建议</span>
                                      <p className="text-ink">{insight.suggestedAction}</p>
                                    </>
                                  ) : null}
                                </div>
                              </details>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {remainingTodos > 0 ? (
                    <button
                      type="button"
                      onClick={() => setModule('todos')}
                      className="mt-2 text-xs text-ink-3 transition-colors hover:text-ink"
                    >
                      还有 {remainingTodos} 项 ›
                    </button>
                  ) : null}
                </section>
              ) : null}

              <ButlerAutomationPaper
                reports={routineReports}
                eventCards={paperEventCards}
                interactive
                onRunNow={runRoutineFromPaper}
                onOpenEvent={openEventCard}
                onDismissEvent={dismissCard}
              />

              {roundsRunning && !paperBrief ? (
                <section
                  aria-label="今日整理状态"
                  className="flex items-center gap-2 text-sm text-ink-3"
                >
                  <LoaderCircle
                    size={14}
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                  />
                  <span>正在整理今天…</span>
                </section>
              ) : roundsError ? (
                <section
                  aria-label="今日整理状态"
                  className="flex items-center gap-2 text-sm text-ink-3"
                  title={roundsError}
                >
                  <AlertCircle size={14} aria-hidden="true" />
                  <span>今天的整理没有完成</span>
                  <button
                    type="button"
                    onClick={() => void runButlerRoundsNow(new Date(), 'manual')}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-primary transition-colors hover:bg-fill-hover hover:text-primary-hover"
                  >
                    <RefreshCw size={12} aria-hidden="true" />
                    重试
                  </button>
                </section>
              ) : null}

              {inlineLines.length > 0 ? (
                <section aria-label="临时问答">
                  <h2 className="text-base font-semibold text-ink">临时问答</h2>
                  <div className="mt-3">
                    <ButlerInlineExchange
                      lines={inlineLines}
                      running={butlerRunning}
                      activity={butlerActivity}
                      error={inlineError}
                      onRetry={inlineQuestion
                        ? () => { void askFromPaper(inlineQuestion.text, false); }
                        : undefined}
                    />
                  </div>
                </section>
              ) : null}

              {paperEmpty && inlineLines.length === 0 && !workspace.summary.activationNeeded ? (
                <section className="pt-10 text-center" aria-label="管家空状态">
                  <p className="text-base text-ink-2">今天还没有事。</p>
                  <p className="mt-2 text-sm text-ink-3">有事直接说，没事就让这张纸空着。</p>
                </section>
              ) : null}
            </>
          ) : (
            <>
              {archivedRuns.length > 0 ? (
                <ButlerErrandRunCard runs={archivedRuns} archived />
              ) : null}
              {briefItems.length > 0 ? (
                <section aria-label="那天">
                  <h2 className="text-base font-semibold text-ink">那天</h2>
                  <div className="mt-3 space-y-4">
                    {visibleBriefItems.map((item, index) => (
                      <article key={`${item.ref}:${briefOffset + index}`}>
                        <h3 className="text-sm font-medium text-ink">
                          {paperBrief?.refTitles[item.ref] ?? '相关事项'}
                        </h3>
                        <p className="mt-1 text-xs leading-5 text-ink-2">{item.why}</p>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
              <ButlerAutomationPaper
                reports={routineReports}
                eventCards={[]}
                interactive={false}
                onRunNow={runRoutineFromPaper}
                onOpenEvent={openEventCard}
                onDismissEvent={dismissCard}
              />
              {archivedRuns.length === 0
                && briefItems.length === 0
                && routineReports.length === 0 ? (
                <p className="pt-16 text-center text-sm text-ink-3">这天没有留下记录</p>
              ) : null}
            </>
          )}
          </div>
          {activeView === 'now' ? (
            <aside className="butler-workspace-aside" aria-label="管家上下文">
              <section>
                <h3 className="flex items-center gap-1.5">
                  <CalendarDays size={14} aria-hidden="true" />
                  今天
                </h3>
                <ul className="mt-2 space-y-1">
                  {workspace.personalTasks.filter((task) => task.nextAt).slice(0, 3).map((task) => (
                    <li key={task.id}>{task.nextAt} · {task.title}</li>
                  ))}
                  {workspace.personalTasks.every((task) => !task.nextAt) ? <li>暂无明确截止事项</li> : null}
                </ul>
              </section>
              <section>
                <h3>例行照看</h3>
                <p className="mt-2">
                  {workspace.summary.watched} 项启用
                  {workspace.summary.routineFailures > 0
                    ? ` · ${workspace.summary.routineFailures} 项需要修复`
                    : ' · 当前健康'}
                </p>
                <button
                  type="button"
                  onClick={() => selectButlerView('routines')}
                  className="mt-2 text-xs text-primary hover:underline"
                >
                  查看全部
                </button>
              </section>
              <section>
                <h3>快捷动作</h3>
                <div className="mt-2 flex flex-col items-start gap-1">
                  <button type="button" onClick={() => selectButlerView('conversation')} className="text-xs text-primary hover:underline">
                    交代一件事
                  </button>
                  <button type="button" onClick={() => selectButlerView('routines')} className="text-xs text-primary hover:underline">
                    创建例行照看
                  </button>
                  <button type="button" onClick={() => selectButlerView('tasks')} className="text-xs text-primary hover:underline">
                    查看全部委托
                  </button>
                </div>
              </section>
            </aside>
          ) : null}
        </div>
      </main>

      </div>
    </div>
  );
}
