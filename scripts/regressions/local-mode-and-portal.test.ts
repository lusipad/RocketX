import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ensureAccountScope,
  LOCAL_ACCOUNT_OWNER,
  LOCAL_MODE_USER_ID,
} from '../../apps/web/src/lib/accountScope';
import { hasExistingRocketXUserState } from '../../apps/web/src/lib/firstRun';
import { useAuth } from '../../apps/web/src/stores/auth';

class MemoryLocalStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

test('升级保留无归属旧待办，已按账号归档的旧待办仍可恢复', () => {
  const previous = globalThis.localStorage;
  const storage = new MemoryLocalStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  try {
    storage.setItem('rcx-todos', '[{"id":"unassigned"}]');
    storage.setItem('rcx-unassigned-todos', 'earlier-backup');
    storage.setItem('rcx-todos#A@same-origin', '[{"id":"owned"}]');
    assert.equal(ensureAccountScope(LOCAL_MODE_USER_ID), 'switched');
    assert.equal(storage.getItem('rcx-todos'), null);
    assert.equal(storage.getItem('rcx-unassigned-todos'), 'earlier-backup');
    assert.equal(storage.getItem('rcx-unassigned-todos-1'), '[{"id":"unassigned"}]');
    assert.equal(ensureAccountScope('A'), 'switched');
    assert.equal(storage.getItem('rcx-todos'), '[{"id":"owned"}]');
  } finally {
    (globalThis as { localStorage?: unknown }).localStorage = previous;
  }
});

test('未登录 Rocket.Chat 时 resume 默认直通进入本地工作区，且首次登录真实账号时无损继承本地项目数据', async () => {
  const prevStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const storage = new MemoryLocalStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;

  try {
    assert.equal(hasExistingRocketXUserState(storage), false);

    useAuth.setState({ status: 'boot', localMode: false, user: null, error: null });
    await useAuth.getState().resume();

    // 没有任何 Rocket.Chat 登录凭据或前置点击时，默认直通进入本地工作区
    assert.equal(useAuth.getState().status, 'authed');
    assert.equal(useAuth.getState().localMode, true);
    assert.equal(useAuth.getState().user?._id, LOCAL_MODE_USER_ID);
    assert.equal(storage.getItem('rcx-owner'), LOCAL_ACCOUNT_OWNER);
    assert.equal(hasExistingRocketXUserState(storage), true);

    storage.setItem('rcx-agent-environments', JSON.stringify([{ id: 'env-1', path: 'D:/Repos/demo' }]));
    storage.setItem('rcx-calendar', JSON.stringify([{ id: 'cal-1' }]));

    // 首次登录一个尚未在本机产生归档的真实账号：直接认领本地模式下配好的项目与日历
    assert.equal(ensureAccountScope('user-a'), 'ok');
    assert.equal(storage.getItem('rcx-owner'), 'user-a@same-origin');
    assert.equal(
      storage.getItem('rcx-agent-environments'),
      JSON.stringify([{ id: 'env-1', path: 'D:/Repos/demo' }]),
    );

    // 切换到另一个账号 user-b：user-a 的数据归档，user-b 获得干净空间
    assert.equal(ensureAccountScope('user-b'), 'switched');
    assert.equal(storage.getItem('rcx-agent-environments'), null);
    assert.ok(storage.getItem('rcx-agent-environments#user-a@same-origin'));
  } finally {
    useAuth.setState({ status: 'guest', localMode: false, user: null, error: null });
    if (prevStorage === undefined) {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    } else {
      (globalThis as { localStorage?: unknown }).localStorage = prevStorage;
    }
  }
});

test('主工作区默认免登录直开：仅消息/通讯录按需引导连接 Rocket.Chat，不阻断侧栏与本地模块', () => {
  const app = readFileSync('apps/web/src/App.tsx', 'utf8');
  const main = readFileSync('apps/web/src/main.tsx', 'utf8');
  const mainPage = readFileSync('apps/web/src/pages/MainPage.tsx', 'utf8');
  const login = readFileSync('apps/web/src/pages/LoginPage.tsx', 'utf8');
  const firstRun = readFileSync('apps/web/src/pages/FirstRunPage.tsx', 'utf8');
  const auth = readFileSync('apps/web/src/stores/auth.ts', 'utf8');
  const chat = readFileSync('apps/web/src/stores/chat.ts', 'utf8');
  const prefs = readFileSync('apps/web/src/stores/prefs.ts', 'utf8');
  const navRail = readFileSync('apps/web/src/components/NavRail.tsx', 'utf8');

  assert.match(app, /status !== 'authed' && !localMode/);
  assert.match(main, /!hasPersistedModuleSelection\(\)/);
  assert.match(mainPage, /localMode \? <LoginPage embedded \/>/);
  assert.match(login, /embedded = false/);
  assert.match(login, /使用 AI 管家/);
  assert.match(login, /暂不连接 Rocket\.Chat，本地使用/);
  assert.match(firstRun, /暂不连接，直接本地使用/);
  assert.match(auth, /activateLocalWorkspace/);
  assert.match(auth, /enterLocalMode:/);
  assert.match(auth, /exitLocalMode:/);
  assert.match(chat, /if \(useAuth\.getState\(\)\.localMode\)/);
  assert.match(prefs, /if \(useAuth\.getState\(\)\.localMode\)/);
  assert.match(navRail, /连接 Rocket\.Chat/);
});

