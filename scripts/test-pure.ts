/**
 * 纯函数单测：不需要服务器，跑逻辑正确性。
 * 这些 bug（跨天日期、拼音匹配）靠手点界面测不出来。
 *
 *   pnpm test:pure
 */
import { pinyinMatch, pinyinScore } from '../apps/web/src/lib/pinyin';
import {
  commandDesc,
  commandParams,
  filterCommands,
  findCommand,
  parseSlash,
  slashPrefix,
} from '../apps/web/src/lib/slash';
import {
  canActOn,
  canManageRoom,
  canTransferOwnership,
  isMuted,
  sortMembers,
} from '../apps/web/src/lib/roomAdmin';
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
  const { displayName, personName } = await import('../apps/web/src/stores/aliases');
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
  check(
    '备注名（原名）格式用于人员名称',
    personName(aliases, 'zhangsan', '张三', 'aliasWithReal') === '老张（张三）',
  );
  check(
    '备注名（原名）格式用于会话名称',
    displayName(aliases, { rid: 'rid1', name: '张三', avatarUsername: 'zhangsan' }, 'aliasWithReal') ===
      '老张（张三）',
  );

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

  console.log('\n[工作台 · PR 分流]');
  const { reviewPrsOf, myPrsOf, isApproved, matchUser } = await import(
    '../apps/web/src/stores/workbench'
  );
  const mkPr = (
    id: number,
    creator: string,
    reviewers: { unique: string; vote: number }[],
  ) => ({
    id,
    title: `PR ${id}`,
    repo: 'r',
    creator,
    creatorUnique: creator,
    reviewers: reviewers.map((r) => ({ name: r.unique, unique: r.unique, vote: r.vote })),
    sourceBranch: 'f',
    targetBranch: 'main',
    webUrl: '',
  });

  const me = 'lus@example.com';
  const other = 'zhangsan@example.com';
  const prs = [
    mkPr(1, other, [{ unique: me, vote: 0 }]), // 待我评审
    mkPr(2, me, [{ unique: other, vote: 10 }]), // 我提的，已通过
    mkPr(3, me, [{ unique: other, vote: 0 }]), // 我提的，评审中
    mkPr(4, me, [{ unique: me, vote: 10 }]), // 我提的，我自己也是评审人
    mkPr(5, other, [{ unique: other, vote: 0 }]), // 与我无关
  ];

  check('待我评审：只含别人提的、我是评审人的',
    reviewPrsOf(prs, me).map((p) => p.id).join(',') === '1',
    reviewPrsOf(prs, me).map((p) => p.id).join(',') || '空');
  check(
    '自己提的 PR 不进「待我评审」（哪怕我也是评审人）',
    !reviewPrsOf(prs, me).some((p) => p.id === 4),
  );
  check(
    '我提的：按创建人匹配',
    myPrsOf(prs, me).map((p) => p.id).join(',') === '2,3,4',
    myPrsOf(prs, me).map((p) => p.id).join(','),
  );
  check('已批准：所有投过票的都 >= 5', isApproved(prs[1]));
  check('评审中：还有人没投票，不算已批准', !isApproved(prs[2]));
  check(
    '一人拒绝就不算已批准',
    !isApproved(mkPr(9, me, [{ unique: other, vote: 10 }, { unique: 'x', vote: -10 }])),
  );
  check('没有评审人不算已批准', !isApproved(mkPr(10, me, [])));
  check('账号匹配不区分大小写', matchUser('LUS@example.com', me, 'lus'));
  check('空账号不匹配任何人', !matchUser('', me, 'lus'));
  // issue #12：account 与 PR 身份格式不一致时（DOMAIN\ / 邮箱 / 裸名）也要能匹配
  check('归一化：DOMAIN\\lus 能匹配裸账号 lus', matchUser('CORP\\lus', 'lus', '张三'));
  check('归一化：裸账号 lus 能匹配 lus@corp.com', matchUser('lus', 'lus@corp.com', '张三'));
  check('归一化：DOMAIN\\lus 能匹配 lus@corp.com', matchUser('CORP\\lus', 'lus@corp.com', '张三'));
  check('归一化：不同的人仍然不匹配', !matchUser('CORP\\lus', 'wang@corp.com', '王五'));

  // 直连模式：PR 归属改由服务端 rel 标记判定（GUID 过滤），不再靠账号字符串。
  // 传空账号也要能分组——之前空账号会让「待我评审/我提的」全空
  const relPrs = [
    { ...mkPr(11, 'x', []), rel: 'review' as const },
    { ...mkPr(12, 'x', []), rel: 'mine' as const },
    { ...mkPr(14, 'x', []), rel: 'both' as const },
  ];
  check('rel 路由：待我评审含 review',
    reviewPrsOf(relPrs, '').map((p) => p.id).join(',') === '11',
    reviewPrsOf(relPrs, '').map((p) => p.id).join(',') || '空');
  check('rel 路由：我提的含 mine/both',
    myPrsOf(relPrs, '').map((p) => p.id).join(',') === '12,14',
    myPrsOf(relPrs, '').map((p) => p.id).join(','));
  check('rel 路由：both 不进「待我评审」（是我提的）',
    !reviewPrsOf(relPrs, '').some((p) => p.id === 14));

  // 自定义查询 URL 解析
  const { parseQueryUrl } = await import('../apps/web/src/stores/customQueries');
  const cq1 = parseQueryUrl('http://ado:8080/DefaultCollection/MyProject/_queries/query/abcdef01-2345-6789-abcd-ef0123456789');
  check('查询URL：标准格式解析出 project 和 queryId',
    cq1?.project === 'MyProject' && cq1?.queryId === 'abcdef01-2345-6789-abcd-ef0123456789',
    JSON.stringify(cq1));
  const cq2 = parseQueryUrl('http://ado:8080/DefaultCollection/My%20Project/_queries/query-edit/abcdef01-2345-6789-abcd-ef0123456789');
  check('查询URL：URL 编码的项目名 + query-edit 路径',
    cq2?.project === 'My Project' && cq2?.queryId === 'abcdef01-2345-6789-abcd-ef0123456789',
    JSON.stringify(cq2));
  const cq3 = parseQueryUrl('abcdef01-2345-6789-abcd-ef0123456789');
  check('查询URL：裸 GUID 也能识别', cq3?.queryId === 'abcdef01-2345-6789-abcd-ef0123456789');
  check('查询URL：无效输入返回 null', parseQueryUrl('not-a-query-url') === null);

  // 中文 ADO：状态判断必须中英文都认，否则中文流程模板（活动/已解决/已关闭）全部失效
  const { isWorkItemDone, workItemStateCategory } = await import(
    '../apps/web/src/stores/workbench'
  );
  check('中文状态：已解决 算已完成', isWorkItemDone('已解决'));
  check('中文状态：已关闭 算已完成', isWorkItemDone('已关闭'));
  check('中文状态：活动 不算已完成', !isWorkItemDone('活动'));
  check('英文状态：Resolved 仍算已完成', isWorkItemDone('Resolved'));
  check('中文状态归类：进行中 → active', workItemStateCategory('进行中') === 'active');
  check('未知状态归 other 不误杀', workItemStateCategory('自定义状态') === 'other' && !isWorkItemDone('自定义状态'));

  console.log('\n[工作台 · 待处理队列]');
  const { buildQueue, queueSummary } = await import('../apps/web/src/lib/queue');

  const t = (id: string, due: string | undefined, done = false) => ({
    id,
    rid: 'r',
    mid: 'm',
    roomName: '产品群',
    excerpt: `待办 ${id}`,
    author: 'a',
    due,
    done,
    createdAt: 0,
  });
  const wi = (id: number, priority?: number) => ({
    id,
    title: `工作项 ${id}`,
    type: 'Bug',
    state: 'Active',
    priority,
    project: 'P',
    webUrl: '',
  });
  const bld = (id: number, result: string) => ({
    id,
    buildNumber: `b${id}`,
    definition: `pipe-${id}`,
    project: 'P',
    status: 'completed',
    result,
    requestedFor: '',
    queueTime: '',
    finishTime: '',
    webUrl: `http://ado/build/${id}`,
  });

  const calEvent = {
    id: 'c1',
    title: '产品评审会',
    date: today,
    startTime: '14:00',
    endTime: '15:30',
    allDay: false,
    color: '#00b96b',
    source: 'manual',
    createdAt: 0,
  } as any;

  const q = buildQueue({
    account: me,
    today,
    todos: [t('done', yesterday, true), t('later', undefined), t('overdue', yesterday), t('today', today)],
    workItems: [wi(1), wi(2, 1)],
    prs: [prs[0], prs[1], prs[4]], // 待我评审 / 我提的已通过 / 与我无关
    builds: [bld(1, 'succeeded'), bld(2, 'failed')],
    events: [calEvent, { ...calEvent, id: 'c2', date: yesterday }], // 昨天那条不该出现
  });
  const kinds = q.map((i) => i.kind);

  check(
    '排序：逾期 → 构建失败 → 今天日程 → 待我评审 → 今天到期 → P1工作项 → 已通过PR → 工作项 → 待办',
    kinds.join(' ') ===
      'overdue-todo failed-build event review-pr today-todo urgent-workitem approved-pr workitem todo',
    kinds.join(' '),
  );
  check(
    '今天的日程进队列，且带上时间',
    q.find((i) => i.kind === 'event')?.label === '14:00',
    q.find((i) => i.kind === 'event')?.label ?? '（没有日程）',
  );
  check('非今天的日程不进队列', q.filter((i) => i.kind === 'event').length === 1);
  check('已完成的待办不进队列', !q.some((i) => i.key === 'todo-done'));
  check('成功的构建不进队列', !q.some((i) => i.key === 'build-P-1'));
  check('与我无关的 PR 不进队列', !q.some((i) => i.key === 'pr-5'));

  check('待办带上原消息，可跳回上下文', !!q.find((i) => i.kind === 'overdue-todo')?.todo);
  check('ADO 条目带外链', !!q.find((i) => i.kind === 'failed-build')?.href);
  check(
    '摘要点出需要立刻处理的数量',
    queueSummary(q).includes('2 项需要立刻处理'),
    queueSummary(q),
  );
  check('队列为空时给出人话', queueSummary([]) === '今天没有待处理的事');

  console.log('\n[Markdown 渲染]');
  // 用 react-dom/server 把渲染结果转成 HTML 来断言 —— 这比断言 React 元素树可读得多。
  // tsx 在仓库根按 classic runtime 编译 .tsx（jsx: react-jsx 只在 apps/web 的
  // tsconfig 里），所以 JSX 会展开成 React.createElement，得先把 React 挂上全局。
  const React = (await import('react')).default;
  (globalThis as Record<string, unknown>).React = React;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { renderMarkdown, isPureWorkItemText } = await import('../apps/web/src/lib/markdown');
  const html = (md: string) => renderToStaticMarkup(renderMarkdown(md) as any);

  // 工作项引用的形态判定：整条消息只有 #号/ADO 链接 → 大卡片，夹在文字里 → chip + 悬浮卡
  check('纯 #号 → 卡片', isPureWorkItemText('#123'));
  check('多个 #号 → 卡片', isPureWorkItemText(' #123  #456 '));
  check('文字夹 #号 → 悬浮 chip', !isPureWorkItemText('修复了 #123，请验证'));
  check('纯 ADO 工作项链接 → 卡片', isPureWorkItemText('http://ado/c/p/_workitems/edit/12'));
  check(
    '文字夹 ADO 链接 → 悬浮 chip',
    !isPureWorkItemText('看下 http://ado/c/p/_workitems/edit/12 这个'),
  );
  check('#号加频道名不算工作项', !isPureWorkItemText('#general'));

  check('标题：# 标题 → <h1>', html('# 发布计划').includes('<h1'), html('# 发布计划').slice(0, 60));
  check('标题：### → <h3>', html('### 三级').includes('<h3'));
  check(
    '#128 不是标题（# 后没空格）—— 工作项引用不能被误伤',
    !html('#128 已修复').includes('<h1'),
    html('#128 已修复').slice(0, 80),
  );
  check('#general 不是标题（频道引用）', !html('#general 讨论一下').includes('<h1'));
  // P2-b：结尾英文句号不该吞进 #工作项 token（否则认不出是工作项）
  check(
    '#123. 结尾句号不吞进工作项号',
    html('修复了 #123. 完成').includes('#123'),
    html('修复了 #123. 完成').slice(0, 100),
  );
  // P2-d：时间戳里的 :30: 不该被当成 emoji 短代码去发 /emoji-custom 请求
  check(
    '时间戳 10:30:00 不被当 emoji',
    !html('会议 10:30:00 开始').toLowerCase().includes('emoji-custom'),
    html('会议 10:30:00 开始').slice(0, 100),
  );
  check(
    '正常 emoji 短代码仍被识别（:smile: 被转成表情，不再是字面文本）',
    !html('收到 :smile: 谢谢').includes(':smile:'),
    html('收到 :smile: 谢谢').slice(0, 120),
  );
  check('有序列表：1. → 渲染出序号', html('1. 第一步\n2. 第二步').includes('1.'));
  check(
    '任务列表：- [x] → 勾选的复选框',
    html('- [x] 已完成\n- [ ] 未完成').includes('checked'),
  );
  check('表格：| 表头 | + 分隔行 → <table>', html('| A | B |\n| --- | --- |\n| 1 | 2 |').includes('<table'));
  check(
    '表格：单元格少于表头时按表头补齐，不塌',
    (html('| A | B |\n| --- | --- |\n| 1 |').match(/<td/g) ?? []).length === 2,
  );
  check('分割线：--- → <hr>', html('上\n\n---\n\n下').includes('<hr'));
  check('无序列表仍然工作', html('- 一\n- 二').includes('•'));
  check('引用仍然工作', html('> 引用一句').includes('<blockquote'));
  check('代码块仍然工作', html('```\ncode\n```').includes('<pre'));
  check('粗体仍然工作', html('**重点**').includes('<strong'));
  check(
    '标题里的行内格式也要解析',
    html('# **重点**发布').includes('<strong'),
  );
  // 死循环回归：`|` 开头但不构成表格的行曾让 renderBlocks 无限空转、整页冻死。
  // 若修复失效，下面几行会直接挂死进程（CI 超时），能返回就说明护栏生效。
  check('表格死循环：单个 | 不冻死', html('|').includes('|'));
  check(
    '表格死循环：缺分隔行的伪表格当普通文本渲染',
    html('| 姓名 | 年龄 |\n| 张三 | 18 |').includes('姓名'),
  );
  check('表格死循环：引用里的 | 不冻死', html('> | a').includes('<blockquote'));
  // issue #14 的原文:多行 | 开头、分隔行是 ~~~~ 而非 ---- —— 构不成表格，曾无限空转
  check(
    '表格死循环：issue #14 报错输出不冻死',
    html('344 | throw "$xx xxwith exit code $xx"\n| ~~~~~~~~~~~~~~~~\n|  xxx  xxexit code 1').includes(
      'exit code',
    ),
  );

  console.log('\n[会话分区]');
  const { sectionOf } = await import('../apps/web/src/stores/chat');
  const conv = (over: Record<string, unknown>) =>
    ({
      rid: 'r',
      name: 'n',
      type: 'c',
      unread: 0,
      alert: false,
      userMentions: 0,
      favorite: false,
      muted: false,
      isDiscussion: false,
      isMultiDM: false,
      isTeam: false,
      lastTs: 0,
      lastPreview: '',
      ...over,
    }) as any;

  check('1对1 私聊 → 私聊区', sectionOf(conv({ type: 'd' })) === 'direct');
  check(
    '多人聊天 → 独立的「多人聊天」区，不混进频道',
    sectionOf(conv({ type: 'd', isMultiDM: true })) === 'multi',
    sectionOf(conv({ type: 'd', isMultiDM: true })),
  );
  check('有名字的频道 → 频道区', sectionOf(conv({ type: 'c' })) === 'channels');
  check('私有群组 → 频道区', sectionOf(conv({ type: 'p' })) === 'channels');
  check('团队 → 团队区', sectionOf(conv({ type: 'c', isTeam: true })) === 'teams');
  check('讨论 → 讨论区', sectionOf(conv({ type: 'c', isDiscussion: true })) === 'discussions');
  check(
    '收藏优先于一切分区',
    sectionOf(conv({ type: 'd', isMultiDM: true, favorite: true })) === 'favorites',
  );

  console.log('\n[日历 · 重复日程]');
  const cal = await import('../apps/web/src/stores/calendar');
  const { eventsForDate, monthGrid, weekDays, dateKey } = cal;

  const ev = (date: string, repeat?: any) =>
    ({
      id: 'e',
      title: 't',
      date,
      allDay: true,
      color: '#000',
      repeat,
      source: 'manual',
      createdAt: 0,
    }) as any;

  /** 从 start 开始的 n 天里，事件命中了哪些日期 */
  const hits = (event: any, start: string, n: number) => {
    const out: string[] = [];
    const d = new Date(`${start}T00:00:00`);
    for (let i = 0; i < n; i++) {
      const k = dateKey(d);
      if (eventsForDate([event], k).length) out.push(k);
      d.setDate(d.getDate() + 1);
    }
    return out;
  };

  // 「工作日重复，共 3 次」—— 之前 endAfter 对 weekday 完全失效，会无限重复
  const wd = hits(
    ev('2026-07-13', { type: 'weekday', interval: 1, endAfter: 3 }), // 周一
    '2026-07-13',
    14,
  );
  check(
    '工作日重复 + 共 3 次 → 只发生 3 次（之前无限重复）',
    wd.join(',') === '2026-07-13,2026-07-14,2026-07-15',
    wd.join(',') || '（一次都没有）',
  );

  // 工作日重复：周末不出现，且原始日期若是周末也不该冒出来
  const wdSat = hits(ev('2026-07-18', { type: 'weekday', interval: 1 }), '2026-07-18', 5); // 周六
  check(
    '周六创建的工作日重复：那个周六不该显示',
    !wdSat.includes('2026-07-18'),
    wdSat.join(','),
  );

  // 每月 31 号：之前 2/4/6/9/11 月整月消失
  const m31 = hits(ev('2026-01-31', { type: 'monthly', interval: 1 }), '2026-02-01', 90);
  check(
    '每月 31 号：2 月回退到 2/28，不再整月消失',
    m31.includes('2026-02-28'),
    m31.slice(0, 4).join(','),
  );
  check('每月 31 号：4 月回退到 4/30', m31.includes('2026-04-30'), m31.join(','));

  // 「每月 31 号，共 3 次」—— 之前次数按月份差算，用户要 3 次只拿到 2 次
  const m31n = hits(
    ev('2026-01-31', { type: 'monthly', interval: 1, endAfter: 3 }),
    '2026-01-31',
    120,
  );
  check(
    '每月 31 号 + 共 3 次 → 真的发生 3 次',
    m31n.length === 3,
    `${m31n.length} 次：${m31n.join(',')}`,
  );

  // 闰日：2/29 每年重复，平年回退到 2/28
  const leap = hits(ev('2024-02-29', { type: 'yearly', interval: 1 }), '2025-02-20', 10);
  check('2/29 每年重复：平年回退到 2/28（之前要等 4 年）', leap.includes('2025-02-28'), leap.join(','));

  // 自定义：每 2 周的周一和周五，从周三创建
  // 之前用 floor(diffDays/7) 锚定原始日期，会把「周五」和「下周一」算成同一期
  const custom = hits(
    ev('2026-07-15', { type: 'custom', interval: 2, weekdays: [1, 5] }), // 周三
    '2026-07-15',
    21,
  );
  check(
    '每 2 周的周一/周五：同一期的周一周五在同一个自然周里',
    custom.includes('2026-07-17') && !custom.includes('2026-07-20'),
    custom.join(','),
  );
  check(
    '每 2 周：跳过的那一周不出现，隔周才回来',
    !custom.includes('2026-07-24') && custom.includes('2026-07-27'),
    custom.join(','),
  );

  // 自定义但一个星期几都没选 → 不重复（保存时会拦，这里兜底）
  const noWd = hits(ev('2026-07-15', { type: 'custom', interval: 1, weekdays: [] }), '2026-07-15', 10);
  check('自定义重复但没选星期几 → 不重复', noWd.length === 0, noWd.join(','));

  console.log('\n[ADO · 截止日期]');
  const { adoDateToLocal } = await import('../apps/web/src/stores/workbench');

  // ADO 的 DueDate 通常是「当天零点的 UTC」。中国是 UTC+8，直接 slice(0,10) 取 UTC 日期，
  // 凌晨 0-8 点之间会退回前一天 —— 「今天到期」被误判成「已逾期」。
  check(
    'UTC 零点的截止日期 → 本地日期不跑偏',
    adoDateToLocal('2026-07-14T00:00:00Z') === '2026-07-14',
    adoDateToLocal('2026-07-14T00:00:00Z') ?? '(undefined)',
  );
  check(
    '带时间的截止日期也按本地日期算',
    adoDateToLocal('2026-07-14T09:30:00Z') === '2026-07-14',
    adoDateToLocal('2026-07-14T09:30:00Z') ?? '(undefined)',
  );
  check('空值返回 undefined', adoDateToLocal(undefined) === undefined);
  check('非法日期返回 undefined', adoDateToLocal('不是日期') === undefined);

  // 逾期的工作项要排到最前，压过优先级
  const wiOverdue = {
    id: 9,
    title: '早该交的活',
    type: 'Bug',
    state: 'Active',
    priority: 3, // 低优先级
    project: 'P',
    dueDate: `${yesterday}T00:00:00`,
    webUrl: 'http://ado/9',
  } as any;
  const wiP1NoDue = { ...wi(10, 1), title: 'P1 但没截止日' };
  const q3 = buildQueue({
    account: me,
    today,
    todos: [],
    workItems: [wiP1NoDue, wiOverdue],
    prs: [],
    builds: [],
    events: [],
  });
  check(
    '逾期的 P3 排在没有截止日期的 P1 前面（截止日期压过优先级）',
    q3[0]?.title === '早该交的活',
    q3.map((i) => `${i.label}:${i.title}`).join(' | '),
  );
  check('逾期工作项标为「逾期」', q3[0]?.kind === 'overdue-workitem', q3[0]?.kind);
  check(
    '逾期工作项的补充信息里带上逾期天数',
    q3[0]?.meta?.includes('逾期') === true,
    q3[0]?.meta ?? '',
  );
  // issue #17.4：已解决的工作项即便过了截止日，也不该进队列、更不该标逾期
  const wiResolvedOverdue = { ...wiOverdue, id: 11, state: 'Resolved', title: '早解决了' };
  const q4 = buildQueue({
    account: me,
    today,
    todos: [],
    workItems: [wiResolvedOverdue],
    prs: [],
    builds: [],
    events: [],
  });
  check('已解决工作项不进待处理队列（不被标逾期）', q4.length === 0, `${q4.length} 项`);

  console.log('\n[日历 · 标记完成]');
  const { isEventDone } = cal;
  const weekly = ev('2026-07-13', { type: 'weekly', interval: 1 }); // 每周一
  weekly.doneDates = ['2026-07-13'];

  check('标记完成的那一天：已完成', isEventDone(weekly, '2026-07-13'));
  check(
    '重复日程按天记：这周开了不代表下周也开了',
    !isEventDone(weekly, '2026-07-20'),
    '下周一仍应是未完成',
  );
  check('未标记的日程：未完成', !isEventDone(ev('2026-07-13'), '2026-07-13'));

  // 已完成的日程不该再占工作台队列
  const doneToday = {
    id: 'c9',
    title: '已开完的会',
    date: today,
    startTime: '09:00',
    allDay: false,
    color: '#000',
    source: 'manual',
    doneDates: [today],
    createdAt: 0,
  } as any;
  const q2 = buildQueue({
    account: me,
    today,
    todos: [],
    workItems: [],
    prs: [],
    builds: [],
    events: [doneToday],
  });
  check('已完成的日程不进待处理队列', q2.length === 0, `${q2.length} 项`);

  console.log('\n[日历 · 网格]');
  const grid = monthGrid(2026, 6); // 2026 年 7 月
  check('周一起始：月视图第一格是周一', grid[0].getDay() === 1, `getDay=${grid[0].getDay()}`);
  check(
    '月视图行数按需（不再恒定 6 行 42 格）',
    grid.length % 7 === 0 && grid.length <= 42,
    `${grid.length} 格 = ${grid.length / 7} 行`,
  );
  check('月视图包含当月每一天', grid.some((d) => dateKey(d) === '2026-07-31'));
  const wk = weekDays(new Date(2026, 6, 15)); // 周三
  check('周视图从周一开始', wk[0].getDay() === 1 && dateKey(wk[0]) === '2026-07-13', dateKey(wk[0]));

  console.log('\n[斜杠命令]');
  const CMDS = [
    { command: 'kick', params: '@username', description: '把人移出频道' },
    { command: 'mute', params: '@username', description: '禁言' },
    { command: 'me', params: 'your action', description: '' },
    { command: 'msg', params: '@username message', description: '' },
  ];

  check('识别无参命令', parseSlash('/me')?.command === 'me');
  check(
    '识别带参命令并切出参数',
    parseSlash('/kick @zhangsan')?.command === 'kick' &&
      parseSlash('/kick @zhangsan')?.params === '@zhangsan',
  );
  check('命令名大小写不敏感', parseSlash('/KICK @a')?.command === 'kick');
  check('多余空格不影响参数', parseSlash('/kick    @a  ')?.params === '@a');

  // 下面几条是这块最危险的地方：把正常消息误判成命令，等于把用户的话吞掉
  check('路径不是命令：/usr/bin/env', parseSlash('/usr/bin/env') === null);
  check('中文不是命令：/或者这样', parseSlash('/或者这样') === null);
  check('斜杠在句中不是命令', parseSlash('看 a/b 这个文件') === null);
  check('光秃秃一个斜杠不是命令', parseSlash('/') === null);

  check('找得到已知命令（忽略大小写）', findCommand(CMDS, 'KICK')?.command === 'kick');
  check('打错一个字母就找不到 → 不会被当命令执行', findCommand(CMDS, 'kik') === undefined);

  check('光标在命令名上 → 弹补全', slashPrefix('/ki') === 'ki');
  check('刚打了个斜杠 → 弹全部命令', slashPrefix('/') === '');
  check('进了参数区 → 收起补全', slashPrefix('/kick @') === null);
  check('不在开头的斜杠 → 不弹', slashPrefix('hi /kick') === null);

  check('前缀筛选：m → me / msg / mute', filterCommands(CMDS, 'm').length === 3);
  check(
    '开头匹配的排在包含匹配前面',
    filterCommands(CMDS, 'me')[0].command === 'me',
    filterCommands(CMDS, 'me')
      .map((c) => c.command)
      .join(','),
  );
  check('空前缀返回全部', filterCommands(CMDS, '').length === 4);
  // 之前砍到前 8 条：打一个 / 只能看见 27 个命令里的 8 个，剩下的既翻不到也不知道存在
  const many = Array.from({ length: 27 }, (_, i) => ({ command: `cmd${i}` }));
  check('27 个命令一个都不能少（不再截断到 8 条）', filterCommands(many, '').length === 27);
  check('按名字排序，方便扫', filterCommands(CMDS, '')[0].command === 'kick');

  // RC 返回的 description 多半是 i18n 键名（27 个命令里 24 个是），
  // 直接显示就是把 `Slash_Shrug_Description` 糊到用户脸上
  check(
    '已知命令用中文说明，不用服务器的 i18n 键',
    commandDesc({ command: 'kick', description: 'Remove_someone_from_room' }) ===
      '把某人移出本频道',
  );
  check(
    '未知命令 + i18n 键名描述 → 宁可留空',
    commandDesc({ command: 'some-app-cmd', description: 'Some_App_Description' }) === '',
  );
  check(
    '未知命令 + 正常英文描述 → 原样透出',
    commandDesc({ command: 'some-app-cmd', description: 'Send attachment as email' }) ===
      'Send attachment as email',
  );
  check(
    'params 也要挡 i18n 键（/status /topic 的 params 就是键）',
    commandParams({ command: 'topic', params: 'Slash_Topic_Params' }) === '话题内容',
  );
  check(
    '带空格的描述不会被当成 i18n 键',
    commandDesc({ command: 'zzz', description: 'Hello_World and more' }) === 'Hello_World and more',
  );

  console.log('\n[群管理 · 权限]');
  const owner = { _id: 'u1', username: 'owner' };
  const mod = { _id: 'u2', username: 'mod' };
  const plain = { _id: 'u3', username: 'plain' };
  const sysadmin = { _id: 'u4', username: 'root', roles: ['admin'] };
  const ROLES = [
    { _id: 'r1', rid: 'R', u: owner, roles: ['owner'] as const },
    { _id: 'r2', rid: 'R', u: mod, roles: ['moderator'] as const },
  ] as any;

  check('群主能管理', canManageRoom(owner, ROLES, 'p'));
  check('管理员能管理', canManageRoom(mod, ROLES, 'p'));
  check('普通成员不能管理', !canManageRoom(plain, ROLES, 'p'));
  check('系统管理员在任何群都能管理', canManageRoom(sysadmin, ROLES, 'p'));
  check('未登录不能管理', !canManageRoom(null, ROLES, 'p'));
  check('公开频道同样能管理', canManageRoom(owner, ROLES, 'c'));

  check('只有群主能转让群主', canTransferOwnership(owner, ROLES, 'p'));
  check('管理员不能转让群主', !canTransferOwnership(mod, ROLES, 'p'));
  check('系统管理员能转让群主', canTransferOwnership(sysadmin, ROLES, 'p'));

  // 这几条是「谁能对谁动手」的红线，写错了就是越权
  check('管理员踢不了群主', !canActOn(mod, owner as any, ROLES, 'p'));
  check('管理员能踢普通成员', canActOn(mod, plain as any, ROLES, 'p'));
  check('群主能踢管理员', canActOn(owner, mod as any, ROLES, 'p'));
  check('谁都不能对自己动手（要走「退出群组」）', !canActOn(owner, owner as any, ROLES, 'p'));
  check('普通成员谁也动不了', !canActOn(plain, mod as any, ROLES, 'p'));
  check('系统管理员能踢群主', canActOn(sysadmin, owner as any, ROLES, 'p'));

  // 单聊 / 多人聊天在 RC 里都是 t='d'，它们没有频道那套管理能力。
  // 全局 admin 的 roles 里有 'admin'，如果不按房间类型拦一道，管理员就会在多人聊天的
  // 成员列表里看到「移出群聊 / 禁言 / 设管理员」—— 点一个报一个 400（实测过）
  check('多人聊天里系统管理员也不能管理', !canManageRoom(sysadmin, [] as any, 'd'));
  check('多人聊天里系统管理员也不能踢人', !canActOn(sysadmin, plain as any, [] as any, 'd'));
  check('多人聊天里不能转让群主', !canTransferOwnership(sysadmin, [] as any, 'd'));

  check('禁言名单按 username 匹配', isMuted(['lisi'], 'lisi') && !isMuted(['lisi'], 'zhangsan'));
  check('没有禁言名单时不误判', !isMuted(undefined, 'lisi'));

  console.log('\n[收藏链接安全]');
  const { normalizeFavoriteUrl } = await import('../apps/web/src/stores/favorites');
  check('允许 https 收藏链接', normalizeFavoriteUrl('https://example.com/path') === 'https://example.com/path');
  check('允许 http 收藏链接', normalizeFavoriteUrl(' http://localhost:8080 ') === 'http://localhost:8080/');
  check('拒绝 javascript 链接', normalizeFavoriteUrl('javascript:alert(1)') === null);
  check('拒绝 data 链接', normalizeFavoriteUrl('data:text/html,test') === null);
  check('拒绝无协议链接', normalizeFavoriteUrl('example.com') === null);

  console.log('\n[ADO · 工作项模板兼容性]');
  const { preferredWorkItemType, templateSupportsTypes } = await import(
    '../apps/web/src/stores/wiTemplates'
  );
  const featureTemplate = {
    name: 'Feature 全套',
    items: [
      { type: 'Feature', title: '{title}' },
      { type: 'User Story', title: '{title}', parent: 0 },
      { type: 'Task', title: '{title}', parent: 1 },
    ],
  };
  const singleTemplate = { name: '单个', items: [{ type: '{type}', title: '{title}' }] };
  check(
    'Basic 过程不展示 Agile 级联模板',
    !templateSupportsTypes(featureTemplate, ['Epic', 'Issue', 'Task']),
  );
  check(
    '单项模板兼容任意项目类型',
    templateSupportsTypes(singleTemplate, ['Issue']),
  );
  check('类型列表加载失败时不显示可创建模板', !templateSupportsTypes(singleTemplate, []));
  check('优先选择项目真实存在的 Task', preferredWorkItemType(['Issue', 'Task']) === 'Task');
  check(
    '没有 Task 时退到首个真实类型',
    preferredWorkItemType(['Product Backlog Item']) === 'Product Backlog Item',
  );

  console.log('\n[消息 · 合并转发附件]');
  const { forwardableAttachments, mergedForwardAttachments } = await import('../apps/web/src/lib/forward');
  const forwardSources = [
    {
      text: '请看附件',
      ts: '2026-07-15T00:00:00.000Z',
      attachments: [
        { image_url: '/file-upload/thumb', title_link: '/file-upload/original', title: '图.png' },
      ],
    },
    {
      text: '',
      ts: '2026-07-15T00:01:00.000Z',
      attachments: [
        { title: '说明.pdf', title_link: '/file-upload/pdf', title_link_download: true },
      ],
    },
  ];
  const mergedAttachments = mergedForwardAttachments(forwardSources);
  check(
    '合并转发保留原消息文字但不附带发送人',
    !mergedAttachments[0]?.author_name && mergedAttachments[0]?.text === '请看附件',
  );
  check(
    '跨房间转发去掉目标成员无权访问的文件链接',
    !mergedAttachments[1]?.image_url &&
      !mergedAttachments[1]?.title_link &&
      mergedAttachments[1]?.text?.includes('请在原会话查看') === true,
  );
  check(
    '跨房间转发保留附件名称和查看提示',
    mergedAttachments[3]?.title === '说明.pdf' &&
      !mergedAttachments[3]?.title_link &&
      mergedAttachments[3]?.text?.includes('请在原会话查看') === true,
  );
  const sameRoomAttachments = mergedForwardAttachments(forwardSources, true);
  check(
    '同房间转发仍保留图片预览和原图链接',
    sameRoomAttachments[1]?.image_url === '/file-upload/thumb' &&
      sameRoomAttachments[1]?.title_link === '/file-upload/original',
  );
  check(
    '同房间转发仍保留文件下载链接',
    sameRoomAttachments[3]?.title_link_download === true &&
      sameRoomAttachments[3]?.title_link === '/file-upload/pdf',
  );
  const prefixedProtected = forwardableAttachments([
    {
      title: '私密.pdf',
      title_link: 'https://chat.example/rocket/%66ile-upload/id/secret.pdf',
      title_link_download: true,
    },
  ]);
  check(
    '部署前缀和编码路径不能绕过受保护文件识别',
    !prefixedProtected[0]?.title_link &&
      prefixedProtected[0]?.text?.includes('请在原会话查看') === true,
  );

  console.log('\n[Rocket.Chat REST 安全与分页]');
  const { RcRestClient } = await import('../packages/rc-client/src/rest');
  const redirectCalls: Array<{
    url: string;
    headers: Record<string, string>;
    maxRedirections?: number;
  }> = [];
  const redirectFetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    redirectCalls.push({
      url,
      headers,
      maxRedirections: (init as RequestInit & { maxRedirections?: number } | undefined)
        ?.maxRedirections,
    });
    if (url === 'https://chat.example/file-upload/a.txt') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example/a.txt' },
      });
    }
    return new Response('附件内容', { status: 200 });
  }) as typeof fetch;
  const fileClient = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: redirectFetch,
  });
  fileClient.setAuth('secret-token', 'user-1');
  const redirectedFile = await fileClient.fetchFile('/file-upload/a.txt');
  check('文件重定向后仍能下载', (await redirectedFile.text()) === '附件内容');
  check(
    'Rocket.Chat 本源请求带认证头',
    redirectCalls[0]?.headers['X-Auth-Token'] === 'secret-token' &&
      redirectCalls[0]?.maxRedirections === 0,
  );
  check(
    '跳转到外部 CDN 时不泄露认证头',
    redirectCalls[1]?.url === 'https://cdn.example/a.txt' &&
      !redirectCalls[1]?.headers['X-Auth-Token'] &&
      !redirectCalls[1]?.headers['X-User-Id'],
  );

  const memberOffsets: number[] = [];
  const membersFetch = (async (input: URL | RequestInfo) => {
    const url = new URL(String(input));
    const offset = Number(url.searchParams.get('offset') ?? 0);
    memberOffsets.push(offset);
    const members =
      offset === 0
        ? [
            { _id: 'u1', username: 'one', name: '一' },
            { _id: 'u2', username: 'two', name: '二' },
          ]
        : [{ _id: 'u3', username: 'three', name: '三' }];
    return new Response(JSON.stringify({ success: true, members, total: 3 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const membersClient = new RcRestClient({
    baseUrl: 'https://chat.example',
    fetchImpl: membersFetch,
  });
  const allMembers = await membersClient.getMembers('room-1', 'c', 2);
  check(
    '成员列表自动翻页并完整去重',
    allMembers.map((member) => member._id).join(',') === 'u1,u2,u3',
  );
  check('成员列表翻页使用正确 offset', memberOffsets.join(',') === '0,2');

  console.log('\n[ADO Bridge 身份识别]');
  const { AdoClient, connectionIdentity } = await import('../services/ado-bridge/src/ado');
  const bridgeIdentity = connectionIdentity({
    authenticatedUser: {
      id: 'guid',
      providerDisplayName: '张三',
      properties: { Account: { $value: 'CORP\\zhangsan' } },
    },
  });
  check('优先使用 ADO Account 属性', bridgeIdentity.account === 'CORP\\zhangsan');
  check('保留 ADO 身份 GUID', bridgeIdentity.id === 'guid');
  check('缺少 Account 时退回显示名', connectionIdentity({ authenticatedUser: { customDisplayName: '李四' } }).account === '李四');

  const originalGlobalFetch = globalThis.fetch;
  const adoBridgeCalls: string[] = [];
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input);
    adoBridgeCalls.push(url);
    const payload = url.includes('/_apis/wit/wiql')
      ? { workItems: [{ id: 7 }] }
      : {
          value: [
            {
              id: 7,
              fields: {
                'System.Title': '交付版本',
                'System.WorkItemType': 'Task',
                'System.State': 'Active',
                'System.TeamProject': 'test',
                'Microsoft.VSTS.Scheduling.FinishDate': '2026-07-31T00:00:00Z',
              },
            },
          ],
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const bridgeItems = await new AdoClient({ baseUrl: 'http://ado.local/DefaultCollection', pat: '' })
      .getWorkItems('', 1);
    const detailUrl = adoBridgeCalls.find((url) => url.includes('/_apis/wit/workitems?')) ?? '';
    check(
      'Bridge 工作项字段只请求 Server 2022 存在的截止日期字段',
      detailUrl.includes('Microsoft.VSTS.Scheduling.FinishDate') &&
        !detailUrl.includes('Microsoft.VSTS.Common.DueDate'),
    );
    check(
      'Bridge 使用 FinishDate 作为截止日期兜底',
      bridgeItems[0]?.dueDate === '2026-07-31T00:00:00Z',
    );
  } finally {
    globalThis.fetch = originalGlobalFetch;
  }

  const sorted = sortMembers([plain, mod, owner] as any, ROLES).map((u) => u.username);
  check('成员排序：群主 → 管理员 → 普通成员', sorted.join(',') === 'owner,mod,plain', sorted.join(','));

  console.log('\n[站内文件路径归一化]');
  const { normalizeAssetPath } = await import('../apps/web/src/lib/client');
  check(
    '相对路径原样返回',
    normalizeAssetPath('/file-upload/abc/图.png') === '/file-upload/abc/图.png',
  );
  check(
    'Site_Url 拼的绝对地址取回路径部分',
    normalizeAssetPath('http://localhost:3300/file-upload/abc/a.png') === '/file-upload/abc/a.png',
  );
  check(
    '中文文件名：取路径时百分号编码（请求层要的就是编码后的形态）',
    normalizeAssetPath('http://localhost:3300/file-upload/abc/图.png') ===
      '/file-upload/abc/%E5%9B%BE.png',
  );
  check(
    '带查询串保留',
    normalizeAssetPath('https://chat.example.com/avatar/lisi?etag=x') === '/avatar/lisi?etag=x',
  );
  check(
    '外部存储地址（非站内端点）原样保留',
    normalizeAssetPath('https://s3.example.com/bucket/abc.png') ===
      'https://s3.example.com/bucket/abc.png',
  );
  check('非 URL 字符串原样返回', normalizeAssetPath('not-a-url') === 'not-a-url');

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

void main();
