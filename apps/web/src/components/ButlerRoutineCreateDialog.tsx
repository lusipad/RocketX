import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useT, type MessageKey } from '../i18n';
import {
  dailyTriggerToRrule,
  intervalWindowFromRrule,
  intervalTriggerToRrule,
  normalizeRrule,
  parseRrule,
  structuredCustomScheduleToRrule,
} from '../lib/codexSchedule';
import { useAgentEnvironments } from '../stores/agentEnvironments';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import {
  MIN_INTERVAL_MINUTES,
  useRoutines,
  type EventRoutineType,
  type Routine,
  type RoutineKind,
  type RoutineTrigger,
} from '../stores/routines';
import { toast } from '../stores/toast';

const WEEKDAYS = [
  { value: 1, rrule: 'MO', labelKey: 'butler.routines.weekdayShort.1', longLabelKey: 'butler.routines.weekdayLong.1' },
  { value: 2, rrule: 'TU', labelKey: 'butler.routines.weekdayShort.2', longLabelKey: 'butler.routines.weekdayLong.2' },
  { value: 3, rrule: 'WE', labelKey: 'butler.routines.weekdayShort.3', longLabelKey: 'butler.routines.weekdayLong.3' },
  { value: 4, rrule: 'TH', labelKey: 'butler.routines.weekdayShort.4', longLabelKey: 'butler.routines.weekdayLong.4' },
  { value: 5, rrule: 'FR', labelKey: 'butler.routines.weekdayShort.5', longLabelKey: 'butler.routines.weekdayLong.5' },
  { value: 6, rrule: 'SA', labelKey: 'butler.routines.weekdayShort.6', longLabelKey: 'butler.routines.weekdayLong.6' },
  { value: 0, rrule: 'SU', labelKey: 'butler.routines.weekdayShort.0', longLabelKey: 'butler.routines.weekdayLong.0' },
] as const;

type Frequency = 'daily' | 'weekdays' | 'weekly' | 'interval' | 'event' | 'custom';
type CustomFrequency = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

const CUSTOM_FREQUENCIES = [
  { value: 'HOURLY', labelKey: 'butler.routines.customFreq.HOURLY', intervalUnitKey: 'butler.routines.intervalUnit.HOURLY' },
  { value: 'DAILY', labelKey: 'butler.routines.customFreq.DAILY', intervalUnitKey: 'butler.routines.intervalUnit.DAILY' },
  { value: 'WEEKLY', labelKey: 'butler.routines.customFreq.WEEKLY', intervalUnitKey: 'butler.routines.intervalUnit.WEEKLY' },
  { value: 'MONTHLY', labelKey: 'butler.routines.customFreq.MONTHLY', intervalUnitKey: 'butler.routines.intervalUnit.MONTHLY' },
  { value: 'YEARLY', labelKey: 'butler.routines.customFreq.YEARLY', intervalUnitKey: 'butler.routines.intervalUnit.YEARLY' },
] as const satisfies readonly { value: CustomFrequency; labelKey: MessageKey; intervalUnitKey: MessageKey }[];

const MONTH_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);
const MONTH_DAY_OPTIONS = Array.from({ length: 31 }, (_, index) => index + 1);

