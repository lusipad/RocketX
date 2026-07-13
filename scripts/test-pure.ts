/**
 * 纯函数单测：不需要服务器，跑逻辑正确性。
 * 这些 bug（跨天日期、拼音匹配）靠手点界面测不出来。
 *
 *   pnpm test:pure
 */
import { pinyinMatch, pinyinScore } from '../apps/web/src/lib/pinyin';
import { preloadPinyin } from '../apps/web/src/lib/pinyin';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  console.log('\n[拼音检索]');
  // 字典是异步加载的，先等它就绪
  preloadPinyin();
  await new Promise((r) => setTimeout(r, 500));

  check('全拼命中：zhangsan → 张三', pinyinMatch('zhangsan', '张三', 'zhangsan'));
  check('首字母命中：zs → 张三', pinyinMatch('zs', '张三', 'zhangsan'));
  check('原文命中：张 → 张三', pinyinMatch('张', '张三', 'zhangsan'));
  check('首字母命中：tl → 讨论', pinyinMatch('tl', '讨论-abc'));
  check('全拼命中：hexinxiangmu → 核心项目', pinyinMatch('hexinxiangmu', '核心项目'));
  check('首字母命中：hxxm → 核心项目', pinyinMatch('hxxm', '核心项目'));
  check('不匹配：xyz 不命中 张三', !pinyinMatch('xyz', '张三', 'zhangsan'));
  check('英文名不受影响：admin → Administrator', pinyinMatch('admin', 'Administrator', 'admin'));
  check('空关键词全放行', pinyinMatch('', '任何人'));

  // 排序：原文前缀 < 原文包含 < 首字母前缀 < 全拼前缀
  check(
    '排序：原文前缀优先于拼音',
    pinyinScore('张', '张三') < pinyinScore('zs', '张三'),
    `原文=${pinyinScore('张', '张三')} 拼音=${pinyinScore('zs', '张三')}`,
  );
  check(
    '排序：首字母精确命中优于夹带命中',
    pinyinScore('zs', '张三') < pinyinScore('zs', '通知所有人'),
    `张三=${pinyinScore('zs', '张三')} 通知所有人=${pinyinScore('zs', '通知所有人')}`,
  );

  console.log('\n[日期分割线]');
  const { fmtDayDivider, fmtConvTime } = await import('../apps/web/src/lib/format');
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);

  check('今天的消息 → 今天', fmtDayDivider(now) === '今天', fmtDayDivider(now));
  check(
    '昨天的消息 → 昨天',
    fmtDayDivider(startOfToday - 1000) === '昨天',
    fmtDayDivider(startOfToday - 1000),
  );
  check(
    '一周前 → 具体日期',
    /月.*日/.test(fmtDayDivider(now - 8 * DAY)),
    fmtDayDivider(now - 8 * DAY),
  );
  check('会话列表：今天 → HH:mm', /^\d{2}:\d{2}$/.test(fmtConvTime(now)), fmtConvTime(now));
  check(
    '会话列表：昨天 → 昨天',
    fmtConvTime(startOfToday - 1000) === '昨天',
    fmtConvTime(startOfToday - 1000),
  );
  check(
    '会话列表：跨年 → 带年份',
    /^\d{4}\//.test(fmtConvTime(now - 400 * DAY)),
    fmtConvTime(now - 400 * DAY),
  );

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

void main();
