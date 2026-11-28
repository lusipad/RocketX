import '../../apps/web/src/agent/acpButlerWiring';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const shim = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: shim,
    configurable: true,
    writable: true,
  });
  return shim;
}

installMemoryLocalStorage();

import { ACP_CAPABILITIES } from '../../apps/web/src/agent/sessionAdapter';
import {
  bindWorkSessionToCard,
  parseWorkSessionProviderMeta,
  promoteWorkSessionToCard,
  resetAutoBoardedSessionsForTests,
  setSuperAgentRuntimeDriversForTests,
  syncLiveSessionsIntoLedger,
} from '../../apps/web/src/agent/superAgentBridge';
import { enUS } from '../../apps/web/src/i18n/locales/en-US';
import { zhCN } from '../../apps/web/src/i18n/locales/zh-CN';
import type { DiscoveredLocalSession } from '../../apps/web/src/platform/desktopCommands';
import { useAcpAgents } from '../../apps/web/src/stores/acpAgents';
import { useCodexWorkspace } from '../../apps/web/src/stores/codexWorkspace';
import { useSharedAgent } from '../../apps/web/src/stores/sharedAgent';
import { useTodos } from '../../apps/web/src/stores/todos';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';

function resetAllLedgerState() {
  localStorage.clear();
  resetAutoBoardedSessionsForTests();
  useTodos.setState({ todos: [] });
  useSharedAgent.setState({ sessions: {} });
  useAcpAgents.setState({ sessions: {}, activeSessionKey: null });
  useCodexWorkspace.setState({
    threads: [],
    activeThreadId: null,
    threadStates: {},
    workspaceRoot: '',
  });
  useWorkLedger.setState({
    cards: [],
    links: [],
    sessions: [],
    evidences: [],
    events: [],
    actions: [],
  });
}

