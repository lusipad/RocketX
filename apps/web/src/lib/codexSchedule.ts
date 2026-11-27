import { t, type MessageKey } from '../i18n';

export const RRULE_PREFIX = 'RRULE:';

export const RRULE_FREQUENCIES = [
  'MINUTELY',
  'HOURLY',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'YEARLY',
] as const;

export const RRULE_WEEKDAYS = [
  'MO',
  'TU',
  'WE',
  'TH',
  'FR',
  'SA',
  'SU',
] as const;

export const STRUCTURED_CUSTOM_FREQUENCIES = [
  'HOURLY',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'YEARLY',
] as const;

export type RruleFrequency = (typeof RRULE_FREQUENCIES)[number];
export type RruleWeekday = (typeof RRULE_WEEKDAYS)[number];
export type StructuredCustomFrequency = (typeof STRUCTURED_CUSTOM_FREQUENCIES)[number];
export type RruleLike = string | ParsedRrule;

export interface ParsedRrule {
  freq: RruleFrequency;
  interval?: number;
  byMinute?: number[];
  byHour?: number[];
  byDay?: RruleWeekday[];
  byMonthDay?: number[];
  byMonth?: number[];
}

export interface StructuredCustomSchedule {
  freq: StructuredCustomFrequency;
  interval?: number;
  time?: string;
  minute?: number;
  days?: readonly number[];
  monthDay?: number;
  month?: number;
}

export interface IntervalWindow {
  start: string;
  end: string;
}

export interface IntervalWindowSchedule extends IntervalWindow {
  everyMinutes: number;
}

type RruleKey =
  | 'FREQ'
  | 'INTERVAL'
  | 'BYMINUTE'
  | 'BYHOUR'
  | 'BYDAY'
  | 'BYMONTHDAY'
  | 'BYMONTH';

const RRULE_KEYS: readonly RruleKey[] = [
  'FREQ',
  'INTERVAL',
  'BYMONTH',
  'BYMONTHDAY',
  'BYDAY',
  'BYHOUR',
  'BYMINUTE',
] as const;

const RRULE_KEY_SET = new Set<RruleKey>(RRULE_KEYS);
const RRULE_FREQUENCY_SET = new Set<RruleFrequency>(RRULE_FREQUENCIES);
const RRULE_WEEKDAY_SET = new Set<RruleWeekday>(RRULE_WEEKDAYS);
const WEEKDAY_ORDER = new Map<RruleWeekday, number>(RRULE_WEEKDAYS.map((day, index) => [day, index]));
const JS_DAY_TO_RRULE: Record<number, RruleWeekday> = {
  0: 'SU',
  1: 'MO',
  2: 'TU',
  3: 'WE',
  4: 'TH',
  5: 'FR',
  6: 'SA',
};

export function parseRrule(input: string): ParsedRrule {
  if (typeof input !== 'string') throw new Error(t('butler.schedule.error.mustBeString'));
  const trimmed = input.trim();
  if (!trimmed) throw new Error(t('butler.schedule.error.cannotBeEmpty'));
  if (!trimmed.toUpperCase().startsWith(RRULE_PREFIX)) {
    throw new Error(t('butler.schedule.error.mustStartWithPrefix', { prefix: RRULE_PREFIX }));
  }

  const body = trimmed.slice(trimmed.indexOf(':') + 1).trim();
  if (!body) throw new Error(t('butler.schedule.error.missingBody'));

  const parts = body.split(';');
  const values = new Map<RruleKey, string>();
  for (const part of parts) {
    const segment = part.trim();
    if (!segment) throw new Error(t('butler.schedule.error.emptySegment'));
    const eqIndex = segment.indexOf('=');
    if (eqIndex <= 0 || eqIndex === segment.length - 1 || segment.indexOf('=', eqIndex + 1) >= 0) {
      throw new Error(t('butler.schedule.error.invalidSegment', { segment }));
    }
    const key = segment.slice(0, eqIndex).trim().toUpperCase();
    const value = segment.slice(eqIndex + 1).trim();
    if (!RRULE_KEY_SET.has(key as RruleKey)) throw new Error(t('butler.schedule.error.unsupportedField', { key }));
    if (values.has(key as RruleKey)) throw new Error(t('butler.schedule.error.duplicateField', { key }));
    values.set(key as RruleKey, value);
  }

  return normalizeParsed({
    freq: parseFrequency(requiredValue(values, 'FREQ')),
    interval: values.has('INTERVAL') ? parsePositiveInteger('INTERVAL', values.get('INTERVAL')!) : undefined,
    byMinute: values.has('BYMINUTE') ? parseIntegerList('BYMINUTE', values.get('BYMINUTE')!, 0, 59) : undefined,
    byHour: values.has('BYHOUR') ? parseIntegerList('BYHOUR', values.get('BYHOUR')!, 0, 23) : undefined,
    byDay: values.has('BYDAY') ? parseDayList(values.get('BYDAY')!) : undefined,
    byMonthDay: values.has('BYMONTHDAY') ? parseIntegerList('BYMONTHDAY', values.get('BYMONTHDAY')!, 1, 31) : undefined,
    byMonth: values.has('BYMONTH') ? parseIntegerList('BYMONTH', values.get('BYMONTH')!, 1, 12) : undefined,
  });
}

