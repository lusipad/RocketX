import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Bell,
  ChevronDown,
  Loader2,
  RefreshCw,
  Send,
} from 'lucide-react';
import { ledgerFromTodos, type LedgerEntry } from '../lib/butlerLedger';
import {
  runButlerRoundsNow,
  runDailyButlerRoundsIfNeeded,
  useButlerRoundsRunner,
} from '../lib/butlerRoundsRunner';
import { useButler } from '../stores/butler';
import { toast } from '../stores/toast';
import { dueLabel, todayKey, useTodos } from '../stores/todos';
import { useUI } from '../stores/ui';

function lookedAtLabel(value: string | null): string {
  if (!value) return '我还没看过';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '我看过一圈';
  return `我 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 看了一圈`;
}

function ledgerDue(entry: LedgerEntry, today: string): { label: string; color: string } {
  if (entry.dueState === 'overdue') {
    return { label: entry.due ? dueLabel(entry.due, today) : '已逾期', color: 'text-danger' };
  }
  if (entry.dueState === 'today') return { label: '今天到期', color: 'text-danger' };
  if (entry.due) return { label: dueLabel(entry.due, today), color: 'text-ink-3' };
  return { label: '没设日期', color: 'text-ink-3' };
}

function LedgerColumn({
  title,
  entries,
  today,
}: {
  title: string;
  entries: LedgerEntry[];
  today: string;
}) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface p-4">
      <h2 className="mb-3 text-sm font-semibold text-ink">{title}</h2>
      {entries.length === 0 ? (
        <p className="py-4 text-center text-sm text-ink-3">这里还是空的</p>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((entry) => {
            const due = ledgerDue(entry, today);
            return (
              <div key={`${entry.kind}:${entry.todoId}`} className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
                <div className="text-sm font-medium text-ink">{entry.title}</div>
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-ink-2">{entry.who}</span>
                  <span className={due.color}>{due.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function proposalTodoId(ref: string): string | null {
  if (ref.startsWith('todo:')) return ref.slice('todo:'.length);
  if (ref.startsWith('ledger:')) return ref.slice('ledger:'.length);
  return null;
}

export default function ButlerPage() {
  const [input, setInput] = useState('');
  const [hiddenProposals, setHiddenProposals] = useState<Set<string>>(() => new Set());
  const todos = useTodos((state) => state.todos);
  const lastRoundsAt = useButlerRoundsRunner((state) => state.lastRoundsAt);
  const lastResult = useButlerRoundsRunner((state) => state.lastResult);
  const running = useButlerRoundsRunner((state) => state.running);
  const error = useButlerRoundsRunner((state) => state.error);

  useEffect(() => {
    void runDailyButlerRoundsIfNeeded();
  }, []);

  useEffect(() => {
    setHiddenProposals(new Set());
  }, [lastResult?.generatedAt]);

  const today = todayKey();
  const ledger = useMemo(() => ledgerFromTodos(todos, today), [todos, today]);
  const commitments = useMemo(
    () => ledger.filter((entry) => entry.kind === 'commitment'),
    [ledger],
  );
  const waits = useMemo(() => ledger.filter((entry) => entry.kind === 'wait'), [ledger]);
  const result = lastResult?.result;

  const refTitles = useMemo(
    () => new Map(Object.entries(lastResult?.refTitles ?? {})),
    [lastResult],
  );
  const checkedCount = lastResult?.checkedCount ?? 0;

  function hideProposal(key: string): void {
    setHiddenProposals((current) => new Set(current).add(key));
  }

  function acceptProposal(kind: 'add-commitment' | 'close-wait' | 'schedule-today', ref: string, key: string): void {
    if (kind === 'close-wait') {
      const todoId = proposalTodoId(ref);
      const todo = todoId ? useTodos.getState().todos.find((item) => item.id === todoId) : undefined;
      if (todo && !todo.done) {
        useTodos.getState().toggle(todo.id);
        toast.success('已销账');
      } else {
        toast.info('这项已经处理过了');
      }
    } else {
      toast.success('已记下');
    }
    hideProposal(key);
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    useUI.getState().setModule('ai-assistant');
    void useButler.getState().ask(text);
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface-3">
      <header className="flex shrink-0 items-center justify-between border-b border-line bg-surface px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Bell size={20} className="shrink-0 text-primary" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink">管家</h1>
            <p className="text-xs text-ink-3">{lookedAtLabel(lastRoundsAt)}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void runButlerRoundsNow()}
          disabled={running}
          className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink hover:bg-fill-hover disabled:opacity-50"
        >
          {running ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          再看一圈
        </button>
      </header>

      <main className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
          {error && (
            <div className="rounded-lg border border-danger/30 bg-danger/5 px-4 py-2.5 text-sm text-danger">
              这轮没看成：{error}
            </div>
          )}

          <section className="rounded-xl border border-line bg-surface p-5">
            {result ? (
              <>
                <div className="border-b border-line pb-4">
                  <div className="mb-1 text-xs font-medium text-ink-3">简报</div>
                  <h2 className="text-xl font-semibold text-ink">{result.headline}</h2>
                  <p className="mt-1.5 text-sm leading-6 text-ink-2">{result.summary}</p>
                </div>

                {result.items.length > 0 ? (
                  <div className="mt-4 flex flex-col gap-3">
                    {result.items.map((item, index) => (
                      <article key={`${item.ref}:${index}`} className="rounded-lg border border-line bg-surface-2 p-4">
                        <div className="flex items-start gap-3">
                          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-white">
                            {index + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-semibold text-ink">{refTitles.get(item.ref) ?? '相关事项'}</h3>
                            <p className="mt-1 text-xs leading-5 text-ink-2">为什么找你：{item.why}</p>
                            {item.suggestedAction && (
                              <button
                                type="button"
                                onClick={() => toast.info('这一步还需要你手动完成')}
                                className="mt-3 rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-fill-hover"
                              >
                                {item.suggestedAction}
                              </button>
                            )}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="py-6 text-center text-sm text-ink-3">这轮没有必须找你的事。</p>
                )}

                {result.proposals.map((proposal, index) => {
                  const key = `${proposal.kind}:${proposal.ref}:${index}`;
                  if (hiddenProposals.has(key)) return null;
                  return (
                    <div key={key} className="mt-3 rounded-lg border border-primary/25 bg-primary-light/20 p-4">
                      <div className="text-sm font-medium text-ink">{refTitles.get(proposal.ref) ?? '相关事项'}</div>
                      <p className="mt-1 text-xs leading-5 text-ink-2">{proposal.reason}</p>
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          onClick={() => acceptProposal(proposal.kind, proposal.ref, key)}
                          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover"
                        >
                          {proposal.kind === 'close-wait' ? '销账' : '入账'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            hideProposal(key);
                            toast.info('这次先不管');
                          }}
                          className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink hover:bg-fill-hover"
                        >
                          先不管
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            ) : running ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-ink-2">
                <Loader2 size={16} className="animate-spin" />
                我正在看……
              </div>
            ) : (
              <div className="py-12 text-center text-sm text-ink-3">还没有简报，点“再看一圈”试试。</div>
            )}
          </section>

          <div className="grid gap-4 md:grid-cols-2">
            <LedgerColumn title="我答应的" entries={commitments} today={today} />
            <LedgerColumn title="我在等的" entries={waits} today={today} />
          </div>

          <details className="group rounded-xl border border-line bg-surface">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm text-ink-2">
              <span>
                工作日志 · 看了 {checkedCount} 项，上面说了 {result?.items.length ?? 0} 条，压下 {result?.suppressed.length ?? 0} 条
              </span>
              <ChevronDown size={16} className="transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-line px-4 py-3">
              {result?.suppressed.length ? (
                <div className="flex flex-col gap-2">
                  {result.suppressed.map((item, index) => (
                    <div key={`${item.ref}:${index}`} className="rounded-md bg-surface-2 px-3 py-2 text-xs">
                      <div className="font-medium text-ink">{refTitles.get(item.ref) ?? '相关事项'}</div>
                      <div className="mt-0.5 leading-5 text-ink-3">{item.reason}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="py-2 text-center text-sm text-ink-3">这次没有压下的内容。</p>
              )}
            </div>
          </details>
        </div>
      </main>

      <form onSubmit={submitQuestion} className="shrink-0 border-t border-line bg-surface px-6 py-3">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 focus-within:border-primary/50">
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="问管家一句……"
            aria-label="问管家"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            aria-label="发送"
            className="rounded-md bg-primary p-2 text-white hover:bg-primary-hover disabled:opacity-40"
          >
            <Send size={15} />
          </button>
        </div>
      </form>
    </div>
  );
}