test('能力矩阵与 bridge 历史恢复：ACP_CAPABILITIES.discoverHistory 为 true 且保留真实 sessionId', () => {
  assert.equal(ACP_CAPABILITIES.discoverHistory, true);
  const bridgeSrc = readFileSync(
    'apps/desktop/src-tauri/src/acp_bridge.mjs',
    'utf8',
  );
  assert.match(
    bridgeSrc,
    /requestedId\.startsWith\('acp-bridge-'\)\s*\?\s*null\s*:\s*requestedId/,
  );

  const kanbanSrc = readFileSync(
    'apps/web/src/components/WorkKanbanBoard.tsx',
    'utf8',
  );
  assert.match(kanbanSrc, /WorkSessionImport/);

  const portalSrc = readFileSync(
    'apps/web/src/components/WorkCardPortal.tsx',
    'utf8',
  );
  assert.match(portalSrc, /t\('agent\.portal\.moreSessions'/);
  assert.match(portalSrc, /sessions:\s*'agent\.portal\.subtabSessions'/);
  assert.match(portalSrc, /t\('agent\.portal\.unbindSessionBtn'\)/);
  assert.match(zhCN['agent.portal.moreSessions'], /会话/);
  assert.match(zhCN['agent.portal.subtabSessions'], /会话/);
  assert.equal(zhCN['agent.portal.unbindSessionBtn'], '解除绑定');
  assert.ok(enUS['agent.portal.moreSessions'].length > 0);
  assert.ok(enUS['agent.portal.subtabSessions'].length > 0);
  assert.ok(enUS['agent.portal.unbindSessionBtn'].length > 0);
});

test('明确开启近期加入：运行中进 executing、7 天内进 ready，同工作区和标题仍保留独立身份', async () => {
  resetAllLedgerState();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const mockDiscovered: DiscoveredLocalSession[] = [
    {
      provider: 'antigravity',
      preset: 'antigravity',
      nativeSessionId: 'ag-running-1',
      title: '修复看板状态同步',
      preview: '正在修改 WorkKanbanBoard 与 Rust 账本',
      workspaceRoot: 'D:\\Repos\\demo-alpha',
      runtimeStatus: 'running',
      createdAt: now - 3600_000,
      updatedAt: now - 60_000,
      stepCount: 14,
      sourcePath: 'C:/Users/demo/.gemini/antigravity/brain/ag-running-1',
    },
    {
      provider: 'codex',
      preset: 'codex-acp',
      nativeSessionId: 'codex-recent-1',
      title: '补齐自动化测试',
      preview: '检查回归脚本',
      workspaceRoot: 'D:/Repos/demo-beta',
      runtimeStatus: 'idle',
      createdAt: now - 3 * DAY,
      updatedAt: now - 2 * DAY,
      stepCount: 8,
      sourcePath: 'C:/Users/demo/.codex/sessions/codex-recent-1.jsonl',
    },
    {
      provider: 'codex',
      preset: 'codex-acp',
      nativeSessionId: 'codex-recent-dup',
      title: '补齐自动化测试',
      preview: '同工作区同标题续跑',
      workspaceRoot: 'D:\\Repos\\demo-beta\\',
      runtimeStatus: 'idle',
      createdAt: now - 4 * DAY,
      updatedAt: now - 3 * DAY,
      stepCount: 4,
      sourcePath: 'C:/Users/demo/.codex/sessions/codex-recent-dup.jsonl',
    },
    {
      provider: 'claude',
      preset: 'claude-code',
      nativeSessionId: 'claude-archive-1',
      title: '历史性能优化调研',
      preview: '15 天前的归档会话',
      workspaceRoot: 'D:/Repos/demo-gamma',
      runtimeStatus: 'idle',
      createdAt: now - 16 * DAY,
      updatedAt: now - 15 * DAY,
      stepCount: 12,
      sourcePath: 'C:/Users/demo/.claude/projects/gamma/claude-archive-1.jsonl',
    },
  ];

  const restore = setSuperAgentRuntimeDriversForTests({
    isDesktop: () => false,
    discoverLocalSessions: async () => mockDiscovered,
  });

  try {
    const synced = await syncLiveSessionsIntoLedger({ autoPromoteRecent: true });
    assert.equal(synced, 4);

    const state = useWorkLedger.getState();
    assert.equal(state.sessions.length, 4);
    assert.equal(state.cards.length, 3, '同标题和目录不足以证明同一工作，历史 >7 天不加入');

    const agSession = state.sessions.find((s) => s.nativeSessionId === 'ag-running-1')!;
    assert.ok(agSession.todoId);
    assert.equal(agSession.controlMode, 'readonly');
    assert.equal(agSession.controlReason, 'active_external_writer');
    assert.equal(agSession.origin, 'native_desktop');
    const agCard = state.cards.find((c) => c.id === agSession.todoId)!;
    assert.equal(agCard.state.stage, 'in_progress');
    assert.equal(agCard.priority, 3);

    const codex1 = state.sessions.find((s) => s.nativeSessionId === 'codex-recent-1')!;
    const codex2 = state.sessions.find((s) => s.nativeSessionId === 'codex-recent-dup')!;
    assert.ok(codex1.todoId);
    assert.notEqual(codex1.todoId, codex2.todoId, '不同原生会话保持独立，避免误合并');
    assert.equal(codex1.controlMode, 'resumable');
    assert.equal(codex1.origin, 'native_cli');
    const codexCard = state.cards.find((c) => c.id === codex1.todoId)!;
    assert.equal(codexCard.state.stage, 'ready');

    const oldClaude = state.sessions.find((s) => s.nativeSessionId === 'claude-archive-1')!;
    assert.equal(oldClaude.todoId, null, '15 天前的历史会话应保留在未绑卡会话池');
    assert.equal(parseWorkSessionProviderMeta(agSession).label, 'Antigravity');
    assert.equal(parseWorkSessionProviderMeta(codex1).label, 'Codex');
    assert.equal(parseWorkSessionProviderMeta(oldClaude).label, 'Claude Code');
  } finally {
    restore();
  }
});

test('12 张自动上板上限、解绑/删除幂等性及手动转卡操作', async () => {
  resetAllLedgerState();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const mockDiscovered: DiscoveredLocalSession[] = Array.from({ length: 15 }, (_, idx) => ({
    provider: idx % 2 === 0 ? 'codex' : 'antigravity',
    preset: idx % 2 === 0 ? 'codex-acp' : 'antigravity',
    nativeSessionId: `recent-sess-${idx + 1}`,
    title: `近期任务 #${idx + 1}`,
    preview: `摘要 ${idx + 1}`,
    workspaceRoot: `D:/Repos/proj-${idx + 1}`,
    runtimeStatus: idx < 2 ? 'running' : 'idle',
    createdAt: now - (idx + 1) * 3600_000,
    updatedAt: now - idx * 3600_000,
    stepCount: 5,
    sourcePath: null,
  }));

  mockDiscovered.push({
    provider: 'claude',
    preset: 'claude-code',
    nativeSessionId: 'old-claude-manual',
    title: '历史 Claude 会话待手动转卡',
    preview: '历史摘要',
    workspaceRoot: 'D:/Repos/manual-repo',
    runtimeStatus: 'idle',
    createdAt: now - 20 * DAY,
    updatedAt: now - 14 * DAY,
    stepCount: 9,
    sourcePath: null,
  });

  const restore = setSuperAgentRuntimeDriversForTests({
    isDesktop: () => false,
    discoverLocalSessions: async () => mockDiscovered,
  });

  try {
    await syncLiveSessionsIntoLedger({ autoPromoteRecent: true });
    let state = useWorkLedger.getState();

    assert.equal(state.cards.length, 12, '自动上板应封顶 12 张活跃卡片');
    assert.equal(
      state.sessions.filter((s) => s.todoId !== null).length,
      12,
    );
    assert.equal(
      state.sessions.filter((s) => s.todoId === null).length,
      4,
      '超出 12 卡上限的 3 个近期会话 + 1 个历史会话应留在会话池',
    );

    // 运行中会话必须优先抢占前两位
    assert.ok(
      state.sessions.find((s) => s.nativeSessionId === 'recent-sess-1')?.todoId,
    );
    assert.ok(
      state.sessions.find((s) => s.nativeSessionId === 'recent-sess-2')?.todoId,
    );

    // 解除一张卡片绑定 -> 二次同步保持幂等，不再重新上板，也不从溢出池回填
    const toUnbind = state.sessions.find((s) => s.nativeSessionId === 'recent-sess-3')!;
    assert.ok(toUnbind.todoId);
    const unbound = await bindWorkSessionToCard(toUnbind.id, null);
    assert.equal(unbound?.todoId, null);

    await syncLiveSessionsIntoLedger({ autoPromoteRecent: true });
    state = useWorkLedger.getState();
    assert.equal(
      state.sessions.find((s) => s.nativeSessionId === 'recent-sess-3')?.todoId,
      null,
      '已解绑会话在二次同步后必须保持解绑状态',
    );
    assert.equal(
      state.sessions.filter((s) => s.todoId !== null).length,
      11,
      '超出上限的旧池会话不应在解绑后意外自动补位',
    );

    // 手动从会话池转为卡片
    const oldSession = state.sessions.find((s) => s.nativeSessionId === 'old-claude-manual')!;
    const manualCard = await promoteWorkSessionToCard(oldSession.id);
    assert.equal(manualCard.state.stage, 'ready');
    assert.equal(manualCard.priority, 3);

    const rebound = useWorkLedger
      .getState()
      .sessions.find((s) => s.id === oldSession.id)!;
    assert.equal(rebound.todoId, manualCard.id);
  } finally {
    restore();
  }
});
