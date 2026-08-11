import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
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
  type Routine,
  type RoutineKind,
  type RoutineTrigger,
} from '../stores/routines';
import { toast } from '../stores/toast';

const WEEKDAYS = [
  { value: 1, rrule: 'MO', label: '一' },
  { value: 2, rrule: 'TU', label: '二' },
  { value: 3, rrule: 'WE', label: '三' },
  { value: 4, rrule: 'TH', label: '四' },
  { value: 5, rrule: 'FR', label: '五' },
  { value: 6, rrule: 'SA', label: '六' },
  { value: 0, rrule: 'SU', label: '日' },
] as const;

type Frequency = 'daily' | 'weekdays' | 'weekly' | 'interval' | 'custom';
type CustomFrequency = 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

const CUSTOM_FREQUENCIES = [
  { value: 'HOURLY', label: '每小时', intervalUnit: '小时' },
  { value: 'DAILY', label: '每天', intervalUnit: '天' },
  { value: 'WEEKLY', label: '每周', intervalUnit: '周' },
  { value: 'MONTHLY', label: '每月', intervalUnit: '个月' },
  { value: 'YEARLY', label: '每年', intervalUnit: '年' },
] as const satisfies readonly { value: CustomFrequency; label: string; intervalUnit: string }[];

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
    if (frequency === 'interval') {
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
    && !!rrule
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
      skillName: routine?.skillName,
      skillPath: routine?.skillPath,
    };
    try {
      let id: string;
      if (routine) {
        updateContract(routine.id, patch, '手动编辑');
        id = routine.id;
        await syncNative(id, routine);
        toast.success('已更新任务');
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
        toast.success('已创建并开启任务');
      }
      onClose();
    } catch (error) {
      toast.error(error, routine ? '无法更新任务' : '无法创建任务');
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
        aria-label={embedded ? (routine ? '编辑已安排任务' : '新建已安排任务') : undefined}
        aria-labelledby={embedded ? undefined : 'butler-routine-editor-title'}
        className={`butler-routine-editor${embedded ? ' is-embedded' : ''}`}
      >
        <header>
          <div>
            <span>{routine ? '编辑' : '新建'}</span>
            <h2 id="butler-routine-editor-title">{routine ? '编辑已安排任务' : '新建已安排任务'}</h2>
          </div>
          <button type="button" aria-label="关闭手动设置" onClick={onClose}><X size={18} aria-hidden="true" /></button>
        </header>

        <form id="butler-routine-create" onSubmit={submit}>
          <label>
            <span>名称</span>
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：每天整理发布风险" />
          </label>
          <label>
            <span>任务说明</span>
            <textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="说明每次运行要完成什么，以及怎样算完成。" />
          </label>
          <div className="butler-routine-editor-divider" />
          <label>
            <span>运行方式</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as RoutineKind)}>
              <option value="cron">新任务</option>
              <option value="heartbeat">现有会话</option>
            </select>
          </label>
          {kind === 'heartbeat' ? (
            <label>
              <span>会话</span>
              <select value={targetThreadId} onChange={(event) => setTargetThreadId(event.target.value)}>
                <option value="">选择 Codex 会话</option>
                {threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>{thread.name?.trim() || thread.preview.trim() || thread.id}</option>
                ))}
              </select>
              <small>运行结果会继续写入该会话。</small>
            </label>
          ) : null}
          <label>
            <span>项目</span>
            <select value={selectedTaskWorkspace} onChange={(event) => setTaskWorkspace(event.target.value)}>
              <option value="">当前工作区</option>
              <option value="~">临时会话（系统管理）</option>
              {projectOptions.map((root) => (
                <option key={root} value={root}>{root === butlerWorkspaceRoot ? '管家会话（系统管理）' : root}</option>
              ))}
            </select>
            <small>临时会话适合一次性任务，管家会话保留长期上下文；托管项目需先在 AI 管家左侧添加。</small>
          </label>

          {kind === 'cron' ? (
            <div className="butler-routine-editor-grid">
              <label>
                <span>模型</span>
                <select value={model} onChange={(event) => {
                  const next = models.find((item) => item.model === event.target.value);
                  setModel(event.target.value);
                  setReasoningEffort(next?.defaultReasoningEffort ?? '');
                }}>
                  {models.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}
                </select>
              </label>
              <label>
                <span>推理</span>
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
            <span>重复</span>
            <select value={frequency} onChange={(event) => {
              const next = event.target.value as Frequency;
              setFrequency(next);
              if (next === 'custom') setPreserveCustomRrule(false);
            }}>
              <option value="daily">每天</option>
              <option value="weekdays">工作日</option>
              <option value="weekly">每周</option>
              <option value="interval">按分钟间隔</option>
              <option value="custom">自定义计划</option>
            </select>
          </label>
          {frequency === 'interval' ? (
            <>
              <label>
                <span>每隔（分钟）</span>
                <input
                  type="number"
                  min={MIN_INTERVAL_MINUTES}
                  max={999}
                  value={intervalMinutes}
                  onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                />
                <small>最短间隔为 {MIN_INTERVAL_MINUTES} 分钟。</small>
              </label>
              <label className="butler-routine-window-toggle">
                <input
                  type="checkbox"
                  checked={intervalWindowEnabled}
                  onChange={(event) => setIntervalWindowEnabled(event.target.checked)}
                />
                <span>只在指定时段运行</span>
              </label>
              {intervalWindowEnabled ? (
                <>
                  <div className="butler-routine-editor-grid">
                    <label>
                      <span>开始时间</span>
                      <input type="time" step={3600} value={intervalWindowStart} onChange={(event) => setIntervalWindowStart(event.target.value)} />
                    </label>
                    <label>
                      <span>结束时间</span>
                      <input type="time" step={3600} value={intervalWindowEnd} onChange={(event) => setIntervalWindowEnd(event.target.value)} />
                    </label>
                  </div>
                  <small className="butler-routine-window-note">结束时间不包含；例如 09:00–20:00 的最后一次为 19:45。</small>
                </>
              ) : null}
              {scheduleError ? <small role="alert" className="text-danger">{scheduleError}</small> : null}
            </>
          ) : frequency === 'custom' ? (
            <>
              {preserveCustomRrule ? (
                <p className="butler-routine-editor-warning">
                  当前规则超出结构化编辑范围。直接保存会保留原计划；如需修改，请重新设置下面的自定义计划。
                </p>
              ) : null}
              <div className="butler-routine-editor-grid">
                <label>
                  <span>计划类型</span>
                  <select value={customFrequency} onChange={(event) => {
                    setPreserveCustomRrule(false);
                    setCustomFrequency(event.target.value as CustomFrequency);
                  }}>
                    {CUSTOM_FREQUENCIES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>每隔（{CUSTOM_FREQUENCIES.find((option) => option.value === customFrequency)?.intervalUnit}）</span>
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
                  <span>分钟</span>
                  <select value={customMinute} onChange={(event) => {
                    setPreserveCustomRrule(false);
                    setCustomMinute(Number(event.target.value));
                  }}>
                    {Array.from({ length: 60 }, (_, minute) => (
                      <option key={minute} value={minute}>{String(minute).padStart(2, '0')} 分</option>
                    ))}
                  </select>
                </label>
              ) : null}
              {customFrequency === 'WEEKLY' ? (
                <fieldset>
                  <legend>星期</legend>
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
                        {day.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              {customFrequency === 'MONTHLY' ? (
                <label>
                  <span>月日</span>
                  <select value={customMonthDay} onChange={(event) => {
                    setPreserveCustomRrule(false);
                    setCustomMonthDay(Number(event.target.value));
                  }}>
                    {MONTH_DAY_OPTIONS.map((day) => <option key={day} value={day}>{day} 日</option>)}
                  </select>
                </label>
              ) : null}
              {customFrequency === 'YEARLY' ? (
                <div className="butler-routine-editor-grid">
                  <label>
                    <span>月份</span>
                    <select value={customMonth} onChange={(event) => {
                      setPreserveCustomRrule(false);
                      setCustomMonth(Number(event.target.value));
                    }}>
                      {MONTH_OPTIONS.map((monthOption) => <option key={monthOption} value={monthOption}>{monthOption} 月</option>)}
                    </select>
                  </label>
                  <label>
                    <span>日期</span>
                    <select value={customMonthDay} onChange={(event) => {
                      setPreserveCustomRrule(false);
                      setCustomMonthDay(Number(event.target.value));
                    }}>
                      {MONTH_DAY_OPTIONS.map((day) => <option key={day} value={day}>{day} 日</option>)}
                    </select>
                  </label>
                </div>
              ) : null}
              {customFrequency !== 'HOURLY' ? (
                <label>
                  <span>时间</span>
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
                  <span>日期</span>
                  <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
                    {WEEKDAYS.map((day) => <option key={day.value} value={day.value}>星期{day.label}</option>)}
                  </select>
                </label>
              ) : null}
              <label>
                <span>时间</span>
                <input type="time" value={time} onChange={(event) => setTime(event.target.value)} />
              </label>
            </>
          )}

          <label>
            <span>通知</span>
            <select value={notificationPolicy} onChange={(event) => setNotificationPolicy(event.target.value as typeof notificationPolicy)}>
              <option value="all_runs">所有运行</option>
              <option value="important_updates">仅重要更新</option>
              <option value="failed_runs_only">仅失败</option>
            </select>
          </label>
          <small className="butler-routine-local-note">保存为 Codex 原生 automation.toml；Codex App 与 RocketX 读取同一任务。</small>
        </form>

        <footer>
          <button type="button" onClick={onClose}>取消</button>
          <button type="submit" form="butler-routine-create" disabled={!canSubmit || saving}>{saving ? '保存中…' : routine ? '保存' : '创建'}</button>
        </footer>
      </aside>
    </div>
  );
}
