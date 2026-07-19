import {
  AtSign,
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { shouldExpandRun } from '../lib/butlerReport';
import type { ButlerEventCard } from '../lib/butlerWatchers';
import { renderMarkdown } from '../lib/markdown';
import { useRoutines, type Routine } from '../stores/routines';
import { useUI } from '../stores/ui';

const butlerEventMeta = {
  'mention-stale': { icon: AtSign, color: 'text-primary' },
} as const;

function displayTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function routineScheduleLabel(trigger: { time: string; days?: number[] }): string {
  const dayText = trigger.days?.length
    ? trigger.days.map((day) => `周${'日一二三四五六'[day] ?? day}`).join('、')
    : '每日';
  return `${dayText} ${trigger.time}`;
}

function RoutineReportCard({
  routine,
  running,
  onRunNow,
}: {
  routine: Routine;
  running: boolean;
  onRunNow: (id: string) => Promise<void>;
}) {
  const latest = routine.runs[0];
  const [expanded, setExpanded] = useState(() => shouldExpandRun(latest, Date.now()));
  const freshToday = shouldExpandRun(latest, Date.now());

  const handleRunNow = async () => {
    await onRunNow(routine.id);
    setExpanded(true);
  };

  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{routine.name}</span>
        <span className="shrink-0 text-xs text-ink-3">
          {latest
            ? latest.status === 'error'
              ? `${displayTime(latest.at)} 生成失败`
              : `${displayTime(latest.at)} 生成${freshToday ? '' : '（非当天）'}`
            : '当天还没生成'}
        </span>
        <button
          type="button"
          title={latest?.status === 'error' ? '重试' : latest ? '重新生成' : '立即生成'}
          aria-label={`立即生成${routine.name}`}
          onClick={() => void handleRunNow()}
          disabled={running}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink hover:bg-fill-hover disabled:opacity-50"
        >
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
        </button>
        {latest ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? `收起${routine.name}报告` : `展开${routine.name}报告`}
            onClick={() => setExpanded((value) => !value)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-fill-hover hover:text-ink"
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        ) : null}
      </div>
      {latest && expanded ? (
        <div className="mt-3 border-t border-line pt-3">
          {latest.status === 'ok'
            ? <div className="text-sm leading-6 text-ink">{renderMarkdown(latest.text)}</div>
            : <p className="text-sm leading-6 text-danger">{latest.text}</p>}
        </div>
      ) : null}
    </div>
  );
}

export default function ButlerRoutines() {
  const routines = useRoutines((state) => state.routines);
  const eventCards = useRoutines((state) => state.eventCards);
  const runningIds = useRoutines((state) => state.runningIds);
  const hydrateRoutines = useRoutines((state) => state.hydrate);
  const setRoutineEnabled = useRoutines((state) => state.setEnabled);
  const runRoutineNow = useRoutines((state) => state.runNow);
  const dismissCard = useRoutines((state) => state.dismissCard);

  useEffect(() => {
    hydrateRoutines();
  }, [hydrateRoutines]);

  const openEventCard = (_card: ButlerEventCard) => {
    useUI.getState().setModule('messages');
  };

  return (
    <details className="group rounded-xl border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-ink">
        <span>例行事务</span>
        <ChevronDown size={16} className="transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-line p-4">
        {routines.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-ink-3">
            还没有例行事务。打开对话后，直接告诉我时间和要做的事。
            <button
              type="button"
              onClick={() => useUI.getState().openButlerConversation()}
              className="ml-2 font-medium text-primary hover:underline"
            >
              去创建
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {routines.filter((routine) => routine.enabled).map((routine) => (
                <RoutineReportCard
                  key={routine.id}
                  routine={routine}
                  running={runningIds.includes(routine.id)}
                  onRunNow={runRoutineNow}
                />
              ))}
              {routines.every((routine) => !routine.enabled) && (
                <div className="rounded-lg border border-dashed border-line px-4 py-4 text-center text-xs text-ink-3">
                  所有例行事务都已停用，可在下方管理中开启。
                </div>
              )}
            </div>
            <details className="group/manage mt-3 rounded-md border border-line">
              <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs text-ink-3 transition hover:bg-fill-hover hover:text-ink-2">
                管理例行事务
                <ChevronDown size={14} className="transition-transform group-open/manage:rotate-180" />
              </summary>
              <div className="divide-y divide-line border-t border-line">
                {routines.map((routine) => (
                  <label key={routine.id} className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm text-ink">
                    <input
                      className="accent-primary"
                      type="checkbox"
                      checked={routine.enabled}
                      onChange={(event) => setRoutineEnabled(routine.id, event.target.checked)}
                    />
                    <span className="min-w-0 flex-1 truncate">{routine.name}</span>
                    <span className="shrink-0 text-xs text-ink-3">{routineScheduleLabel(routine.trigger)}</span>
                  </label>
                ))}
              </div>
            </details>
          </>
        )}

        {eventCards.length > 0 && (
          <section className="mt-4 border-t border-line pt-4">
            <h3 className="text-sm font-semibold text-ink">提醒</h3>
            <div className="mt-2 space-y-2">
              {eventCards.map((card) => {
                const meta = butlerEventMeta[card.kind];
                const Icon = meta.icon;
                return (
                  <div key={card.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3">
                    <Icon size={18} className={`shrink-0 ${meta.color}`} />
                    <button type="button" onClick={() => openEventCard(card)} className="min-w-0 flex-1 text-left">
                      <div className="truncate text-sm font-medium text-ink">{card.title}</div>
                      <div className="mt-0.5 truncate text-xs text-ink-3">{card.detail} · {displayTime(card.at)}</div>
                    </button>
                    <button type="button" title="关闭提醒" onClick={() => dismissCard(card.id)} className="rounded p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"><X size={15} /></button>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </details>
  );
}