export function normalizeRrule(input: RruleLike): string {
  const rule = typeof input === 'string' ? parseRrule(input) : normalizeParsed(input);
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval && rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byMonth?.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  if (rule.byMonthDay?.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byDay?.length) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.byHour?.length) parts.push(`BYHOUR=${rule.byHour.join(',')}`);
  if (rule.byMinute?.length) parts.push(`BYMINUTE=${rule.byMinute.join(',')}`);
  return `${RRULE_PREFIX}${parts.join(';')}`;
}

export function isRruleDue(input: RruleLike, nowMs: number, lastRunAt?: number): boolean {
  const rule = typeof input === 'string' ? parseRrule(input) : normalizeParsed(input);
  const now = asDate('nowMs', nowMs);
  const last = lastRunAt == null ? undefined : asDate('lastRunAt', lastRunAt);

  if (!matchesRule(rule, now)) return false;
  if (!last) return true;
  if (last.getTime() > now.getTime()) return false;
  if (sameLocalMinute(last, now)) return false;

  const interval = rule.interval ?? 1;
  if (interval <= 1) return true;

  const currentPeriod = startOfPeriod(rule.freq, now);
  const lastPeriod = startOfPeriod(rule.freq, last);
  const periodsApart = diffPeriods(rule.freq, lastPeriod, currentPeriod);
  if (periodsApart < 0) return false;
  if (periodsApart === 0) return now.getTime() > last.getTime();
  return periodsApart % interval === 0;
}

