import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function source(path: string): string {
  return readFileSync(path, 'utf8');
}

test('单条消息右键有「交给管家」，忙碌时给提示而不是静默无反应', () => {
  const item = source('apps/web/src/components/MessageItem.tsx');
  assert.match(item, /label: '交给管家'/);
  assert.match(item, /askButlerAboutMessages\(/);
  // ask 在 running 时静默 return，入口必须自己挡并提示
  assert.match(item, /result === 'busy'/);
  // MessageItem 每条消息一个实例：不得订阅 butler store 的 running
  assert.doesNotMatch(item, /useButler\(/);
});

test('多选工具条的两个管家入口带禁用态并退出多选', () => {
  const list = source('apps/web/src/components/MessageList.tsx');
  assert.match(list, /提取承诺/);
  assert.match(list, /总结这段/);
  assert.match(list, /selectedMessages\.length === 0 \|\| butlerRunning/);
  assert.match(list, /exitSelectMode\(\)/);
});

test('PR 行拆出独立按钮：整行不再是链接，避免按钮点击冒泡开外链', () => {
  const lists = source('apps/web/src/components/AdoLists.tsx');
  assert.match(lists, /function PrRow\(/);
  assert.match(lists, /askButlerAboutPullRequests\(/);
  // 结构不变量：PrRow 的根节点必须是 div。若又变回整行 <a>，行内按钮点击
  // 会冒泡去开外链（不写死 className，避免样式微调就误红）
  const body = lists.slice(lists.indexOf('function PrRow('));
  const jsx = body
    .slice(body.indexOf('return ('))
    .split('\n')
    .filter((row) => !row.trim().startsWith('//')) // 注释里出现的 <a> 不算
    .join('\n');
  const rootTag = jsx.match(/<(\w+)/)?.[1];
  assert.equal(rootTag, 'div', 'PrRow 根节点必须是 div');
});

test('PR 比较选择态：跨子 tab 保留，凑齐两个才发起，可取消', () => {
  const lists = source('apps/web/src/components/AdoLists.tsx');
  // 选择态必须放在 PullRequestList（切子 tab 时不卸载），不是子列表里
  assert.match(lists, /export function PullRequestList[\s\S]{0,600}useState<PullRequest\[\]>\(\[\]\)/);
  assert.match(lists, /next\.length < 2/);
  assert.match(lists, /butlerComparePullRequestsPrompt\(/);
  // 忙碌时不清空选择，用户不用重选
  assert.match(lists, /result === 'busy'[\s\S]{0,120}return;/);
  assert.match(lists, /再选一个就开始比较/);
});

test('完整对话折叠场景例句，房间窄版只保留短空态', () => {
  const conversation = source('apps/web/src/components/ButlerConversation.tsx');
  const panel = source('apps/web/src/components/ButlerPanel.tsx');

  assert.match(conversation, /<details[\s\S]*BUTLER_SCENE_PROMPTS/);
  assert.match(conversation, /BUTLER_BOUNDARY_NOTE/);
  assert.match(conversation, /onClick=\{\(\) => setInput\(item\.prompt\)\}/);
  assert.doesNotMatch(panel, /BUTLER_SCENE_PROMPTS|BUTLER_BOUNDARY_NOTE/);
  assert.match(panel, /这个房间还没有管家记录/);
});

test('WELCOME_TEXT 未被改动：它同时被剥离逻辑、动作条与多个回归硬编码依赖', () => {
  const store = source('apps/web/src/stores/butler.ts');
  assert.match(store, /const WELCOME_TEXT = '我是你的管家/);
  // 精确相等剥离欢迎语的逻辑必须还在，否则欢迎语会被喂进模型 transcript
  assert.match(store, /lines\[0\]\.text === WELCOME_TEXT/);
});

test('房间管家是纸的房间浮层：状态行、同一在办列表和输入框', () => {
  const panel = source('apps/web/src/components/ButlerPanel.tsx');
  assert.match(panel, /<ButlerErrandStatusLine sections=\{sections\} \/>/);
  assert.match(panel, /const roomContext = useMemo/);
  assert.match(panel, /const roomExchanges = useMemo/);
  assert.match(panel, /const roomErrands = useMemo/);
  assert.match(panel, /<ButlerErrandRunCard runs=\{roomErrands\} compact \/>/);
  assert.match(panel, /roomExchanges\.map[\s\S]*<ButlerInlineExchange[\s\S]*lines=\{exchange\}/);
  assert.match(panel, /placeholder="问问这个房间的讨论…"/);
  assert.match(panel, /id="room-butler-panel"[\s\S]*role="dialog"/);
  assert.match(panel, /readRoomConversation\(roomContext\)/);
  assert.match(panel, /roomConversationExchanges\(displayLines, rid\)/);
  assert.doesNotMatch(
    panel,
    /useEffect\(\(\) => \{[\s\S]{0,600}openRoomConversation\(roomContext\)/,
    '打开或切换房间浮层不得切换活动 Butler 会话',
  );
  assert.match(panel, /setPanel\(null\);[\s\S]{0,100}openButlerConversation\(\)/);
  assert.doesNotMatch(panel, /setPanel\(null\);[\s\S]{0,100}openButlerPaper\(\)/);
  assert.match(panel, /\{roomRunning \? \(/);
  assert.match(panel, /disabled=\{running \|\| \(!input\.trim\(\) && !images\.length\)\}/);
  assert.doesNotMatch(panel, /ButlerRounds|今天<\/h2>/);
});

test('日历把选中日期作为纸面索引，不新建另一套历史页', () => {
  const calendar = source('apps/web/src/pages/CalendarPage.tsx');
  const ui = source('apps/web/src/stores/ui.ts');

  assert.match(calendar, /aria-label="打开这天的纸"/);
  assert.match(calendar, /openButlerPaper\(selectedDate \?\? today\)/);
  assert.match(ui, /openButlerPaper: \(date\?: string\) => void/);
  assert.match(ui, /butlerPaperDate: date \?\? null/);
  assert.match(ui, /butlerView: 'now'/);
  assert.doesNotMatch(ui, /butlerConversationOpen|butlerManageOpen/);
});

test('在办项是可折叠行，快操作有 aria-label，完整对话入口与底层 codex 注册分层保留', () => {
  const errands = source('apps/web/src/components/ButlerErrandRunCard.tsx');
  const runtime = source('apps/web/src/kernel/runtime.tsx');

  assert.match(errands, /const \[expanded, setExpanded\] = useState<Set<string>>\(\(\) => new Set\(\)\)/);
  assert.match(errands, /aria-expanded=\{isExpanded\}/);
  assert.match(errands, /aria-label=\{isExpanded \? `折叠.*` : `展开.*`\}/);
  assert.match(errands, /aria-label=\{`叫停\$\{errand\.title\}`\}/);
  assert.match(errands, /aria-label=\{`收下\$\{errand\.title\}`\}/);
  assert.match(errands, /aria-label=\{`复制 codex resume \$\{errand\.threadId\}`\}/);

  assert.match(runtime, /\['codex', 'Codex', CodexPage, TerminalSquare\]/);
  assert.match(runtime, /\['butler-view', '管家', ButlerPage, Bell\]/);
});

test('兼容今日纸的主动发现保持克制，输入区使用正确的表面层级', () => {
  const page = source('apps/web/src/pages/ButlerPage.tsx');
  const suggestionSection = /<section aria-label="我主动发现">[\s\S]*?<\/section>/.exec(page)?.[0] ?? '';

  assert.match(suggestionSection, /visibleBriefItems\.map/);
  assert.match(suggestionSection, /转为待办/);
  assert.match(suggestionSection, /忽略/);
  assert.doesNotMatch(suggestionSection, /<details[^>]*\sopen(?:=|\s|>)/);
  assert.match(page, /className="butler-workspace"/);
  assert.match(source('apps/web/src/styles.css'), /\.butler-workspace \{[\s\S]*flex: 1 1 0%;/);
  assert.match(page, /className="butler-workspace-stage flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-surface-3"/);
  assert.match(page, /<section aria-label="统一 Composer" className="butler-composer">/);
  assert.match(page, /placeholder="问、交代或创建/);
  assert.match(page, /交给\{identity\.displayName\}/);
  assert.doesNotMatch(page, /aria-label="添加上下文"/);
  assert.doesNotMatch(page, /aria-label="引用文件或消息"/);
});

test('委托和定时任务工作面都有明确的直接触发入口', () => {
  const page = source('apps/web/src/pages/ButlerPage.tsx');
  const routines = source('apps/web/src/components/ButlerRoutines.tsx');

  assert.match(page, /aria-label="新建委托"/);
  assert.match(page, /aria-label="新建定时任务"/);
  assert.match(routines, /aria-label=\{`\$\{runLabel\}\$\{routine\.name\}`\}/);
  assert.match(routines, /\{running \? '运行中' : runLabel\}/);
});
