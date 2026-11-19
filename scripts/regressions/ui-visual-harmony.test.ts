import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('全局样式遵守 Tailwind v4 @layer 级联规范且移除双层内嵌圆角边框', () => {
  const styles = readFileSync('apps/web/src/styles.css', 'utf8');
  const mainPage = readFileSync('apps/web/src/pages/MainPage.tsx', 'utf8');

  // 所有旧自定义组件规则必须位于 @layer components 内，避免无层样式覆盖 Tailwind 工具类
  assert.match(styles, /@layer base\s*\{/);
  assert.match(styles, /@layer components\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)?\.rcx-glass-header\b/);
  assert.doesNotMatch(styles, /border-radius:\s*14px\s+0\s+0/);

  // 确认 MainPage 主舞台使用平齐贴合边距，不额外嵌套圆角卡片壳
  assert.doesNotMatch(mainPage, /lg:my-1\.5\s+lg:mr-1\.5\s+lg:rounded-2xl/);

  // 花括号成对闭合检查
  let depth = 0;
  for (const ch of styles) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    assert.ok(depth >= 0, 'styles.css 存在多余右花括号');
  }
  assert.equal(depth, 0, 'styles.css 花括号未闭合');
});

test('左侧 NavRail 折叠态图标槽位统一，无嵌套双色块或杂乱边框', () => {
  const navRail = readFileSync('apps/web/src/components/NavRail.tsx', 'utf8');

  assert.match(navRail, /w-\[56px\]/);
  assert.match(navRail, /h-9 w-9/);
  assert.doesNotMatch(navRail, /shadow-raise/);
});

test('Butler 桌面顶栏保持 52px，窄窗对话顶栏随内容增高且无重复侧栏开关或冗长路径', () => {
  const history = readFileSync('apps/web/src/components/ButlerConversationHistory.tsx', 'utf8');
  const conversation = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const kanban = readFileSync('apps/web/src/components/WorkKanbanBoard.tsx', 'utf8');
  const assistant = readFileSync('apps/web/src/components/ButlerAssistantCenter.tsx', 'utf8');
  const styles = readFileSync('apps/web/src/styles.css', 'utf8');

  for (const [name, content] of [
    ['ButlerConversationHistory', history],
    ['ButlerAssistantCenter', assistant],
  ]) {
    assert.match(content, /h-\[52px\]\s+min-h-\[52px\]/, `${name} 缺少 52px 顶栏高度`);
  }
  assert.match(conversation, /<header className="butler-conversation-header work-first-conversation-header /);
  assert.match(styles, /\.butler-conversation-header\s*\{[^}]*height:\s*52px/);
  assert.match(styles, /@media \(max-width: 1023px\)\s*\{\s*\.butler-conversation-pane > \.work-first-conversation-header\s*\{[^}]*height:\s*max-content/);
  assert.match(kanban, /<h1[^>]*>我的工作<\/h1>/);
  assert.match(kanban, /aria-label="管家简报"/);

  // 折叠态才显示主区展开侧栏按钮，避免并排重复 [|]
  assert.match(conversation, /butlerSidebarCollapsed\s*\?\s*\(/);
  assert.doesNotMatch(conversation, /\(\{workspaceRoot\}\)/);

  // 新建对话主按钮保持显式白色文字；导航保持精确契约且不含禁用旧词
  assert.match(history, /<span className="text-white">新管家对话<\/span>/);
  assert.match(history, /<nav className="butler-codex-surface-nav work-first-primary-nav" aria-label="AI 协作">/);
  assert.doesNotMatch(history, /\b(today|memory|paper|manage)\b/i);
});