export function describeRrule(input: RruleLike): string {
  const rule = typeof input === 'string' ? parseRrule(input) : normalizeParsed(input);
  const interval = rule.interval ?? 1;
  const timeText = describeTime(rule);
  const intervalWindow = intervalWindowFromParsed(rule);

  if (intervalWindow) {
    return t('butler.routines.triggerWindowInterval', {
      start: intervalWindow.start,
      end: intervalWindow.end,
      minutes: intervalWindow.everyMinutes,
    });
  }

  if (
    rule.freq === 'MINUTELY'
    && !rule.byMinute?.length
    && !rule.byHour?.length
    && !rule.byDay?.length
    && !rule.byMonthDay?.length
    && !rule.byMonth?.length
  ) {
    return interval === 1 ? t('butler.schedule.everyMinute') : t('butler.schedule.everyMinutes', { interval });
  }

  if (
    rule.freq === 'HOURLY'
    && !rule.byMinute?.length
    && !rule.byHour?.length
    && !rule.byDay?.length
    && !rule.byMonthDay?.length
    && !rule.byMonth?.length
  ) {
    return interval === 1 ? t('butler.schedule.everyHour') : t('butler.schedule.everyHours', { interval });
  }

  if (rule.freq === 'HOURLY' && !rule.byHour?.length && rule.byMinute?.length === 1) {
    const minute = pad2(rule.byMinute![0]);
    return interval === 1
      ? t('butler.schedule.hourlyAtMinute', { minute })
      : t('butler.schedule.everyHoursAtMinute', { interval, minute });
  }

  if (rule.freq === 'DAILY') {
    if (isWorkday(rule.byDay)) return t('butler.schedule.everyWorkday', { time: timeText });
    if (!rule.byDay?.length) {
      return interval === 1
        ? t('butler.schedule.everyDayAt', { time: timeText })
        : t('butler.schedule.everyNDaysAt', { interval, time: timeText });
    }
    const days = describeWeekdays(rule.byDay);
    return interval === 1
      ? t('butler.schedule.dailyDays', { days, time: timeText })
      : t('butler.schedule.dailyIntervalDays', { interval, days, time: timeText });
  }

  if (rule.freq === 'WEEKLY') {
    if (isWorkday(rule.byDay)) {
      return interval === 1
        ? t('butler.schedule.weeklyWorkday', { time: timeText })
        : t('butler.schedule.weeklyIntervalWorkday', { interval, time: timeText });
    }
    const days = rule.byDay?.length ? describeWeekdays(rule.byDay) : t('butler.schedule.weeklyFallback');
    return interval === 1
      ? t('butler.schedule.weeklyDays', { days, time: timeText })
      : t('butler.schedule.weeklyIntervalDays', { interval, days, time: timeText });
  }

  if (rule.freq === 'MONTHLY') {
    const dayText = rule.byMonthDay?.length
      ? rule.byMonthDay.map((day) => t('butler.schedule.monthDayItem', { day })).join(t('butler.listSeparator'))
      : t('butler.schedule.sameDayOfMonth');
    return interval === 1
      ? t('butler.schedule.monthly', { days: dayText, time: timeText })
      : t('butler.schedule.monthlyInterval', { interval, days: dayText, time: timeText });
  }

  if (rule.freq === 'YEARLY') {
    const monthText = rule.byMonth?.length
      ? t('butler.schedule.yearlyMonthGroup', {
          months: rule.byMonth.map((month) => t(`butler.schedule.monthShort.${month}` as MessageKey)).join(t('butler.listSeparator')),
        })
      : t('butler.schedule.everyYear');
    const dayText = rule.byMonthDay?.length
      ? rule.byMonthDay.map((day) => t('butler.schedule.monthDayItem', { day })).join(t('butler.listSeparator'))
      : '';
    return (interval === 1
      ? t('butler.schedule.yearly', { months: monthText, days: dayText, time: timeText })
      : t('butler.schedule.yearlyInterval', { interval, months: monthText, days: dayText, time: timeText })
    ).replace(/\s+/g, ' ').trim();
  }

  const constraints = [
    rule.byMonth?.length
      ? t('butler.schedule.yearlyMonthGroup', {
          months: rule.byMonth.map((month) => t(`butler.schedule.monthShort.${month}` as MessageKey)).join(t('butler.listSeparator')),
        })
      : '',
    rule.byMonthDay?.length
      ? rule.byMonthDay.map((day) => t('butler.schedule.monthDayItem', { day })).join(t('butler.listSeparator'))
      : '',
    rule.byDay?.length ? describeWeekdays(rule.byDay) : '',
    timeText,
  ].filter(Boolean);
  const unit = freqLabel(rule.freq);
  const head = interval === 1
    ? t('butler.schedule.fallbackHead', { unit })
    : t('butler.schedule.fallbackIntervalHead', { interval, unit });
  return `${head} ${constraints.join(' ')}`.trim();
}

export function dailyTriggerToRrule(time: string, days?: readonly number[]): string {
  const { hour, minute } = parseTime(time);
  const byDay = normalizeJsDays(days);
  if (!byDay?.length || byDay.length === RRULE_WEEKDAYS.length) {
    return normalizeRrule({
      freq: 'DAILY',
      byHour: [hour],
      byMinute: [minute],
    });
  }
  return normalizeRrule({
    freq: 'WEEKLY',
    byDay,
    byHour: [hour],
    byMinute: [minute],
  });
}

export function intervalTriggerToRrule(everyMinutes: number, window?: IntervalWindow): string {
  if (!Number.isInteger(everyMinutes) || everyMinutes <= 0) {
    throw new Error(t('butler.schedule.error.everyMinutesPositive'));
  }
  if (window) {
    const start = parseTime(window.start);
    const end = parseTime(window.end);
    if (start.minute !== 0 || end.minute !== 0) {
      throw new Error(t('butler.schedule.error.windowHourlyBoundary'));
    }
    if (end.hour <= start.hour) {
      throw new Error(t('butler.schedule.error.windowEndAfterStart'));
    }
    if (60 % everyMinutes !== 0) {
      throw new Error(t('butler.schedule.error.windowDivides60'));
    }
    return normalizeRrule({
      freq: 'DAILY',
      byHour: Array.from({ length: end.hour - start.hour }, (_, index) => start.hour + index),
      byMinute: Array.from({ length: 60 / everyMinutes }, (_, index) => index * everyMinutes),
    });
  }
  return normalizeRrule({
    freq: 'MINUTELY',
    interval: everyMinutes,
  });
}

