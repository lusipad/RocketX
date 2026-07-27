import {
  AtSign,
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  BUTLER_ABILITY_TEMPLATES,
  type ButlerAbilityTemplate,
} from '../lib/butlerAbilityTemplates';
import { shouldExpandRun } from '../lib/butlerReport';
import type { ButlerEventCard } from '../lib/butlerWatchers';
import { renderMarkdown } from '../lib/markdown';
import { useRoutines, type Routine } from '../stores/routines';
import { useChat } from '../stores/chat';
import { useUI } from '../stores/ui';

const butlerEventMeta = {
  'mention-stale': { icon: AtSign, color: 'text-primary' },
} as const;

function displayTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function routineScheduleLabel(trigger: Routine['trigger']): string {
  if (trigger.kind === 'interval') return `每 ${trigger.everyMinutes} 分钟`;
  const dayText = trigger.days?.length
    ? trigger.days.map((day: number) => `周${'日一二三四五六'[day] ?? day}`).join('、')
    : '每日';
  return `${dayText} ${trigger.time}`;
}

function templateActionLabel(template: ButlerAbilityTemplate): string {
  if (template.id === 'mention-triage') return `开启${template.title}`;
  if (template.id === 'room-digest') return `选择房间以开启${template.title}`;
  return `装回${template.title}`;
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
    <div className="border-b border-line/70 py-2.5 last:border-b-0">
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
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink disabled:opacity-50"
        >
          {running ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" /> : <Play size={14} />}
        </button>
        {latest ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? `收起${routine.name}报告` : `展开${routine.name}报告`}
            onClick={() => setExpanded((value) => !value)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
        ) : null}
      </div>
      {latest && expanded ? (
        <div className="mt-2 border-l border-line pl-4">
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
  const loadRoutineTemplate = useRoutines((state) => state.loadTemplate);
  const setRoutineEnabled = useRoutines((state) => state.setEnabled);
  const runRoutineNow = useRoutines((state) => state.runNow);
  const dismissCard = useRoutines((state) => state.dismissCard);
  const subscriptions = useChat((state) => state.subscriptions);
  const [manageExpanded, setManageExpanded] = useState(routines.length === 0);
  const [showDigestPicker, setShowDigestPicker] = useState(false);
  const [selectedDigestRooms, setSelectedDigestRooms] = useState<string[]>([]);
  const [digestError, setDigestError] = useState('');

  useEffect(() => {
    hydrateRoutines();
  }, [hydrateRoutines]);

  const enabledRoutines = useMemo(
    () => routines.filter((routine) => routine.enabled),
    [routines],
  );
  const routinesByTemplate = useMemo(
    () => new Map(
      routines
        .filter((routine) => routine.templateId)
        .map((routine) => [routine.templateId!, routine]),
    ),
    [routines],
  );
  const digestRooms = useMemo(
    () => {
      const seen = new Set<string>();
      return Object.values(subscriptions)
        .flatMap((subscription) => {
          const name = subscription.fname || subscription.name || subscription.rid;
          if (!name || seen.has(name)) return [];
          seen.add(name);
          return [{ rid: subscription.rid, name }];
        })
        .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
    },
    [subscriptions],
  );

  useEffect(() => {
    if (selectedDigestRooms.length > 0 && digestError) setDigestError('');
  }, [digestError, selectedDigestRooms]);

  useEffect(() => {
    if (enabledRoutines.length === 0) setManageExpanded(true);
  }, [enabledRoutines.length]);

  const openEventCard = async (card: ButlerEventCard): Promise<void> => {
    useUI.getState().setModule('messages');
    if (card.rid) await useChat.getState().openRoom(card.rid);
  };

  const handleEnableTemplate = (template: ButlerAbilityTemplate) => {
    const routine = loadRoutineTemplate(template.id);
    if (routine && !routine.enabled) setRoutineEnabled(routine.id, true);
  };

  const toggleDigestRoom = (room: string, checked: boolean) => {
    setSelectedDigestRooms((current) => (
      checked
        ? current.includes(room) ? current : [...current, room]
        : current.filter((item) => item !== room)
    ));
  };

  const handleEnableDigest = () => {
    if (selectedDigestRooms.length === 0) {
      setDigestError('至少选择一个房间');
      setShowDigestPicker(true);
      return;
    }
    const routine = loadRoutineTemplate('room-digest', { rooms: selectedDigestRooms });
    if (!routine) {
      setDigestError('至少选择一个房间');
      return;
    }
    if (!routine.enabled) setRoutineEnabled(routine.id, true);
    setDigestError('');
    setShowDigestPicker(false);
  };

  return (
    <section aria-label="在盯的事">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium text-ink-3">在盯的事</h2>
        <span className="text-[11px] text-ink-3">
          {enabledRoutines.length} 项启用
        </span>
      </div>
      <div className="mt-3">
        {enabledRoutines.length === 0 ? (
          <div className="py-4 text-sm text-ink-3">
            现在还没有开启中的自动整理。你可以直接开晨报、晚间回顾、@我提醒或群聊汇总。
            <button
              type="button"
              onClick={() => useUI.getState().openButlerConversation()}
              className="ml-2 text-primary hover:underline"
            >
              去对话里说
            </button>
          </div>
        ) : null}

        {enabledRoutines.length > 0 ? (
          <div className="space-y-2">
            {enabledRoutines.map((routine) => (
              <RoutineReportCard
                key={routine.id}
                routine={routine}
                running={runningIds.includes(routine.id)}
                onRunNow={runRoutineNow}
              />
            ))}
          </div>
        ) : null}

        <details
          open={manageExpanded}
          onToggle={(event) => setManageExpanded(event.currentTarget.open)}
          className="group/manage mt-3 border-t border-line"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-xs text-ink-3 transition hover:text-ink-2">
            管理例行事务
            <ChevronDown size={14} className="transition-transform motion-reduce:transition-none group-open/manage:rotate-180" />
          </summary>
          <div className="divide-y divide-line/70 border-t border-line">
            {BUTLER_ABILITY_TEMPLATES.map((template) => {
              const routine = routinesByTemplate.get(template.id);
              return (
                <div key={template.id} className="py-2.5">
                  <div className="flex items-start gap-3">
                    {routine ? (
                      <input
                        className="mt-0.5 accent-primary"
                        type="checkbox"
                        aria-label={`启用${routine.name}`}
                        checked={routine.enabled}
                        onChange={(event) => setRoutineEnabled(routine.id, event.target.checked)}
                      />
                    ) : (
                      <button
                        type="button"
                        aria-label={templateActionLabel(template)}
                        onClick={() => {
                          if (template.id === 'room-digest') {
                            setShowDigestPicker((value) => !value);
                            setDigestError('');
                            return;
                          }
                          handleEnableTemplate(template);
                        }}
                        className="mt-0.5 shrink-0 rounded border border-line px-2 py-1 text-xs text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
                      >
                        {template.id === 'room-digest' ? '选房间' : '开启'}
                      </button>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{template.title}</span>
                        <span className="shrink-0 text-[11px] text-ink-3">
                          {routine ? routineScheduleLabel(routine.trigger) : routineScheduleLabel(template.defaultTrigger)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs leading-5 text-ink-3">{template.description}</p>
                      {routine?.params?.rooms?.length ? (
                        <p className="mt-1 text-[11px] text-ink-3">
                          已汇总：{routine.params.rooms.join('、')}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {!routine && template.id === 'room-digest' && showDigestPicker ? (
                    <div className="ml-11 mt-2 rounded-md border border-line/80 bg-fill-2/40 p-3">
                      {digestRooms.length === 0 ? (
                        <p className="text-xs text-ink-3">还没有可汇总的房间。</p>
                      ) : (
                        <>
                          <div className="space-y-2">
                            {digestRooms.map((room) => (
                              <label key={room.rid} className="flex items-center gap-2 text-sm text-ink">
                                <input
                                  type="checkbox"
                                  className="accent-primary"
                                  aria-label={`汇总 ${room.name}`}
                                  checked={selectedDigestRooms.includes(room.name)}
                                  onChange={(event) => toggleDigestRoom(room.name, event.target.checked)}
                                />
                                <span>{room.name}</span>
                              </label>
                            ))}
                          </div>
                          {digestError ? (
                            <p className="mt-2 text-xs text-danger">{digestError}</p>
                          ) : null}
                          <div className="mt-3 flex items-center gap-2">
                            <button
                              type="button"
                              aria-label="开启房间汇总"
                              onClick={handleEnableDigest}
                              className="rounded border border-line px-2 py-1 text-xs text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
                            >
                              开启房间汇总
                            </button>
                            <span className="text-[11px] text-ink-3">至少选择一个房间</span>
                          </div>
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </details>

        {eventCards.length > 0 && (
          <section className="mt-4 border-t border-line pt-4">
            <h3 className="text-xs font-medium text-ink-3">提醒</h3>
            <div className="mt-2 space-y-2">
              {eventCards.map((card) => {
                const meta = butlerEventMeta[card.kind];
                const Icon = meta.icon;
                return (
                  <div key={card.id} className="flex items-center gap-3 border-b border-line/70 py-2.5 last:border-b-0">
                    <Icon size={16} className={`shrink-0 ${meta.color}`} />
                    <button type="button" onClick={() => void openEventCard(card)} className="min-w-0 flex-1 text-left">
                      <div className="truncate text-sm font-medium text-ink">{card.title}</div>
                      <div className="mt-0.5 truncate text-xs text-ink-3">{card.detail} · {displayTime(card.at)}</div>
                    </button>
                    <button type="button" aria-label={`关闭提醒${card.title}`} title="关闭提醒" onClick={() => dismissCard(card.id)} className="rounded p-1 text-ink-3 hover:bg-fill-hover hover:text-ink"><X size={14} /></button>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
