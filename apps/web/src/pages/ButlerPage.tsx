import { History, Send, Square } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import ButlerConversation from '../components/ButlerConversation';
import ButlerErrandRunCard from '../components/ButlerErrandRunCard';
import ButlerInlineExchange from '../components/ButlerInlineExchange';
import {
  archivedButlerErrandsForDate,
  butlerBriefForDate,
  butlerPaperDateKey,
  formatButlerPaperDate,
  partitionButlerPaperErrands,
  shiftButlerPaperDate,
  shouldExpandButlerConversation,
} from '../lib/butlerPaper';
import {
  runDailyButlerRoundsIfNeeded,
  useButlerRoundsRunner,
  visibleButlerRoundItems,
} from '../lib/butlerRoundsRunner';
import { BUTLER_SCENE_PROMPTS } from '../lib/butlerPrompts';
import { useAuth } from '../stores/auth';
import { useButler } from '../stores/butler';
import { useRoutines } from '../stores/routines';
import { useUI } from '../stores/ui';

const BRIEF_PAGE_SIZE = 5;

export default function ButlerPage() {
  const today = butlerPaperDateKey(new Date());
  const [selectedDate, setSelectedDate] = useState(today);
  const [briefOffset, setBriefOffset] = useState(0);
  const [input, setInput] = useState('');
  const [paperRounds, setPaperRounds] = useState(0);
  const [inlineStart, setInlineStart] = useState<number | null>(null);
  const conversationOpen = useUI((state) => state.butlerConversationOpen);
  const openConversation = useUI((state) => state.openButlerConversation);
  const closeConversation = useUI((state) => state.closeButlerConversation);
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
  const isToday = selectedDate === today;
  const sections = useMemo(() => partitionButlerPaperErrands(errands), [errands]);
  const archivedRuns = useMemo(
    () => archivedButlerErrandsForDate(errands, selectedDate),
    [errands, selectedDate],
  );
  const paperBrief = useMemo(
    () => butlerBriefForDate(lastResult, selectedDate),
    [lastResult, selectedDate],
  );
  const briefItems = useMemo(() => visibleButlerRoundItems(paperBrief), [paperBrief]);
  const visibleBriefItems = briefItems.slice(briefOffset, briefOffset + BRIEF_PAGE_SIZE);
  const remainingBriefItems = Math.max(0, briefItems.length - briefOffset - BRIEF_PAGE_SIZE);
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
      openConversation();
      await askButler(text);
      return;
    }
    setInlineStart(lines.length);
    await askButler(text);
  };

  const submitQuestion = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void askFromPaper(input);
  };

  const backToPaper = (): void => {
    setPaperRounds(0);
    setInlineStart(null);
    closeConversation();
  };

  if (conversationOpen) {
    return <ButlerConversation onBackToPaper={backToPaper} />;
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-surface">
      <header className="shrink-0 px-6 pb-4 pt-7">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="前一天"
              title="看前一天"
              onClick={() => setSelectedDate((current) => shiftButlerPaperDate(current, -1))}
              className="p-1 text-xl leading-none text-ink-2 hover:text-ink"
            >
              ‹
            </button>
            <h1 className="min-w-36 text-xl font-semibold tracking-tight text-ink">
              {formatButlerPaperDate(selectedDate)}
            </h1>
            <button
              type="button"
              aria-label="后一天"
              title={isToday ? '已经是今天' : '看后一天'}
              disabled={isToday}
              onClick={() => setSelectedDate((current) => shiftButlerPaperDate(current, 1))}
              className="p-1 text-xl leading-none text-ink-2 hover:text-ink disabled:text-ink-3/35"
            >
              ›
            </button>
          </div>
          <button
            type="button"
            aria-label="查看完整对话"
            title="查看完整对话"
            onClick={openConversation}
            className="p-2 text-ink-3 hover:text-ink"
          >
            <History size={18} />
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        <div className="mx-auto w-full max-w-3xl">
          {isToday ? (
            <div className="space-y-9">
              <ButlerErrandRunCard onAsk={askFromPaper} />

              {briefItems.length > 0 || inlineStart !== null ? (
                <section aria-label="今天">
                  <h2 className="text-base font-semibold text-ink">今天</h2>
                  {briefItems.length > 0 ? (
                    <>
                      <div className="mt-3 space-y-4">
                        {visibleBriefItems.map((item, index) => (
                          <article key={`${item.ref}:${briefOffset + index}`}>
                            <h3 className="text-sm font-medium text-ink">
                              {paperBrief?.refTitles[item.ref] ?? '相关事项'}
                            </h3>
                            <p className="mt-1 text-xs leading-5 text-ink-2">{item.why}</p>
                            {item.suggestedAction ? (
                              <p className="mt-1 text-xs leading-5 text-ink-3">{item.suggestedAction}</p>
                            ) : null}
                          </article>
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
                    </>
                  ) : null}
                  {inlineStart !== null ? (
                    <div className={briefItems.length > 0 ? 'mt-5' : 'mt-3'}>
                      <ButlerInlineExchange
                        lines={lines.slice(inlineStart)}
                        running={butlerRunning}
                        activity={butlerActivity}
                      />
                    </div>
                  ) : null}
                </section>
              ) : null}

              {paperEmpty && inlineStart === null ? (
                <section className="pt-10 text-center" aria-label="管家空状态">
                  <p className="text-base text-ink-2">今天还没有事，跟我说件事试试</p>
                  <div className="mx-auto mt-5 flex max-w-xl flex-col gap-2 text-left">
                    {BUTLER_SCENE_PROMPTS.map((item) => (
                      <button
                        key={item.scene}
                        type="button"
                        onClick={() => setInput(item.prompt)}
                        className="px-2 py-1 text-xs leading-5 text-ink-3 hover:text-ink"
                      >
                        <span className="mr-2 text-ink-2">{item.scene}</span>
                        {item.prompt}
                      </button>
                    ))}
                  </div>
                </section>
              ) : null}

            </div>
          ) : (
            <div className="space-y-9">
              {archivedRuns.length > 0 ? (
                <ButlerErrandRunCard runs={archivedRuns} archived />
              ) : null}
              {briefItems.length > 0 ? (
                <section aria-label="今天">
                  <h2 className="text-base font-semibold text-ink">今天</h2>
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
            </div>
          )}
        </div>
      </main>

      {isToday ? (
        <footer className="shrink-0 px-6 pb-5 pt-3">
          <div className="mx-auto w-full max-w-3xl">
            <form
              onSubmit={submitQuestion}
              className="flex min-w-0 items-center gap-2 border-b border-line px-1 py-2 focus-within:border-primary"
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
              <p className="mt-2 text-center text-[11px] text-ink-3/55">
                在盯 {watchedCount} 件事，结果都会写到这张纸上
              </p>
            ) : null}
          </div>
        </footer>
      ) : null}
    </div>
  );
}