export function intervalWindowFromRrule(input: RruleLike): IntervalWindowSchedule | undefined {
  const rule = typeof input === 'string' ? parseRrule(input) : normalizeParsed(input);
  return intervalWindowFromParsed(rule);
}

export function structuredCustomScheduleToRrule(schedule: StructuredCustomSchedule): string {
  const interval = schedule.interval == null ? 1 : parsePositiveInteger('INTERVAL', String(schedule.interval));
  switch (schedule.freq) {
    case 'HOURLY':
      return normalizeRrule({
        freq: 'HOURLY',
        interval,
        byMinute: normalizeNumberArray('BYMINUTE', [schedule.minute ?? 0], 0, 59),
      });
    case 'DAILY': {
      const { hour, minute } = parseTime(schedule.time ?? '');
      return normalizeRrule({
        freq: 'DAILY',
        interval,
        byHour: [hour],
        byMinute: [minute],
      });
    }
    case 'WEEKLY': {
      const { hour, minute } = parseTime(schedule.time ?? '');
      return normalizeRrule({
        freq: 'WEEKLY',
        interval,
        byDay: normalizeJsDays(schedule.days),
        byHour: [hour],
        byMinute: [minute],
      });
    }
    case 'MONTHLY': {
      const { hour, minute } = parseTime(schedule.time ?? '');
      return normalizeRrule({
        freq: 'MONTHLY',
        interval,
        byMonthDay: normalizeNumberArray('BYMONTHDAY', [schedule.monthDay ?? Number.NaN], 1, 31),
        byHour: [hour],
        byMinute: [minute],
      });
    }
    case 'YEARLY': {
      const { hour, minute } = parseTime(schedule.time ?? '');
      return normalizeRrule({
        freq: 'YEARLY',
        interval,
        byMonth: normalizeNumberArray('BYMONTH', [schedule.month ?? Number.NaN], 1, 12),
        byMonthDay: normalizeNumberArray('BYMONTHDAY', [schedule.monthDay ?? Number.NaN], 1, 31),
        byHour: [hour],
        byMinute: [minute],
      });
    }
  }
}

function normalizeParsed(input: ParsedRrule): ParsedRrule {
  if (!input || typeof input !== 'object') throw new Error(t('butler.schedule.error.invalidObject'));
  const freq = parseFrequency(String(input.freq ?? ''));
  const interval = input.interval == null ? undefined : parsePositiveInteger('INTERVAL', String(input.interval));
  const byMinute = normalizeNumberArray('BYMINUTE', input.byMinute, 0, 59);
  const byHour = normalizeNumberArray('BYHOUR', input.byHour, 0, 23);
  const byDay = normalizeWeekdayArray(input.byDay);
  const byMonthDay = normalizeNumberArray('BYMONTHDAY', input.byMonthDay, 1, 31);
  const byMonth = normalizeNumberArray('BYMONTH', input.byMonth, 1, 12);

  if (freq === 'WEEKLY' && !byDay?.length) throw new Error(t('butler.schedule.error.weeklyNeedsByDay'));
  if (freq === 'MONTHLY' && !byMonthDay?.length) throw new Error(t('butler.schedule.error.monthlyNeedsByMonthDay'));
  if (freq === 'YEARLY' && (!byMonth?.length || !byMonthDay?.length)) {
    throw new Error(t('butler.schedule.error.yearlyNeedsMonthAndDay'));
  }

  return {
    freq,
    ...(interval ? { interval } : {}),
    ...(byMinute?.length ? { byMinute } : {}),
    ...(byHour?.length ? { byHour } : {}),
    ...(byDay?.length ? { byDay } : {}),
    ...(byMonthDay?.length ? { byMonthDay } : {}),
    ...(byMonth?.length ? { byMonth } : {}),
  };
}

function intervalWindowFromParsed(rule: ParsedRrule): IntervalWindowSchedule | undefined {
  if (
    rule.freq !== 'DAILY'
    || (rule.interval ?? 1) !== 1
    || rule.byDay?.length
    || rule.byMonthDay?.length
    || rule.byMonth?.length
    || !rule.byHour?.length
    || !rule.byMinute?.length
    || rule.byHour.length * rule.byMinute.length < 2
  ) return undefined;

  const firstHour = rule.byHour[0];
  if (!rule.byHour.every((hour, index) => hour === firstHour + index)) return undefined;
  if (rule.byMinute[0] !== 0) return undefined;

  const everyMinutes = rule.byMinute.length === 1 ? 60 : rule.byMinute[1];
  if (
    everyMinutes <= 0
    || 60 % everyMinutes !== 0
    || rule.byMinute.length !== 60 / everyMinutes
    || !rule.byMinute.every((minute, index) => minute === index * everyMinutes)
  ) return undefined;

  return {
    everyMinutes,
    start: `${pad2(firstHour)}:00`,
    end: `${pad2(rule.byHour.at(-1)! + 1)}:00`,
  };
}

