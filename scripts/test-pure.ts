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

  console.log('\n[分组规则]');
  const { ruleMatches, inFolder } = await import('../apps/web/src/stores/folders');

  check('前缀：WI 命中 WI-1234-登录报错', ruleMatches({ mode: 'prefix', value: 'WI' }, 'WI-1234-登录报错'));
  check('前缀不区分大小写：wi 命中 WI-1234', ruleMatches({ mode: 'prefix', value: 'wi' }, 'WI-1234'));
  check('前缀：WI 不命中 产品周会', !ruleMatches({ mode: 'prefix', value: 'WI' }, '产品周会'));
  check(
    '前缀只认开头：WI 不命中 关于WI的讨论',
    !ruleMatches({ mode: 'prefix', value: 'WI' }, '关于WI的讨论'),
  );
  check('包含：发布 命中 三月发布计划', ruleMatches({ mode: 'contains', value: '发布' }, '三月发布计划'));
  check(
    '正则：^WI-\\d+ 命中 WI-1234',
    ruleMatches({ mode: 'regex', value: '^WI-\\d+' }, 'WI-1234-登录报错'),
  );
  check(
    '正则写错不炸，当作不匹配',
    !ruleMatches({ mode: 'regex', value: '[unclosed' }, 'WI-1234'),
  );
  check('空规则不匹配任何东西', !ruleMatches({ mode: 'prefix', value: '  ' }, 'WI-1234'));

  const folder = { id: 'f1', name: '工作项', rids: ['manual1'], rules: [{ mode: 'prefix' as const, value: 'WI' }] };
  check('手工拖入的会话属于该分组', inFolder(folder, { rid: 'manual1', name: '随便什么名字' }));
  check('规则命中的会话属于该分组', inFolder(folder, { rid: 'other', name: 'WI-999' }));
  check('两者都不满足则不属于', !inFolder(folder, { rid: 'other', name: '产品周会' }));

  console.log('\n[待办]');
  const { isOverdue, dueLabel, todayKey } = await import('../apps/web/src/stores/todos');
  const today = todayKey();
  const yesterday = todayKey(new Date(Date.now() - 86400000));
  const tomorrow = todayKey(new Date(Date.now() + 86400000));
  const base = { id: 'x', rid: 'r', mid: 'm', roomName: '', excerpt: '', author: '', createdAt: 0 };

  check('昨天到期且未完成 → 逾期', isOverdue({ ...base, due: yesterday, done: false }, today));
  check('昨天到期但已完成 → 不算逾期', !isOverdue({ ...base, due: yesterday, done: true }, today));
  check('今天到期 → 不算逾期', !isOverdue({ ...base, due: today, done: false }, today));
  check('没有截止日 → 不算逾期', !isOverdue({ ...base, done: false }, today));
  check('文案：今天到期', dueLabel(today, today) === '今天到期', dueLabel(today, today));
  check('文案：明天到期', dueLabel(tomorrow, today) === '明天到期', dueLabel(tomorrow, today));
  check('文案：已逾期 1 天', dueLabel(yesterday, today) === '已逾期 1 天', dueLabel(yesterday, today));

  console.log('\n[备注名]');
  const { displayName } = await import('../apps/web/src/stores/aliases');
  const aliases = { 'u:zhangsan': '老张', 'r:rid2': '项目群' };

  check(
    '单聊显示用户备注（按用户名匹配，不是显示名）',
    displayName(aliases, { rid: 'rid1', name: '张三', avatarUsername: 'zhangsan' }) === '老张',
  );
  check(
    '会话备注优先于用户备注',
    displayName({ ...aliases, 'r:rid1': '直属领导' }, {
      rid: 'rid1',
      name: '张三',
      avatarUsername: 'zhangsan',
    }) === '直属领导',
  );
  check('群组用会话备注', displayName(aliases, { rid: 'rid2', name: '一堆人' }) === '项目群');
  check('没备注就用原名', displayName(aliases, { rid: 'rid9', name: '产品周会' }) === '产品周会');

  console.log('\n[emoji]');
  const { emojiFromShortcode, emojify } = await import('../apps/web/src/lib/emoji');
  check('cowboy → 🤠', emojiFromShortcode(':cowboy:') === '🤠');
  check('别名 face_with_cowboy_hat → 🤠', emojiFromShortcode('face_with_cowboy_hat') === '🤠');
  check('thumbsup → 👍', emojiFromShortcode('thumbsup') === '👍');
  check(
    '认不出的短代码原样返回',
    emojiFromShortcode(':definitely_not_an_emoji:') === ':definitely_not_an_emoji:',
  );
  check(
    '整句替换：牛仔 :cowboy: 和 :taco:',
    emojify('牛仔 :cowboy: 和 :taco:') === '牛仔 🤠 和 🌮',
    emojify('牛仔 :cowboy: 和 :taco:'),
  );
  check(
    '不认识的短代码在整句替换里保持原样',
    emojify('a :nope_nope: b') === 'a :nope_nope: b',
  );

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

void main();