function initialSchedule(routine?: Routine): {
  frequency: Frequency;
  time: string;
  intervalMinutes: number;
  intervalWindowEnabled: boolean;
  intervalWindowStart: string;
  intervalWindowEnd: string;
  weekday: number;
  customRrule: string;
  customFrequency: CustomFrequency;
  customInterval: number;
  customTime: string;
  customMinute: number;
  customWeekdays: number[];
  customMonthDay: number;
  customMonth: number;
  customUnsupported: boolean;
} {
  const fallback = {
    frequency: 'daily' as const,
    time: '09:00',
    intervalMinutes: 30,
    intervalWindowEnabled: false,
    intervalWindowStart: '09:00',
    intervalWindowEnd: '20:00',
    weekday: 1,
    customRrule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0',
    customFrequency: 'MONTHLY' as const,
    customInterval: 1,
    customTime: '09:00',
    customMinute: 0,
    customWeekdays: [1],
    customMonthDay: 1,
    customMonth: 1,
    customUnsupported: false,
  };
  const rrule = routine?.rrule;
  if (routine?.trigger?.kind === 'event') {
    return { ...fallback, frequency: 'event' };
  }
  if (!rrule) {
    if (routine?.trigger?.kind === 'interval') {
      return {
        ...fallback,
        frequency: 'interval',
        intervalMinutes: routine.trigger.everyMinutes,
        intervalWindowEnabled: !!routine.trigger.window,
        intervalWindowStart: routine.trigger.window?.start ?? fallback.intervalWindowStart,
        intervalWindowEnd: routine.trigger.window?.end ?? fallback.intervalWindowEnd,
      };
    }
    if (routine?.trigger?.kind === 'daily') {
      const days = routine.trigger.days;
      if (days?.length === 5 && [1, 2, 3, 4, 5].every((day) => days.includes(day))) {
        return { ...fallback, frequency: 'weekdays', time: routine.trigger.time };
      }
      if (days?.length === 1) {
        return { ...fallback, frequency: 'weekly', time: routine.trigger.time, weekday: days[0] };
      }
      return { ...fallback, time: routine.trigger.time };
    }
    return fallback;
  }
  try {
    const parsed = parseRrule(rrule);
    const time = formatTime(parsed.byHour?.[0] ?? 0, parsed.byMinute?.[0] ?? 0);
    const intervalWindow = intervalWindowFromRrule(parsed);
    if (intervalWindow) {
      return {
        ...fallback,
        frequency: 'interval',
        intervalMinutes: intervalWindow.everyMinutes,
        intervalWindowEnabled: true,
        intervalWindowStart: intervalWindow.start,
        intervalWindowEnd: intervalWindow.end,
        customRrule: rrule,
      };
    }
    if (parsed.freq === 'MINUTELY' && !parsed.byDay?.length) {
      return { ...fallback, frequency: 'interval', intervalMinutes: parsed.interval ?? 1, customRrule: rrule };
    }
    if (parsed.freq === 'DAILY' && (parsed.interval ?? 1) === 1 && !parsed.byDay?.length) {
      return { ...fallback, frequency: 'daily', time, customRrule: rrule };
    }
    const days = parsed.byDay ?? [];
    if (parsed.freq === 'WEEKLY' && (parsed.interval ?? 1) === 1 && days.join(',') === 'MO,TU,WE,TH,FR') {
      return { ...fallback, frequency: 'weekdays', time, customRrule: rrule };
    }
    if (parsed.freq === 'WEEKLY' && (parsed.interval ?? 1) === 1 && days.length === 1) {
      return {
        ...fallback,
        frequency: 'weekly',
        time,
        weekday: WEEKDAYS.find((day) => day.rrule === days[0])?.value ?? 1,
        customRrule: rrule,
      };
    }
    const custom = customScheduleFromParsed(rrule);
    if (custom) return { ...fallback, frequency: 'custom', customRrule: rrule, ...custom };
    return { ...fallback, frequency: 'custom', time, customRrule: rrule, customUnsupported: true };
  } catch {
    return { ...fallback, frequency: 'custom', customRrule: rrule, customUnsupported: true };
  }
}

function formatTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function customScheduleFromParsed(rrule: string): null | {
  customFrequency: CustomFrequency;
  customInterval: number;
  customTime: string;
  customMinute: number;
  customWeekdays: number[];
  customMonthDay: number;
  customMonth: number;
} {
  const parsed = parseRrule(rrule);
  if ((parsed.byHour?.length ?? 0) > 1 || (parsed.byMinute?.length ?? 0) > 1) return null;
  const customInterval = parsed.interval ?? 1;
  const customTime = formatTime(parsed.byHour?.[0] ?? 0, parsed.byMinute?.[0] ?? 0);

  if (
    parsed.freq === 'HOURLY'
    && parsed.byMinute?.length === 1
    && !parsed.byHour?.length
    && !parsed.byDay?.length
    && !parsed.byMonthDay?.length
    && !parsed.byMonth?.length
  ) {
    return {
      customFrequency: 'HOURLY',
      customInterval,
      customTime,
      customMinute: parsed.byMinute[0],
      customWeekdays: [1],
      customMonthDay: 1,
      customMonth: 1,
    };
  }

  if (parsed.freq === 'DAILY' && !parsed.byDay?.length && !parsed.byMonthDay?.length && !parsed.byMonth?.length) {
    return {
      customFrequency: 'DAILY',
      customInterval,
      customTime,
      customMinute: parsed.byMinute?.[0] ?? 0,
      customWeekdays: [1],
      customMonthDay: 1,
      customMonth: 1,
    };
  }

  if (parsed.freq === 'WEEKLY' && parsed.byDay?.length && !parsed.byMonthDay?.length && !parsed.byMonth?.length) {
    const customWeekdays = parsed.byDay.reduce<number[]>((days, day) => {
      const value = WEEKDAYS.find((item) => item.rrule === day)?.value;
      if (value != null) days.push(value);
      return days;
    }, []);
    if (customWeekdays.length !== parsed.byDay.length) return null;
    return {
      customFrequency: 'WEEKLY',
      customInterval,
      customTime,
      customMinute: parsed.byMinute?.[0] ?? 0,
      customWeekdays,
      customMonthDay: 1,
      customMonth: 1,
    };
  }

  if (
    parsed.freq === 'MONTHLY'
    && parsed.byMonthDay?.length === 1
    && !parsed.byDay?.length
    && !parsed.byMonth?.length
  ) {
    return {
      customFrequency: 'MONTHLY',
      customInterval,
      customTime,
      customMinute: parsed.byMinute?.[0] ?? 0,
      customWeekdays: [1],
      customMonthDay: parsed.byMonthDay[0],
      customMonth: 1,
    };
  }

  if (
    parsed.freq === 'YEARLY'
    && parsed.byMonth?.length === 1
    && parsed.byMonthDay?.length === 1
    && !parsed.byDay?.length
  ) {
    return {
      customFrequency: 'YEARLY',
      customInterval,
      customTime,
      customMinute: parsed.byMinute?.[0] ?? 0,
      customWeekdays: [1],
      customMonthDay: parsed.byMonthDay[0],
      customMonth: parsed.byMonth[0],
    };
  }

  return null;
}