function requiredValue(values: Map<RruleKey, string>, key: RruleKey): string {
  const value = values.get(key);
  if (!value) throw new Error(t('butler.schedule.error.missingField', { key }));
  return value;
}

function parseFrequency(value: string): RruleFrequency {
  const freq = value.trim().toUpperCase() as RruleFrequency;
  if (!RRULE_FREQUENCY_SET.has(freq)) throw new Error(t('butler.schedule.error.unsupportedFreq', { value }));
  return freq;
}

function parsePositiveInteger(name: string, value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(t('butler.schedule.error.mustBePositiveInt', { name }));
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(t('butler.schedule.error.mustBePositiveInt', { name }));
  return parsed;
}

function parseIntegerList(name: string, value: string, min: number, max: number): number[] {
  const parts = value.split(',').map((item) => item.trim());
  if (!parts.length || parts.some((item) => !item)) throw new Error(t('butler.schedule.error.listCannotBeEmpty', { name }));
  const out = parts.map((item) => {
    if (!/^\d+$/.test(item)) throw new Error(t('butler.schedule.error.intRange', { name, min, max }));
    const parsed = Number(item);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(t('butler.schedule.error.intRange', { name, min, max }));
    }
    return parsed;
  });
  return sortUniqueNumbers(name, out);
}

function parseDayList(value: string): RruleWeekday[] {
  const parts = value.split(',').map((item) => item.trim().toUpperCase());
  if (!parts.length || parts.some((item) => !item)) throw new Error(t('butler.schedule.error.byDayEmpty'));
  const out = parts.map((item) => {
    if (!RRULE_WEEKDAY_SET.has(item as RruleWeekday)) throw new Error(t('butler.schedule.error.unsupportedByDay', { value: item }));
    return item as RruleWeekday;
  });
  return sortUniqueWeekdays(out);
}

function normalizeNumberArray(
  name: 'BYMINUTE' | 'BYHOUR' | 'BYMONTHDAY' | 'BYMONTH',
  value: readonly number[] | undefined,
  min: number,
  max: number,
): number[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error(t('butler.schedule.error.nonEmptyArray', { name }));
  return sortUniqueNumbers(name, value.map((item) => {
    if (!Number.isInteger(item) || item < min || item > max) {
      throw new Error(t('butler.schedule.error.intRange', { name, min, max }));
    }
    return item;
  }));
}

function normalizeWeekdayArray(value: readonly RruleWeekday[] | undefined): RruleWeekday[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error(t('butler.schedule.error.byDayNonEmptyArray'));
  return sortUniqueWeekdays(value.map((item) => {
    const normalized = String(item).toUpperCase();
    if (!RRULE_WEEKDAY_SET.has(normalized as RruleWeekday)) throw new Error(t('butler.schedule.error.unsupportedByDay', { value: String(item) }));
    return normalized as RruleWeekday;
  }));
}

function sortUniqueNumbers(name: string, values: readonly number[]): number[] {
  const out = [...values].sort((left, right) => left - right);
  for (let index = 1; index < out.length; index += 1) {
    if (out[index] === out[index - 1]) throw new Error(t('butler.schedule.error.noDuplicate', { name }));
  }
  return out;
}

function sortUniqueWeekdays(values: readonly RruleWeekday[]): RruleWeekday[] {
  const out = [...values].sort((left, right) => (WEEKDAY_ORDER.get(left) ?? 0) - (WEEKDAY_ORDER.get(right) ?? 0));
  for (let index = 1; index < out.length; index += 1) {
    if (out[index] === out[index - 1]) throw new Error(t('butler.schedule.error.byDayNoDuplicate'));
  }
  return out;
}

function parseTime(value: string): { hour: number; minute: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(t('butler.schedule.error.timeFormat'));
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(t('butler.schedule.error.timeFormat'));
  return { hour, minute };
}

function normalizeJsDays(days?: readonly number[]): RruleWeekday[] | undefined {
  if (days == null) return undefined;
  if (!Array.isArray(days) || days.length === 0) throw new Error(t('butler.schedule.error.daysNonEmptyArray'));
  const mapped = days.map((day) => {
    if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error(t('butler.schedule.error.daysRange'));
    return JS_DAY_TO_RRULE[day];
  });
  return sortUniqueWeekdays(mapped);
}

