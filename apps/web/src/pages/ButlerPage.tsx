import {
  AlertCircle,
  AtSign,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  History,
  LoaderCircle,
  RefreshCw,
  Send,
  Settings2,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import ButlerAuditTrail from '../components/ButlerAuditTrail';
import ButlerConversation from '../components/ButlerConversation';
import ButlerErrandRunCard from '../components/ButlerErrandRunCard';
import ButlerInlineExchange from '../components/ButlerInlineExchange';
import ButlerLearnedPanel from '../components/ButlerLearnedPanel';
import ButlerRoutines from '../components/ButlerRoutines';
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
  useButlerRoundsRunner,
  visibleButlerRoundItems,
} from '../lib/butlerRoundsRunner';
import { useAuth } from '../stores/auth';
import { useButler } from '../stores/butler';
import { useChat } from '../stores/chat';
import {
  useRoutines,
  type ButlerEventCard,
  type Routine,
  type RoutineRun,
} from '../stores/routines';
import { dueLabel, isOverdue, useTodos, type Todo } from '../stores/todos';
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
  const today = butlerPaperDateKey(new Date());
  const [briefOffset, setBriefOffset] = useState(0);
  const [input, setInput] = useState('');
  const [paperRounds, setPaperRounds] = useState(0);
  const [inlineRange, setInlineRange] = useState<{
    start: number;
    end: number | null;
  } | null>(null);
  const conversationOpen = useUI((state) => state.butlerConversationOpen);
  const manageOpen = useUI((state) => state.butlerManageOpen);
  const paperDate = useUI((state) => state.butlerPaperDate);
  const setSelectedDate = useUI((state) => state.setButlerPaperDate);
  const setModule = useUI((state) => state.setModule);
  const openConversationStore = useUI((state) => state.openButlerConversation);
  const openManage = useUI((state) => state.openButlerManage);
  const closeConversation = useUI((state) => state.closeButlerConversation);
  const closeManage = useUI((state) => state.closeButlerManage);
  const lines = useButler((state) => state.lines);
  const errands = useButler((state) => state.errands);
  const butlerRunning = useButler((state) => state.running);
  const butlerActivity = useButler((state) => state.activity);
  const askButler = useButler((state) => state.ask);
  const stopButler = useButler((state) => state.stop);
  const hydrateButler = useButler((state) => state.hydrate);
  const userId = useAuth((state) => state.user?._id);
  const lastResult = useButlerRoundsRunner((state) => state.lastResult);
  const roundsRunning = useButlerRoundsRunner((state) => state.running);
  const roundsError = useButlerRoundsRunner((state) => state.error);
  const routines = useRoutines((state) => state.routines);
  const eventCards = useRoutines((state) => state.eventCards);
  const runRoutineNow = useRoutines((state) => state.runNow);
  const dismissCard = useRoutines((state) => state.dismissCard);
  const todos = useTodos((state) => state.todos);
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
  const remainingBriefItems = Math.max(0, briefItems.length - briefOffset - BRIEF_PAGE_SIZE);
  const inlineLines = inlineRange === null
    ? []
    : lines.slice(inlineRange.start, inlineRange.end ?? undefined);
  const paperEmpty = sections.approvals.length === 0
    && sections.active.length === 0
    && paperTodos.length === 0
    && briefItems.length === 0
    && routineReports.length === 0
    && paperEventCards.length === 0
    && !roundsRunning
    && !roundsError;

  useEffect(() => {
    void runDailyButlerRoundsIfNeeded();
  }, []);

  useEffect(() => {
    if (userId) void hydrateButler();
  }, [hydrateButler, userId]);

  useEffect(() => {
    setBriefOffset(0);
  }, [selectedDate]);

  const askFromPaper = async (question: string): Promise<void> => {
    const text = question.trim();
    if (!text || butlerRunning) return;
    const nextRound = paperRounds + 1;
    setPaperRounds(nextRound);
    setInput('');
    if (shouldExpandButlerConversation(nextRound)) {
      openConversationStore();
      await askButler(text);
      return;
    }
    const start = lines.length;
    setInlineRange({ start, end: null });
    try {
      await askButler(text);
    } finally {
      const end = useButler.getState().lines.length;
      setInlineRange((current) => (
        current?.start === start ? { start, end } : current
      ));
    }
  };

  const submitQuestion = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void askFromPaper(input);
  };

  const toggleConversation = (): void => {
    if (conversationOpen) {
      closeConversation();
      return;
    }
    openConversationStore();
  };

  const backToPaper = (): void => {
    closeConversation();
    closeManage();
  };

  const toggleManage = (): void => {
    if (manageOpen) {
      closeManage();
      return;
    }
    closeConversation();
    openManage();
  };

  const openEventCard = async (card: ButlerEventCard): Promise<void> => {
    setModule('messages');
    if (card.rid) await useChat.getState().openRoom(card.rid);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-surface-3">
      <header className="shrink-0 px-6 pb-4 pt-7">
        <div className="mx-auto flex w-full max-w-[760px] items-center justify-between gap-4">
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
            <h1 className="min-w-36 text-xl font-semibold tracking-tight text-ink">
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
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={conversationOpen ? '收起完整对话' : '查看完整对话'}
              title={conversationOpen ? '收起完整对话' : '查看完整对话'}
              onClick={toggleConversation}
              className={`rounded-full p-2 transition ${
                conversationOpen ? 'bg-fill-1 text-ink' : 'text-ink-3 hover:bg-fill-hover hover:text-ink'
              }`}
            >
              <History size={16} />
            </button>
            <button
              type="button"
              aria-label={manageOpen ? '收起管家管理' : '打开管家管理'}
              title={manageOpen ? '收起管家管理' : '打开管家管理'}
              onClick={toggleManage}
              className={`rounded-full p-2 transition ${
                manageOpen ? 'bg-fill-1 text-ink' : 'text-ink-3 hover:bg-fill-hover hover:text-ink'
              }`}
            >
              <Settings2 size={16} />
            </button>
          </div>
        </div>
      </header>

      <main
        className={`min-h-0 flex-1 px-6 ${
          conversationOpen ? 'overflow-hidden pb-0' : 'overflow-y-auto pb-10'
        }`}
      >
        <div
          className={`mx-auto w-full max-w-[760px] ${
            conversationOpen ? 'h-full' : 'space-y-9'
          }`}
        >
          {conversationOpen ? (
            <section aria-label="完整对话" className="h-full">
              <ButlerConversation onBackToPaper={backToPaper} embedded />
            </section>
          ) : manageOpen ? (
            <section aria-label="管家管理">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-ink">管家管理</h2>
                  <p className="mt-1 text-sm text-ink-3">
                    例行事务、记忆、技能和最近动作都在这里，纸面保持安静。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeManage}
                  aria-label="收起管家管理"
                  title="收起管家管理"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
                >
                  <ChevronUp size={15} />
                </button>
              </div>
              <div className="mt-8 space-y-9">
                <ButlerRoutines />
                <ButlerLearnedPanel />
                <ButlerAuditTrail />
              </div>
            </section>
          ) : isToday ? (
            <>
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
                onRunNow={runRoutineNow}
                onOpenEvent={openEventCard}
                onDismissEvent={dismissCard}
              />

              {briefItems.length > 0 ? (
                <section aria-label="今天">
                  <h2 className="text-base font-semibold text-ink">今天</h2>
                  <div className="mt-3 space-y-2">
                    {visibleBriefItems.map((item, index) => (
                      <details key={`${item.ref}:${briefOffset + index}`} className="group">
                        <summary className="flex cursor-pointer list-none items-center gap-2 rounded py-1 text-left outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-primary-light [&::-webkit-details-marker]:hidden">
                          <ChevronRight
                            size={14}
                            aria-hidden="true"
                            className="shrink-0 text-ink-3 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
                          />
                          <h3 className="min-w-0 text-sm font-medium text-ink">
                            {paperBrief?.refTitles[item.ref] ?? '相关事项'}
                          </h3>
                        </summary>
                        <div className="ml-[22px] pb-2">
                          <p className="text-xs leading-5 text-ink-2">{item.why}</p>
                          {item.suggestedAction ? (
                            <p className="mt-1 text-xs leading-5 text-ink-3">{item.suggestedAction}</p>
                          ) : null}
                        </div>
                      </details>
                    ))}
                  </div>
                  <div className="mt-4 flex items-center gap-4 text-xs text-ink-3">
                    {briefOffset > 0 ? (
                      <button
                        type="button"
                        onClick={() => setBriefOffset(Math.max(0, briefOffset - BRIEF_PAGE_SIZE))}
                        className="hover:text-ink"
                      >
                        ‹ 前 {Math.min(BRIEF_PAGE_SIZE, briefOffset)} 条
                      </button>
                    ) : null}
                    {remainingBriefItems > 0 ? (
                      <button
                        type="button"
                        onClick={() => setBriefOffset(briefOffset + BRIEF_PAGE_SIZE)}
                        className="hover:text-ink"
                      >
                        还有 {remainingBriefItems} 条 ›
                      </button>
                    ) : null}
                  </div>
                </section>
              ) : null}

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

              {inlineRange !== null && inlineLines.length > 0 ? (
                <section aria-label="临时问答">
                  <h2 className="text-base font-semibold text-ink">临时问答</h2>
                  <div className="mt-3">
                    <ButlerInlineExchange
                      lines={inlineLines}
                      running={butlerRunning}
                      activity={butlerActivity}
                    />
                  </div>
                </section>
              ) : null}

              {paperEmpty && inlineRange === null ? (
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
                onRunNow={runRoutineNow}
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
      </main>

      {isToday && !conversationOpen && !manageOpen ? (
        <footer className="shrink-0 px-6 pb-5 pt-3">
          <div className="mx-auto w-full max-w-[760px]">
            <form
              onSubmit={submitQuestion}
              className="flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 transition-colors focus-within:border-primary"
            >
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="跟管家说件事……"
                aria-label="跟管家说件事"
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
              />
              {butlerRunning ? (
                <button
                  type="button"
                  aria-label="停止回答"
                  onClick={() => void stopButler()}
                  className="p-2 text-ink-2 hover:text-ink"
                >
                  <Square size={14} />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  aria-label="发送"
                  className="p-2 text-primary hover:text-primary-hover disabled:text-ink-3/40"
                >
                  <Send size={15} />
                </button>
              )}
            </form>
            <button
              type="button"
              aria-label={watchedCount > 0
                ? `在盯 ${watchedCount} 件事，打开管理`
                : '自动整理未开启，打开设置'}
              onClick={openManage}
              className="mx-auto mt-2 block rounded px-2 py-0.5 text-[11px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
            >
              {watchedCount > 0
                ? `在盯 ${watchedCount} 件事 · 管理`
                : '自动整理未开启 · 设置'}
            </button>
          </div>
        </footer>
      ) : null}
    </div>
  );
}
