import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dailyTriggerToRrule,
  describeRrule,
  intervalWindowFromRrule,
  intervalTriggerToRrule,
  isRruleDue,
  normalizeRrule,
  parseRrule,
  structuredCustomScheduleToRrule,
} from '../../apps/web/src/lib/codexSchedule';

function at(year: number, month: number, day: number, hour: number, minute: number): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

test('parseRrule 和 normalizeRrule 规范前缀、大小写与字段顺序', () => {
  assert.deepEqual(parseRrule('  rrule:byminute=30;freq=daily;byhour=9;interval=1  '), {
    freq: 'DAILY',
    interval: 1,
    byHour: [9],
    byMinute: [30],
  });
  assert.equal(
    normalizeRrule('rrule:byminute=30;freq=daily;byhour=9;interval=1'),
    'RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=30',
  );
});

test('dailyTriggerToRrule 生成每日规则，并且只在精确分钟触发', () => {
  const rule = dailyTriggerToRrule('08:30');
  assert.equal(rule, 'RRULE:FREQ=DAILY;BYHOUR=8;BYMINUTE=30');
  assert.equal(describeRrule(rule), '每天 08:30');
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 8, 29)), false);
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 8, 30)), true);
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 8, 31)), false);
});

test('工作日迁移为每周规则，描述输出中文工作日', () => {
  const rule = dailyTriggerToRrule('09:00', [1, 2, 3, 4, 5]);
  assert.equal(rule, 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0');
  assert.equal(describeRrule(rule), '每个工作日 09:00');
  assert.equal(isRruleDue(rule, at(2026, 8, 10, 9, 0)), true);
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 9, 0)), false);
});

test('intervalTriggerToRrule 支持每 N 分钟，并按 lastRunAt 控制间隔', () => {
  const rule = intervalTriggerToRrule(15);
  const first = at(2026, 8, 9, 10, 0);
  assert.equal(rule, 'RRULE:FREQ=MINUTELY;INTERVAL=15');
  assert.equal(describeRrule(rule), '每 15 分钟');
  assert.equal(isRruleDue(rule, first), true);
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 10, 10), first), false);
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 10, 15), first), true);
});

test('时间窗间隔生成 Codex 可读取的标准 RRULE，并且结束时间不包含', () => {
  const rule = intervalTriggerToRrule(15, { start: '09:00', end: '20:00' });

  assert.equal(
    rule,
    'RRULE:FREQ=DAILY;BYHOUR=9,10,11,12,13,14,15,16,17,18,19;BYMINUTE=0,15,30,45',
  );
  assert.deepEqual(intervalWindowFromRrule(rule), {
    everyMinutes: 15,
    start: '09:00',
    end: '20:00',
  });
  assert.equal(describeRrule(rule), '每天 09:00–20:00，每 15 分钟');
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 8, 45)), false);
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 9, 0)), true);
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 19, 45)), true);
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 20, 0)), false);
});

test('时间窗只接受同日整点边界和可精确落入整小时的间隔', () => {
  assert.throws(
    () => intervalTriggerToRrule(15, { start: '20:00', end: '09:00' }),
    /晚于开始时间/,
  );
  assert.throws(
    () => intervalTriggerToRrule(15, { start: '09:15', end: '20:00' }),
    /整点/,
  );
  assert.throws(
    () => intervalTriggerToRrule(45, { start: '09:00', end: '20:00' }),
    /整除 60/,
  );
});

test('同一分钟不会重复触发', () => {
  const daily = dailyTriggerToRrule('08:30');
  const minute = at(2026, 8, 9, 8, 30);
  assert.equal(isRruleDue(daily, minute, minute + 20_000), false);

  const interval = intervalTriggerToRrule(15);
  const dueMinute = at(2026, 8, 9, 10, 15);
  assert.equal(isRruleDue(interval, dueMinute, dueMinute + 5_000), false);
});

test('每周规则支持同一周内多个 BYDAY 命中', () => {
  const rule = normalizeRrule({
    freq: 'WEEKLY',
    byDay: ['TU', 'TH'],
    byHour: [14],
    byMinute: [5],
  });
  const tuesday = at(2026, 8, 11, 14, 5);
  const thursday = at(2026, 8, 13, 14, 5);

  assert.equal(rule, 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=14;BYMINUTE=5');
  assert.equal(describeRrule(rule), '每周二、周四 14:05');
  assert.equal(isRruleDue(rule, tuesday), true);
  assert.equal(isRruleDue(rule, at(2026, 8, 12, 14, 5), tuesday), false);
  assert.equal(isRruleDue(rule, thursday, tuesday), true);
});

test('HOURLY 规则支持边界分钟和间隔小时', () => {
  const rule = normalizeRrule({
    freq: 'HOURLY',
    interval: 2,
    byMinute: [5],
  });
  const last = at(2026, 8, 9, 8, 5);

  assert.equal(rule, 'RRULE:FREQ=HOURLY;INTERVAL=2;BYMINUTE=5');
  assert.equal(describeRrule(rule), '每 2 小时的 05 分');
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 9, 5), last), false);
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 10, 5), last), true);
});

test('Codex 原生 HOURLY 规则省略分钟时仍可安全展示', () => {
  assert.equal(describeRrule('RRULE:FREQ=HOURLY;INTERVAL=2'), '每 2 小时');
});

