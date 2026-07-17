import { AlertTriangle, AtSign, Bot, CalendarDays, CheckCircle2, Circle, ExternalLink, Loader2, MessageSquare, Play, Radio, RefreshCw, Sparkles, SquareCheckBig, UserRoundPlus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { buildTodayItems, todayCompletion, type TodayItem } from '../lib/today';
import { getServerBase, openExternal } from '../lib/client';
import { useAuth } from '../stores/auth';
import { useCalendar } from '../stores/calendar';
import { useChat } from '../stores/chat';
import { useToday } from '../stores/today';
import { useTodos } from '../stores/todos';
import { useUI } from '../stores/ui';
import { useWorkbench } from '../stores/workbench';
import { useRoutines } from '../stores/routines';
import { renderMarkdown } from '../lib/markdown';
import { IPMSG_RID, useIpmsg } from '../ipmsg/store';

const kindMeta = {
  mention: { label: '@我', icon: MessageSquare, color: 'text-primary' },
  todo: { label: '待办', icon: SquareCheckBig, color: 'text-warning' },
  event: { label: '日程', icon: CalendarDays, color: 'text-purple-500' },
  workitem: { label: '工作项', icon: ExternalLink, color: 'text-success' },
  ipmsg: { label: '局域网', icon: Radio, color: 'text-warning' },
} as const;

const butlerEventMeta = {
  'build-failed': { icon: AlertTriangle, color: 'text-danger' },
  'mention-stale': { icon: AtSign, color: 'text-primary' },
  'workitem-assigned': { icon: UserRoundPlus, color: 'text-success' },
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

function stripMarkdownInline(text: string): string {
  return text
    .replace(/^\s*\|?[-:]+(?:\|[-:]+)+\|?\s*$/gm, ' ')
    .replace(/^\s*---+\s*$/gm, ' ')
    .replace(/[#*_`|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export default function TodayPage() {
  const userId = useAuth((state) => state.user?._id ?? 'guest');
  const todos = useTodos((state) => state.todos);
  const events = useCalendar((state) => state.events);
  const workItems = useWorkbench((state) => state.workItems);
  const config = useWorkbench((state) => state.config);
  const lastRefresh = useWorkbench((state) => state.lastRefresh);
  const refreshWorkbench = useWorkbench((state) => state.refresh);
  const mentions = useToday((state) => state.mentions);
  const ipmsgMessages = useIpmsg((state) => state.messages);
  const processed = useToday((state) => state.processed);
  const loading = useToday((state) => state.loading);
  const warnings = useToday((state) => state.warnings);
  const hydrate = useToday((state) => state.hydrate);
  const refreshMentions = useToday((state) => state.refreshMentions);
  const setProcessed = useToday((state) => state.setProcessed);
  const routines = useRoutines((state) => state.routines);
  const eventCards = useRoutines((state) => state.eventCards);
  const runningIds = useRoutines((state) => state.runningIds);
  const hydrateRoutines = useRoutines((state) => state.hydrate);
  const setRoutineEnabled = useRoutines((state) => state.setEnabled);
  const runRoutineNow = useRoutines((state) => state.runNow);
  const dismissCard = useRoutines((state) => state.dismissCard);
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    void hydrate().then(refreshMentions);
    if (config && !lastRefresh) void refreshWorkbench();
  }, [config, hydrate, lastRefresh, refreshMentions, refreshWorkbench]);

  useEffect(() => {
    hydrateRoutines();
  }, [hydrateRoutines]);

  const scope = `${getServerBase() || 'same-origin'}:${userId}`;
  const adoScope = config
    ? config.mode === 'direct'
      ? config.adoBase ?? 'direct'
      : config.bridge ?? 'bridge'
    : 'unconfigured';
  const items = useMemo(
    () => buildTodayItems({ mentions, todos, events, workItems, ipmsg: ipmsgMessages, scope, adoScope, processed }),
    [adoScope, events, ipmsgMessages, mentions, processed, scope, todos, workItems],
  );
  const completion = todayCompletion(items);
  const visible = showDone ? items : items.filter((item) => !item.processed);

  const openItem = async (item: TodayItem) => {
    if (item.kind === 'mention') {
      useUI.getState().setModule('messages');
      await useChat.getState().jumpToMessage(item.message._id, item.message.rid);
    } else if (item.kind === 'todo') {
      useUI.getState().setModule('messages');
      await useChat.getState().jumpToMessage(item.todo.mid, item.todo.rid);
    } else if (item.kind === 'event') {
      const calendar = useCalendar.getState();
      calendar.setCursor(item.occurrenceDate);
      calendar.setSelectedDate(item.occurrenceDate);
      calendar.setView('day');
      useUI.getState().setModule('calendar');
    } else if (item.kind === 'ipmsg') {
      useUI.getState().setModule('messages');
      await useChat.getState().openRoom(IPMSG_RID);
    } else {
      await openExternal(item.workItem.webUrl);
    }
  };

  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-surface-3">
      <div className="mx-auto max-w-4xl px-8 py-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xl font-semibold text-ink"><Sparkles size={20} className="text-primary" />今日</div>
            <p className="mt-1 text-sm text-ink-3">@我、局域网消息、到期待办、今日日程和分配给我的工作项</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => void refreshMentions()}
              disabled={loading}
              className="flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-ink hover:bg-fill-hover disabled:opacity-50"
            >
              {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}刷新
            </button>
          </div>
        </div>

        <section className="mt-5 rounded-lg border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink"><Bot size={17} className="text-primary" />管家</div>
          {eventCards.length > 0 ? (
            <div className="mt-3 space-y-2">
              {eventCards.map((card) => {
                const meta = butlerEventMeta[card.kind];
                const Icon = meta.icon;
                return (
                  <div key={card.id} className="flex items-start gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2.5">
                    <Icon size={17} className={`mt-0.5 shrink-0 ${meta.color}`} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-ink">{card.title}</div>
                      <div className="mt-0.5 text-xs text-ink-3">{card.detail} · {displayTime(card.at)}</div>
                    </div>
                    <button title="关闭" onClick={() => dismissCard(card.id)} className="rounded p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"><X size={15} /></button>
                  </div>
                );
              })}
            </div>
          ) : null}
          <div className="mt-3 space-y-2">
            {routines.map((routine) => {
              const latest = routine.runs[0];
              const running = runningIds.includes(routine.id);
              const previewText = latest ? stripMarkdownInline(latest.text) : '';
              const preview = previewText.slice(0, 200);
              const status = latest
                ? latest.status === 'ok'
                  ? { label: '成功', dotClassName: 'bg-success' }
                  : { label: '失败', dotClassName: 'bg-danger' }
                : { label: '未运行', dotClassName: 'bg-ink-3' };
              return (
                <div key={routine.id} className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm font-medium text-ink">
                      <input className="accent-primary" type="checkbox" checked={routine.enabled} onChange={(event) => setRoutineEnabled(routine.id, event.target.checked)} />
                      <span className="truncate">{routine.name}</span>
                    </label>
                    <span className="shrink-0 text-xs text-ink-3">{routineScheduleLabel(routine.trigger)}</span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-3">
                      <span className={`h-1.5 w-1.5 rounded-full ${status.dotClassName}`} />{status.label}
                    </span>
                    <button title="立即运行" aria-label={`立即运行${routine.name}`} onClick={() => void runRoutineNow(routine.id)} disabled={running} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-ink hover:bg-fill-hover disabled:opacity-50">
                      {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                    </button>
                  </div>
                  {latest ? (
                    <details className="mt-2 text-xs text-ink-3">
                      <summary className="cursor-pointer list-none">{displayTime(latest.at)} · {latest.status === 'ok' ? '成功' : '失败'} · {preview}{previewText.length > 200 ? '…' : ''}</summary>
                      <div className="mt-2 rounded bg-fill-1 p-2 text-sm leading-6 text-ink">{renderMarkdown(latest.text)}</div>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <div className="mt-5 rounded-lg border border-line bg-surface p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-ink">今日处理进度</span>
            <span className="text-ink-3">{completion.done} / {completion.total} · {Math.round(completion.rate * 100)}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-fill-hover">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${completion.rate * 100}%` }} />
          </div>
        </div>

        {warnings.length > 0 && (
          <div className="mt-4 rounded-md border border-warning/30 bg-warning/5 px-4 py-3 text-xs text-warning">
            部分会话同步失败：{warnings.join('；')}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink">{showDone ? '全部条目' : '待处理'}</h2>
          <label className="flex items-center gap-2 text-xs text-ink-3">
            <input type="checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)} />显示已处理
          </label>
        </div>
        <div className="mt-2 space-y-2">
          {visible.map((item) => {
            const meta = kindMeta[item.kind];
            const Icon = meta.icon;
            return (
              <div key={item.key} className={`flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 ${item.processed ? 'opacity-55' : ''}`}>
                <button
                  title={item.processed ? '标记为待处理' : '标记为已处理'}
                  onClick={() => void setProcessed(item.key, !item.processed)}
                  className="rounded p-1 text-ink-3 hover:bg-fill-hover hover:text-primary"
                >
                  {item.processed ? <CheckCircle2 size={19} className="text-success" /> : <Circle size={19} />}
                </button>
                <Icon size={18} className={meta.color} />
                <button onClick={() => void openItem(item)} className="min-w-0 flex-1 text-left">
                  <div className="flex items-center gap-2"><span className="rounded bg-fill-hover px-1.5 py-0.5 text-[11px] text-ink-3">{meta.label}</span><span className="truncate text-sm font-medium text-ink">{item.title}</span></div>
                  {item.meta && <div className="mt-1 truncate text-xs text-ink-3">{item.meta}</div>}
                </button>
              </div>
            );
          })}
          {!loading && visible.length === 0 && (
            <div className="rounded-lg border border-dashed border-line py-12 text-center text-sm text-ink-3">今天已经清空了。</div>
          )}
        </div>
      </div>
    </div>
  );
}