function matchesRule(rule: ParsedRrule, now: Date): boolean {
  if (rule.byMonth?.length && !rule.byMonth.includes(now.getMonth() + 1)) return false;
  if (rule.byMonthDay?.length && !rule.byMonthDay.includes(now.getDate())) return false;
  if (rule.byDay?.length && !rule.byDay.includes(JS_DAY_TO_RRULE[now.getDay()])) return false;

  const hours = effectiveHours(rule);
  if (hours && !hours.includes(now.getHours())) return false;
  const minutes = effectiveMinutes(rule);
  if (minutes && !minutes.includes(now.getMinutes())) return false;

  return true;
}

function effectiveHours(rule: ParsedRrule): readonly number[] | undefined {
  if (rule.byHour?.length) return rule.byHour;
  if (rule.freq === 'MINUTELY' || rule.freq === 'HOURLY') return undefined;
  return [0];
}

function effectiveMinutes(rule: ParsedRrule): readonly number[] | undefined {
  if (rule.byMinute?.length) return rule.byMinute;
  if (rule.freq === 'MINUTELY') return undefined;
  return [0];
}

function describeTime(rule: ParsedRrule): string {
  const hours = effectiveHours(rule);
  const minutes = effectiveMinutes(rule);
  if (!hours && !minutes) return t('butler.schedule.anyTime');
  if (!hours && minutes?.length === 1) return t('butler.schedule.hourlyMinuteTime', { minute: pad2(minutes[0]) });
  if (hours?.length === 1 && !minutes) return t('butler.schedule.hourEveryMinuteTime', { hour: pad2(hours[0]) });
  if (!hours || !minutes) return t('butler.schedule.customTime');

  const pairs: string[] = [];
  for (const hour of hours) {
    for (const minute of minutes) {
      pairs.push(`${pad2(hour)}:${pad2(minute)}`);
      if (pairs.length > 6) return t('butler.schedule.multipleTimes');
    }
  }
  return pairs.join(t('butler.listSeparator'));
}

function isWorkday(days?: readonly RruleWeekday[]): boolean {
  return !!days && days.length === 5 && days.join(',') === 'MO,TU,WE,TH,FR';
}

function describeWeekdays(days: readonly RruleWeekday[]): string {
  return days.map((day) => weekdayLabel(day)).join(t('butler.listSeparator'));
}

function weekdayLabel(day: RruleWeekday): string {
  return t(`butler.schedule.weekday.${day}` as MessageKey);
}

function freqLabel(freq: RruleFrequency): string {
  return t(`butler.schedule.freqUnit.${freq}` as MessageKey);
}

function asDate(name: string, value: number): Date {
  if (!Number.isFinite(value)) throw new Error(t('butler.schedule.error.validTimestamp', { name }));
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(t('butler.schedule.error.validTimestamp', { name }));
  return date;
}

function sameLocalMinute(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
    && left.getHours() === right.getHours()
    && left.getMinutes() === right.getMinutes();
}

function startOfPeriod(freq: RruleFrequency, date: Date): Date {
  switch (freq) {
    case 'MINUTELY':
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), 0, 0);
    case 'HOURLY':
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
    case 'DAILY':
      return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    case 'WEEKLY': {
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const offset = (start.getDay() + 6) % 7;
      start.setDate(start.getDate() - offset);
      return start;
    }
    case 'MONTHLY':
      return new Date(date.getFullYear(), date.getMonth(), 1);
    case 'YEARLY':
      return new Date(date.getFullYear(), 0, 1);
  }
}

function diffPeriods(freq: RruleFrequency, left: Date, right: Date): number {
  switch (freq) {
    case 'MINUTELY':
      return Math.floor((right.getTime() - left.getTime()) / 60_000);
    case 'HOURLY':
      return Math.floor((right.getTime() - left.getTime()) / 3_600_000);
    case 'DAILY':
      return dayIndex(right) - dayIndex(left);
    case 'WEEKLY':
      return Math.floor((dayIndex(right) - dayIndex(left)) / 7);
    case 'MONTHLY':
      return (right.getFullYear() - left.getFullYear()) * 12 + (right.getMonth() - left.getMonth());
    case 'YEARLY':
      return right.getFullYear() - left.getFullYear();
  }
}

function dayIndex(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