export default function ButlerRoutineCreateDialog({
  routine,
  draft,
  embedded = false,
  onClose,
}: {
  routine?: Routine;
  draft?: Partial<Routine>;
  embedded?: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const addRoutine = useRoutines((state) => state.addRoutine);
  const updateContract = useRoutines((state) => state.updateContract);
  const syncNative = useRoutines((state) => state.syncNative);
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const defaultWorkspaceRoot = useCodexWorkspace((state) => state.defaultWorkspaceRoot);
  const butlerWorkspaceRoot = useCodexWorkspace((state) => state.butlerWorkspaceRoot);
  const environments = useAgentEnvironments((state) => state.environments);
  const models = useCodexWorkspace((state) => state.models);
  const selectedModel = useCodexWorkspace((state) => state.selectedModel);
  const selectedEffort = useCodexWorkspace((state) => state.selectedEffort);
  const threads = useCodexWorkspace((state) => state.threads);
  const activeThreadId = useCodexWorkspace((state) => state.activeThreadId);
  const refreshThreads = useCodexWorkspace((state) => state.refreshThreads);
  const panelRef = useRef<HTMLElement>(null);
  const source = routine ?? draft;
  const schedule = useMemo(() => initialSchedule(source as Routine | undefined), [source]);
  const [name, setName] = useState(source?.name ?? '');
  const [prompt, setPrompt] = useState(source?.prompt ?? '');
  const [kind, setKind] = useState<RoutineKind>(source?.kind ?? 'cron');
  const [targetThreadId, setTargetThreadId] = useState(source?.targetThreadId ?? activeThreadId ?? '');
  const [taskWorkspace, setTaskWorkspace] = useState(source?.workspaceRoot ?? workspaceRoot);
  const [model, setModel] = useState(source?.model ?? selectedModel);
  const [reasoningEffort, setReasoningEffort] = useState(source?.reasoningEffort ?? selectedEffort ?? '');
  const [notificationPolicy, setNotificationPolicy] = useState(
    source?.notificationPolicy ?? (kind === 'heartbeat' ? 'important_updates' : 'all_runs'),
  );
  const [saving, setSaving] = useState(false);
  const [frequency, setFrequency] = useState<Frequency>(schedule.frequency);
  const [eventType, setEventType] = useState<EventRoutineType>(
    source?.trigger?.kind === 'event' ? source.trigger.eventType : 'rc_mention',
  );
  const [eventFilter, setEventFilter] = useState(
    source?.trigger?.kind === 'event' ? source.trigger.filter ?? '' : '',
  );
  const [quietStart, setQuietStart] = useState(source?.quietHours?.start ?? '');
  const [quietEnd, setQuietEnd] = useState(source?.quietHours?.end ?? '');
  const [time, setTime] = useState(schedule.time);
  const [intervalMinutes, setIntervalMinutes] = useState(schedule.intervalMinutes);
  const [intervalWindowEnabled, setIntervalWindowEnabled] = useState(schedule.intervalWindowEnabled);
  const [intervalWindowStart, setIntervalWindowStart] = useState(schedule.intervalWindowStart);
  const [intervalWindowEnd, setIntervalWindowEnd] = useState(schedule.intervalWindowEnd);
  const [weekday, setWeekday] = useState(schedule.weekday);
  const [customRrule] = useState(schedule.customRrule);
  const [customFrequency, setCustomFrequency] = useState<CustomFrequency>(schedule.customFrequency);
  const [customInterval, setCustomInterval] = useState(schedule.customInterval);
  const [customTime, setCustomTime] = useState(schedule.customTime);
  const [customMinute, setCustomMinute] = useState(schedule.customMinute);
  const [customWeekdays, setCustomWeekdays] = useState<number[]>(schedule.customWeekdays);
  const [customMonthDay, setCustomMonthDay] = useState(schedule.customMonthDay);
  const [customMonth, setCustomMonth] = useState(schedule.customMonth);
  const [preserveCustomRrule, setPreserveCustomRrule] = useState(schedule.customUnsupported);

  const activeModel = models.find((item) => item.model === model || item.id === model);
  const projectRoots = environments
    .filter((environment) => environment.enabled)
    .map((environment) => environment.path);
  const projectOptions = [...new Set([taskWorkspace, workspaceRoot, ...projectRoots]
    .filter((root): root is string => Boolean(root) && root !== '~' && root !== defaultWorkspaceRoot))];
  const selectedTaskWorkspace = taskWorkspace === defaultWorkspaceRoot ? '~' : taskWorkspace;
  let rrule = '';
  let trigger: RoutineTrigger | undefined;
  let scheduleError = '';
  try {
    if (frequency === 'event') {
      trigger = {
        kind: 'event',
        eventType,
        ...(eventFilter.trim() ? { filter: eventFilter.trim() } : {}),
      };
      rrule = '';
    } else if (frequency === 'interval') {
      trigger = {
        kind: 'interval',
        everyMinutes: intervalMinutes,
        ...(intervalWindowEnabled
          ? { window: { start: intervalWindowStart, end: intervalWindowEnd } }
          : {}),
      };
      rrule = intervalTriggerToRrule(intervalMinutes, trigger.window);
    } else if (frequency === 'daily') {
      trigger = { kind: 'daily', time };
      rrule = dailyTriggerToRrule(time);
    } else if (frequency === 'weekdays') {
      trigger = { kind: 'daily', time, days: [1, 2, 3, 4, 5] };
      rrule = dailyTriggerToRrule(time, trigger.days);
    } else if (frequency === 'weekly') {
      trigger = { kind: 'daily', time, days: [weekday] };
      rrule = dailyTriggerToRrule(time, trigger.days);
    } else {
      rrule = preserveCustomRrule
        ? normalizeRrule(customRrule)
        : structuredCustomScheduleToRrule({
          freq: customFrequency,
          interval: customInterval,
          time: customTime,
          minute: customMinute,
          days: customWeekdays,
          monthDay: customMonthDay,
          month: customMonth,
        });
    }
  } catch (error) {
    scheduleError = error instanceof Error ? error.message : String(error);
  }
  const hasCronWorkspace = taskWorkspace === '~' || !!taskWorkspace || !!workspaceRoot;
  const canSubmit = !!name.trim()
    && !!prompt.trim()
    && (frequency === 'event' || !!rrule)
    && (kind === 'cron' ? hasCronWorkspace : !!targetThreadId);

  useEffect(() => {
    if (kind === 'heartbeat') void refreshThreads().catch(() => undefined);
  }, [kind, refreshThreads]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || embedded) return;
      const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      ) ?? [])].filter((item) => item.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [embedded, onClose]);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    const patch = {
      name: name.trim(),
      prompt: prompt.trim(),
      trigger,
      rrule,
      kind,
      workspaceRoot: taskWorkspace,
      targetThreadId: kind === 'heartbeat' ? targetThreadId : undefined,
      model: kind === 'cron' ? model || undefined : undefined,
      reasoningEffort: kind === 'cron' ? reasoningEffort || undefined : undefined,
      notificationPolicy,
      ...(quietStart.trim() && quietEnd.trim()
        ? { quietHours: { start: quietStart.trim(), end: quietEnd.trim() } }
        : { quietHours: undefined }),
      skillName: routine?.skillName,
      skillPath: routine?.skillPath,
    };
    try {
      let id: string;
      if (routine) {
        updateContract(routine.id, patch, t('butler.routines.manualEditReason'));
        id = routine.id;
        await syncNative(id, routine);
        toast.success(t('butler.routines.updatedToast'));
      } else {
        const now = Date.now();
        id = crypto.randomUUID();
        addRoutine({
          id,
          ...patch,
          ...(draft?.templateId ? { templateId: draft.templateId } : {}),
          ...(draft?.precheck ? { precheck: draft.precheck } : {}),
          enabled: true,
          createdAt: now,
          updatedAt: now,
          runs: [],
        });
        await syncNative(id, null);
        toast.success(t('butler.routines.createdToast'));
      }
      onClose();
    } catch (error) {
      toast.error(error, routine ? t('butler.routines.updateFailed') : t('butler.routines.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={embedded ? 'butler-routine-editor-slot' : 'butler-routine-editor-overlay'} onMouseDown={(event) => {
      if (!embedded && event.target === event.currentTarget) onClose();
    }}>
      <aside
        ref={panelRef}
        role={embedded ? 'region' : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-label={embedded ? t(routine ? 'butler.routines.editTitle' : 'butler.routines.newTitle') : undefined}
        aria-labelledby={embedded ? undefined : 'butler-routine-editor-title'}
        className={`butler-routine-editor${embedded ? ' is-embedded' : ''}`}
      >
        <header>
          <div>
            <span>{t(routine ? 'butler.routines.editBadge' : 'butler.routines.newBadge')}</span>
            <h2 id="butler-routine-editor-title">{t(routine ? 'butler.routines.editTitle' : 'butler.routines.newTitle')}</h2>
          </div>
          <button type="button" aria-label={t('butler.routines.closeManualAria')} onClick={onClose}><X size={18} aria-hidden="true" /></button>
        </header>

        <form id="butler-routine-create" onSubmit={submit}>
          <label>
            <span>{t('butler.routines.fieldName')}</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={t('butler.routines.fieldNamePlaceholder')} />
          </label>
          <label>
            <span>{t('butler.routines.fieldPrompt')}</span>
            <textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t('butler.routines.fieldPromptPlaceholder')} />
          </label>
          <div className="butler-routine-editor-divider" />
          <label>
            <span>{t('butler.routines.fieldKind')}</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as RoutineKind)}>
              <option value="cron">{t('butler.routines.kindCron')}</option>
              <option value="heartbeat">{t('butler.routines.kindHeartbeat')}</option>
            </select>
          </label>
          {kind === 'heartbeat' ? (
            <label>
              <span>{t('butler.routines.fieldSession')}</span>
              <select value={targetThreadId} onChange={(event) => setTargetThreadId(event.target.value)}>
                <option value="">{t('butler.routines.selectCodexSession')}</option>
                {threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>{thread.name?.trim() || thread.preview.trim() || thread.id}</option>
                ))}
              </select>
              <small>{t('butler.routines.sessionHint')}</small>
            </label>
          ) : null}
          <label>
            <span>{t('butler.routines.fieldProject')}</span>
            <select value={selectedTaskWorkspace} onChange={(event) => setTaskWorkspace(event.target.value)}>
              <option value="">{t('butler.routines.currentWorkspace')}</option>
              <option value="~">{t('butler.routines.tempSessionSystem')}</option>
              {projectOptions.map((root) => (
                <option key={root} value={root}>{root === butlerWorkspaceRoot ? t('butler.routines.butlerSessionSystem') : root}</option>
              ))}
            </select>
            <small>{t('butler.routines.projectHint')}</small>
          </label>

          {kind === 'cron' ? (
            <div className="butler-routine-editor-grid">
              <label>
                <span>{t('butler.routines.fieldModel')}</span>
                <select value={model} onChange={(event) => {
                  const next = models.find((item) => item.model === event.target.value);
                  setModel(event.target.value);
                  setReasoningEffort(next?.defaultReasoningEffort ?? '');
                }}>
                  {models.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}
                </select>
              </label>
              <label>
                <span>{t('butler.routines.fieldReasoning')}</span>
                <select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}>
                  {(activeModel?.supportedReasoningEfforts ?? []).map((item) => (
                    <option key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}

          <div className="butler-routine-editor-divider" />
          <label>
            <span>{t('butler.routines.fieldRepeat')}</span>
            <select value={frequency} onChange={(event) => {
              const next = event.target.value as Frequency;
              setFrequency(next);
              if (next === 'custom') setPreserveCustomRrule(false);
            }}>
              <option value="daily">{t('butler.routines.freqDaily')}</option>
              <option value="weekdays">{t('butler.routines.freqWeekdays')}</option>
              <option value="weekly">{t('butler.routines.freqWeekly')}</option>
              <option value="interval">{t('butler.routines.freqInterval')}</option>
              <option value="custom">{t('butler.routines.freqCustom')}</option>
              <option value="event">{t('butler.routines.freqEvent')}</option>
            </select>
          </label>
          {frequency === 'event' ? (
            <>
              <label>
                <span>{t('butler.routines.eventTypeLabel')}</span>
                <select value={eventType} onChange={(event) => setEventType(event.target.value as EventRoutineType)}>
                  <option value="rc_mention">{t('butler.routines.event.rc_mention')}</option>
                  <option value="ado_assigned">{t('butler.routines.event.ado_assigned')}</option>
                  <option value="git_dirty_reminder">{t('butler.routines.event.git_dirty_reminder')}</option>
                  <option value="work_card_blocked">{t('butler.routines.event.work_card_blocked')}</option>
                </select>
              </label>
              <label>
                <span>{t('butler.routines.eventFilterLabel')}</span>
                <input
                  type="text"
                  value={eventFilter}
                  onChange={(event) => setEventFilter(event.target.value)}
                  placeholder={t('butler.routines.eventFilterPlaceholder')}
                />
              </label>
            </>
          ) : frequency === 'interval' ? (
            <>
              <label>
                <span>{t('butler.routines.everyMinutes')}</span>
                <input
                  type="number"
                  min={MIN_INTERVAL_MINUTES}
                  max={999}
                  value={intervalMinutes}
                  onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                />
                <small>{t('butler.routines.minIntervalHint', { minutes: MIN_INTERVAL_MINUTES })}</small>
              </label>
              <label className="butler-routine-window-toggle">
                <input
                  type="checkbox"
                  checked={intervalWindowEnabled}
                  onChange={(event) => setIntervalWindowEnabled(event.target.checked)}
                />
                <span>{t('butler.routines.windowToggle')}</span>
              </label>
              {intervalWindowEnabled ? (
                <>
                  <div className="butler-routine-editor-grid">
                    <label>
                      <span>{t('butler.routines.windowStart')}</span>
                      <input type="time" step={3600} value={intervalWindowStart} onChange={(event) => setIntervalWindowStart(event.target.value)} />
                    </label>
                    <label>
                      <span>{t('butler.routines.windowEnd')}</span>
                      <input type="time" step={3600} value={intervalWindowEnd} onChange={(event) => setIntervalWindowEnd(event.target.value)} />
                    </label>
                  </div>
                  <small className="butler-routine-window-note">{t('butler.routines.windowNote')}</small>
                </>
              ) : null}
              {scheduleError ? <small role="alert" className="text-danger">{scheduleError}</small> : null}
            </>
          ) : frequency === 'custom' ? (
            <>
              {preserveCustomRrule ? (
                <p className="butler-routine-editor-warning">
                  {t('butler.routines.preserveCustomWarning')}
                </p>
              ) : null}
              <div className="butler-routine-editor-grid">
                <label>
                  <span>{t('butler.routines.customType')}</span>
                  <select value={customFrequency} onChange={(event) => {
                    setPreserveCustomRrule(false);
                    setCustomFrequency(event.target.value as CustomFrequency);
                  }}>
                    {CUSTOM_FREQUENCIES.map((option) => (
                      <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>
                    {t('butler.routines.customEveryUnit', {
                      unit: t((CUSTOM_FREQUENCIES.find((option) => option.value === customFrequency) ?? CUSTOM_FREQUENCIES[0]).intervalUnitKey),
                    })}
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={customInterval}
                    onChange={(event) => {
                      setPreserveCustomRrule(false);
                      setCustomInterval(Number(event.target.value));
                    }}
                  />
                </label>
              </div>
              {customFrequency === 'HOURLY' ? (
                <label>
                  <span>{t('butler.routines.customMinute')}</span>
                  <select value={customMinute} onChange={(event) => {
                    setPreserveCustomRrule(false);
                    setCustomMinute(Number(event.target.value));
                  }}>
                    {Array.from({ length: 60 }, (_, minute) => (
                      <option key={minute} value={minute}>{t('butler.routines.minuteOption', { minute: String(minute).padStart(2, '0') })}</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {customFrequency === 'WEEKLY' ? (
                <fieldset>
                  <legend>{t('butler.routines.customWeekdays')}</legend>
                  <div>
                    {WEEKDAYS.map((day) => (
                      <button
                        key={day.value}
                        type="button"
                        aria-pressed={customWeekdays.includes(day.value)}
                        onClick={() => {
                          setPreserveCustomRrule(false);
                          setCustomWeekdays((current) => {
                            const next = current.includes(day.value)
                              ? current.filter((item) => item !== day.value)
                              : [...current, day.value];
                            return WEEKDAYS
                              .map((item) => item.value)
                              .filter((value) => next.includes(value));
                          });
                        }}
                      >
                        {t(day.labelKey)}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {customFrequency === 'MONTHLY' ? (
                <label>
                  <span>{t('butler.routines.customMonthDay')}</span>
                  <select value={customMonthDay} onChange={(event) => {
                    setPreserveCustomRrule(false);
                    setCustomMonthDay(Number(event.target.value));
                  }}>
                    {MONTH_DAY_OPTIONS.map((day) => <option key={day} value={day}>{t('butler.routines.dayOption', { day })}</option>)}
                  </select>
                </label>
              ) : null}
              {customFrequency === 'YEARLY' ? (
                <div className="butler-routine-editor-grid">
                  <label>
                    <span>{t('butler.routines.customMonth')}</span>
                    <select value={customMonth} onChange={(event) => {
                      setPreserveCustomRrule(false);
                      setCustomMonth(Number(event.target.value));
                    }}>
                      {MONTH_OPTIONS.map((monthOption) => <option key={monthOption} value={monthOption}>{t('butler.routines.monthOption', { month: monthOption })}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>{t('butler.routines.customDay')}</span>
                    <select value={customMonthDay} onChange={(event) => {
                      setPreserveCustomRrule(false);
                      setCustomMonthDay(Number(event.target.value));
                    }}>
                      {MONTH_DAY_OPTIONS.map((day) => <option key={day} value={day}>{t('butler.routines.dayOption', { day })}</option>)}
                    </select>
                  </label>
                </div>
              ) : null}
              {customFrequency !== 'HOURLY' ? (
                <label>
                  <span>{t('butler.routines.customTime')}</span>
                  <input type="time" value={customTime} onChange={(event) => {
                    setPreserveCustomRrule(false);
                    setCustomTime(event.target.value);
                  }} />
                </label>
              ) : null}
              {scheduleError ? <small role="alert" className="text-danger">{scheduleError}</small> : null}
            </>
          ) : (
            <>
              {frequency === 'weekly' ? (
                <label>
                  <span>{t('butler.routines.customDay')}</span>
                  <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
                    {WEEKDAYS.map((day) => <option key={day.value} value={day.value}>{t(day.longLabelKey)}</option>)}
                  </select>
                </label>
              ) : null}
              <label>
                <span>{t('butler.routines.customTime')}</span>
                <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
              </label>
            </>
          )}

          <label>
            <span>{t('butler.routines.fieldNotification')}</span>
            <select value={notificationPolicy} onChange={(event) => setNotificationPolicy(event.target.value as typeof notificationPolicy)}>
              <option value="all_runs">{t('butler.routines.notifyAllRuns')}</option>
              <option value="important_updates">{t('butler.routines.notifyImportant')}</option>
              <option value="failed_runs_only">{t('butler.routines.notifyFailedOnly')}</option>
              <option value="digest_only">{t('butler.routines.notifyDigestOnly')}</option>
              <option value="silent">{t('butler.routines.notifySilent')}</option>
            </select>
          </label>
          <div className="butler-routine-editor-grid">
            <label>
              <span>{t('butler.routines.quietStartLabel')}</span>
              <input type="time" value={quietStart} onChange={(event) => setQuietStart(event.target.value)} />
            </label>
            <label>
              <span>{t('butler.routines.quietEndLabel')}</span>
              <input type="time" value={quietEnd} onChange={(event) => setQuietEnd(event.target.value)} />
            </label>
          </div>
          {frequency === 'event' ? null : (
            <small className="butler-routine-local-note">{t('butler.routines.localTomlNote')}</small>
          )}
        </form>

        <footer>
          <button type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" form="butler-routine-create" disabled={!canSubmit || saving}>{saving ? t('butler.routines.saving') : routine ? t('common.save') : t('butler.routines.createSubmit')}</button>
        </footer>
      </aside>
    </div>
  );
}