test('AI 管家内置统一看板入口与右侧 LobeHub 式任务工作台 Portal 抽屉，且看板不依赖特定 AI 引擎', () => {
  const butlerPage = readFileSync('apps/web/src/pages/ButlerPage.tsx', 'utf8');
  const butlerHistory = readFileSync('apps/web/src/components/ButlerConversationHistory.tsx', 'utf8');
  const butlerConv = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const portalDock = readFileSync('apps/web/src/components/ButlerWorkPortalDock.tsx', 'utf8');

  assert.match(butlerPage, /\{activeView === 'kanban' \? \(/);
  assert.match(butlerPage, /<WorkKanbanBoard initialWork=/);
  assert.match(butlerHistory, /setButlerView\('kanban'\)/);
  assert.match(butlerHistory, /我的工作/);
  assert.match(butlerConv, /<ButlerWorkPortalDock/);
  assert.match(butlerConv, /打开任务工作台/);
  assert.match(portalDock, /<WorkCardPortal/);
});

test('现代 Butler 4 栏布局与统一工作台 Portal（380px/340-560px 拖拽、无损三态切换、1280px 响应式抽屉与现代模型思考强度）', () => {
  const portalDock = readFileSync('apps/web/src/components/ButlerWorkPortalDock.tsx', 'utf8');
  const butlerConv = readFileSync('apps/web/src/components/ButlerConversation.tsx', 'utf8');
  const styles = readFileSync('apps/web/src/styles.css', 'utf8');
  const onboarding = readFileSync('apps/web/src/components/PiQuickOnboardingCard.tsx', 'utf8');

  // 1. 默认 380px 统一工作台与 340px-560px 限制
  assert.match(portalDock, /saved \? parseInt\(saved, 10\) : 380/);
  assert.match(portalDock, /Math\.min\(560, Math\.max\(340/);
  assert.match(portalDock, /rcx-portal-width/);

  // 2. 统一 Portal 平滑切换任务卡、产物与动态，不遮挡左侧会话列表
  assert.match(portalDock, /activeTab === 'workcard'/);
  assert.match(portalDock, /activeTab === 'artifact'/);
  assert.match(portalDock, /activeTab === 'activity'/);
  assert.match(portalDock, /<CodexArtifactPanel/);
  assert.match(butlerConv, /setPortalTab\('artifact'\)/);
  assert.match(butlerConv, /initialTab=\{portalTab\}/);

  // 3. 样式保障：1280px 以下抽屉折叠时左侧历史保持显示，不因 Portal 展开而隐藏
  assert.match(styles, /\.butler-portal-drawer-container/);
  assert.match(styles, /\.butler-portal-backdrop/);
  assert.match(styles, /@media \(max-width: 1279px\)/);
  assert.match(styles, /\.butler-conversation-layout\.has-portal > \.butler-conversation-history\s*\{\s*display: flex;/);

  // 4. Alt+P 快捷键与 Escape 抽屉关闭支持
  assert.match(butlerConv, /event\.altKey && \(event\.key === 'p' \|\| event\.key === 'P'\)/);
  assert.match(portalDock, /event\.key === 'Escape'/);

  // 5. 现代模型标签格式化与拓展思考等级映射
  assert.match(butlerConv, /formatModelLabel/);
  assert.match(butlerConv, /DeepSeek V4 Flash/);
  assert.match(butlerConv, /Claude Sonnet 5\.5/);
  assert.match(butlerConv, /GPT-6\.1 Sol/);
  assert.match(butlerConv, /Gemini 4 Argon/);
  assert.match(butlerConv, /Qwen 3 Coder/);
  assert.match(butlerConv, /'极简'/);
  assert.match(butlerConv, /'极致'/);
  assert.match(onboarding, /gemini-4-argon/);
});