test('结构化自定义计划可序列化为 RFC5545 RRULE', () => {
  assert.equal(
    structuredCustomScheduleToRrule({ freq: 'HOURLY', interval: 2, minute: 5 }),
    'RRULE:FREQ=HOURLY;INTERVAL=2;BYMINUTE=5',
  );
  assert.equal(
    structuredCustomScheduleToRrule({ freq: 'DAILY', interval: 3, time: '09:45' }),
    'RRULE:FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=45',
  );
  assert.equal(
    structuredCustomScheduleToRrule({ freq: 'WEEKLY', interval: 2, time: '14:05', days: [2, 4] }),
    'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;BYHOUR=14;BYMINUTE=5',
  );
  assert.equal(
    structuredCustomScheduleToRrule({ freq: 'MONTHLY', interval: 2, time: '08:00', monthDay: 15 }),
    'RRULE:FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15;BYHOUR=8;BYMINUTE=0',
  );
  assert.equal(
    structuredCustomScheduleToRrule({ freq: 'YEARLY', interval: 2, time: '23:59', month: 12, monthDay: 31 }),
    'RRULE:FREQ=YEARLY;INTERVAL=2;BYMONTH=12;BYMONTHDAY=31;BYHOUR=23;BYMINUTE=59',
  );
});

test('MONTHLY 和 YEARLY 规则按本地日期判断', () => {
  const monthly = normalizeRrule({
    freq: 'MONTHLY',
    byMonthDay: [15],
    byHour: [8],
    byMinute: [0],
  });
  const yearly = normalizeRrule({
    freq: 'YEARLY',
    byMonth: [12],
    byMonthDay: [31],
    byHour: [23],
    byMinute: [59],
  });

  assert.equal(describeRrule(monthly), '每月 15 日 08:00');
  assert.equal(describeRrule(yearly), '每年 12 月 31 日 23:59');
  assert.equal(isRruleDue(monthly, at(2026, 8, 15, 8, 0)), true);
  assert.equal(isRruleDue(monthly, at(2026, 8, 14, 8, 0)), false);
  assert.equal(isRruleDue(yearly, at(2026, 12, 31, 23, 59)), true);
  assert.equal(isRruleDue(yearly, at(2026, 12, 30, 23, 59)), false);
});

test('DAILY、WEEKLY、MONTHLY、YEARLY 的 interval 规则按周期触发', () => {
  const daily = structuredCustomScheduleToRrule({ freq: 'DAILY', interval: 2, time: '09:30' });
  const weekly = structuredCustomScheduleToRrule({ freq: 'WEEKLY', interval: 2, time: '09:00', days: [1] });
  const monthly = structuredCustomScheduleToRrule({ freq: 'MONTHLY', interval: 3, time: '08:00', monthDay: 15 });
  const yearly = structuredCustomScheduleToRrule({ freq: 'YEARLY', interval: 2, time: '23:59', month: 12, monthDay: 31 });

  assert.equal(isRruleDue(daily, at(2026, 8, 10, 9, 30), at(2026, 8, 9, 9, 30)), false);
  assert.equal(isRruleDue(daily, at(2026, 8, 11, 9, 30), at(2026, 8, 9, 9, 30)), true);
  assert.equal(isRruleDue(weekly, at(2026, 8, 10, 9, 0), at(2026, 8, 3, 9, 0)), false);
  assert.equal(isRruleDue(weekly, at(2026, 8, 17, 9, 0), at(2026, 8, 3, 9, 0)), true);
  assert.equal(isRruleDue(monthly, at(2026, 9, 15, 8, 0), at(2026, 8, 15, 8, 0)), false);
  assert.equal(isRruleDue(monthly, at(2026, 11, 15, 8, 0), at(2026, 8, 15, 8, 0)), true);
  assert.equal(isRruleDue(yearly, at(2025, 12, 31, 23, 59), at(2024, 12, 31, 23, 59)), false);
  assert.equal(isRruleDue(yearly, at(2026, 12, 31, 23, 59), at(2024, 12, 31, 23, 59)), true);
});

test('午夜边界也按本地时间触发', () => {
  const rule = dailyTriggerToRrule('00:00');
  assert.equal(describeRrule(rule), '每天 00:00');
  assert.equal(isRruleDue(rule, at(2026, 8, 9, 0, 0)), true);
  assert.equal(isRruleDue(rule, at(2026, 8, 8, 23, 59)), false);
});

test('非法或不支持的 RRULE 会被拒绝', () => {
  assert.throws(
    () => parseRrule('RRULE:FREQ=DAILY;FREQ=WEEKLY;BYHOUR=9;BYMINUTE=0'),
    /重复/,
  );
  assert.throws(
    () => parseRrule('RRULE:FREQ=DAILY;COUNT=2;BYHOUR=9;BYMINUTE=0'),
    /不支持/,
  );
  assert.throws(
    () => parseRrule('RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=60'),
    /BYMINUTE/,
  );
  assert.throws(
    () => parseRrule('RRULE:FREQ=WEEKLY;BYDAY=XX;BYHOUR=9;BYMINUTE=0'),
    /BYDAY/,
  );
  assert.throws(
    () => normalizeRrule('RRULE:FREQ=MONTHLY;BYHOUR=8;BYMINUTE=0'),
    /BYMONTHDAY/,
  );
  assert.throws(
    () => structuredCustomScheduleToRrule({ freq: 'WEEKLY', interval: 1, time: '09:00', days: [] }),
    /days/,
  );
  assert.throws(
    () => intervalTriggerToRrule(0),
    /everyMinutes/,
  );
  assert.throws(
    () => dailyTriggerToRrule('24:00', [1]),
    /HH:MM/,
  );
});
