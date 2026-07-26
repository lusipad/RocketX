import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  History,
  Send,
  Settings2,
  Square,
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
import {
  runDailyButlerRoundsIfNeeded,
  useButlerRoundsRunner,
  visibleButlerRoundItems,
} from '../lib/butlerRoundsRunner';
import { useAuth } from '../stores/auth';
import { useButler } from '../stores/butler';
import { useRoutines } from '../stores/routines';
import { useUI } from '../stores/ui';

const BRIEF_PAGE_SIZE = 5;

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
  const routines = useRoutines((state) => state.routines);
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
      brief: selectedBrief,
    }),
    [errands, selectedBrief, selectedDate, today],
  );
  const isToday = paper.isToday;
  const sections = paper.errands;
  const archivedRuns = paper.archived;
  const paperBrief = paper.brief;
  const briefItems = useMemo(() => visibleButlerRoundItems(paperBrief), [paperBrief]);
  const visibleBriefItems = briefItems.slice(briefOffset, briefOffset + BRIEF_PAGE_SIZE);
  const remainingBriefItems = Math.max(0, briefItems.length - briefOffset - BRIEF_PAGE_SIZE);
  const inlineLines = inlineRange === null
    ? []
    : lines.slice(inlineRange.start, inlineRange.end ?? undefined);
  const paperEmpty = sections.approvals.length === 0
    && sections.active.length === 0
    && briefItems.length === 0;

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
              {archivedRuns.length === 0 && briefItems.length === 0 ? (
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
            {watchedCount > 0 ? (
              <p className="mt-2 text-center text-[11px] text-ink-3">
                在盯 {watchedCount} 件事，结果都会写到这张纸上
              </p>
            ) : null}
          </div>
        </footer>
      ) : null}
    </div>
  );
}
