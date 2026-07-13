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

  const q = buildQueue({
    account: me,
    today,
    todos: [t('done', yesterday, true), t('later', undefined), t('overdue', yesterday), t('today', today)],
    workItems: [wi(1), wi(2, 1)],
    prs: [prs[0], prs[1], prs[4]], // 待我评审 / 我提的已通过 / 与我无关
    builds: [bld(1, 'succeeded'), bld(2, 'failed')],
  });
  const kinds = q.map((i) => i.kind);

  check(
    '排序：逾期 → 构建失败 → 待我评审 → 今天到期 → P1工作项 → 已通过PR → 工作项 → 待办',
    kinds.join(' ') ===
      'overdue-todo failed-build review-pr today-todo urgent-workitem approved-pr workitem todo',
    kinds.join(' '),
  );
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
  const { renderMarkdown } = await import('../apps/web/src/lib/markdown');
  const html = (md: string) => renderToStaticMarkup(renderMarkdown(md) as any);

  check('标题：# 标题 → <h1>', html('# 发布计划').includes('<h1'), html('# 发布计划').slice(0, 60));
  check('标题：### → <h3>', html('### 三级').includes('<h3'));
  check(
    '#128 不是标题（# 后没空格）—— 工作项引用不能被误伤',
    !html('#128 已修复').includes('<h1'),
    html('#128 已修复').slice(0, 80),
  );
  check('#general 不是标题（频道引用）', !html('#general 讨论一下').includes('<h1'));
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

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  if (failed > 0) process.exit(1);
}

void main();
