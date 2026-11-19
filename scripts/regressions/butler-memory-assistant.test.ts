import assert from 'node:assert/strict';
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

const memStorage = installMemoryLocalStorage();

import {
  executeRocketxDynamicTool,
  ROCKETX_DYNAMIC_TOOLS,
} from '../../apps/web/src/agent/codexHostTools';
import {
  generatePersonalAssistantBrief,
  saveAssistantSnapshotDigest,
} from '../../apps/web/src/agent/personalAssistant';
import { useAcpAgents } from '../../apps/web/src/stores/acpAgents';
import {
  formatMemoryRecallPromptBlock,
  useButlerMemory,
  validateMemoryNoSecrets,
} from '../../apps/web/src/stores/butlerMemory';
import { dateKey, useCalendar } from '../../apps/web/src/stores/calendar';
import { useTodos } from '../../apps/web/src/stores/todos';
import { useWorkLedger } from '../../apps/web/src/stores/workLedger';

function resetStoresForTest(scope = 'alice@https://rc.example.com') {
  memStorage.clear();
  useButlerMemory.setState({
    accountScope: scope,
    memories: [],
    digests: [],
    memoryPaused: false,
    hydrated: true,
    loading: false,
    lastError: null,
  });
  useTodos.setState({ todos: [], hydrated: true, loading: false });
  useCalendar.setState({ events: [] });
  useWorkLedger.setState({
    cards: [],
    sessions: [],
    links: [],
    evidences: [],
    dispatchActions: [],
    externalEvents: [],
    hydrated: true,
    loading: false,
    lastError: null,
  });
  useAcpAgents.setState({
    agents: [],
    discovered: [],
    probes: {},
    sessions: {},
    activeSessionKey: null,
    loading: false,
    discovering: false,
    lastError: null,
  });
}

function parseToolResponse(res: {
  success: boolean;
  contentItems: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const raw = res.contentItems[0]?.text ?? '{}';
  return JSON.parse(raw) as Record<string, unknown>;
}

test('useButlerMemory: CRUD、账号作用域隔离、敏感凭据拦截、暂停开关与混合召回排序', async () => {
  resetStoresForTest('alice@https://rc.example.com');
  const store = useButlerMemory.getState();

  // 1. Secret guard checks (sk-, Bearer, ghp_)
  assert.equal(validateMemoryNoSecrets('sk-proj-1234567890abcdef1234').ok, false);
  assert.equal(validateMemoryNoSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9').ok, false);
  assert.equal(validateMemoryNoSecrets('token ghp_abcdefghijklmnopqrstuvwxyz123456').ok, false);
  assert.equal(validateMemoryNoSecrets('使用 pnpm --filter @rcx/web build 进行前端构建').ok, true);

  await assert.rejects(
    () =>
      store.upsertMemory({
        category: 'project_fact',
        title: 'API Key',
        content: 'Do not store sk-proj-1234567890abcdef1234',
        sourceKind: 'manual',
      }),
    /敏感凭据/,
  );
  await assert.rejects(
    () =>
      store.upsertMemory({
        category: 'project_fact',
        title: 'Auth Header',
        content: 'Use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        sourceKind: 'manual',
      }),
    /敏感凭据/,
  );
  await assert.rejects(
    () =>
      store.upsertMemory({
        category: 'project_fact',
        title: 'GitHub PAT',
        content: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
        sourceKind: 'manual',
      }),
    /敏感凭据/,
  );

  // 2. CRUD & togglePin / toggleEnabled
  const m1 = await useButlerMemory.getState().upsertMemory({
    category: 'preference',
    title: '包管理器偏好',
    content: 'RocketX 仓库统一使用 pnpm workspace 命令运行构建与回归测试',
    tags: ['pnpm', 'workflow'],
    workspaceRoot: 'D:/Repos/rocketchatx',
    sourceKind: 'manual',
    pinned: false,
    confidence: 0.7,
  });
  const m2 = await useButlerMemory.getState().upsertMemory({
    category: 'project_fact',
    title: 'Rust 测试入口',
    content: '桌面端核心 Rust 校验运行 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml',
    tags: ['rust', 'cargo'],
    workspaceRoot: 'D:/Repos/rocketchatx',
    sourceKind: 'manual',
    pinned: true,
    confidence: 0.9,
  });
  const mOtherWs = await useButlerMemory.getState().upsertMemory({
    category: 'project_fact',
    title: '其他仓库规范',
    content: '另一个仓库使用 yarn test',
    tags: ['yarn'],
    workspaceRoot: 'D:/Repos/other-project',
    sourceKind: 'manual',
    pinned: true,
    confidence: 0.99,
  });
  const mDisabled = await useButlerMemory.getState().upsertMemory({
    category: 'workflow_habit',
    title: '已停用习惯',
    content: 'pnpm old habit',
    workspaceRoot: 'D:/Repos/rocketchatx',
    sourceKind: 'manual',
    enabled: false,
  });

  assert.equal(useButlerMemory.getState().memories.length, 4);

  // Toggle pin on m1 and verify update
  const m1Pinned = await useButlerMemory.getState().togglePin(m1.id);
  assert.equal(m1Pinned.pinned, true);
  const m1Unpinned = await useButlerMemory.getState().togglePin(m1.id);
  assert.equal(m1Unpinned.pinned, false);

  // Toggle enabled on mDisabled -> enabled -> disabled again
  const reEnabled = await useButlerMemory.getState().toggleEnabled(mDisabled.id);
  assert.equal(reEnabled.enabled, true);
  const reDisabled = await useButlerMemory.getState().toggleEnabled(mDisabled.id);
  assert.equal(reDisabled.enabled, false);

  // 3. Hybrid recall ranking & workspace filtering
  const recalled = await useButlerMemory.getState().recallRelevantMemories({
    query: 'rust cargo',
    workspaceRoot: 'D:/Repos/rocketchatx',
    limit: 5,
  });
  assert.equal(recalled.length, 2);
  assert.equal(recalled[0]?.id, m2.id); // pinned + workspace match + keyword hits
  assert.equal(recalled[1]?.id, m1.id);
  assert.ok(!recalled.some((m) => m.id === mOtherWs.id));
  assert.ok(!recalled.some((m) => m.id === mDisabled.id));
  assert.equal(recalled[0]?.recallCount, 1);
  assert.ok(recalled[0]?.lastRecalledAt != null);

  const block = formatMemoryRecallPromptBlock(recalled);
  assert.ok(block.startsWith('<rocketx_long_term_memory>'));
  assert.ok(block.includes('Rust 测试入口'));
  assert.ok(block.endsWith('</rocketx_long_term_memory>'));
  assert.equal(formatMemoryRecallPromptBlock([]), '');

  // 4. memoryPaused suppression
  useButlerMemory.getState().setMemoryPaused(true);
  const pausedRecall = await useButlerMemory.getState().recallRelevantMemories({
    query: 'rust',
    workspaceRoot: 'D:/Repos/rocketchatx',
  });
  assert.deepEqual(pausedRecall, []);
  useButlerMemory.getState().setMemoryPaused(false);

  // 5. Account scope isolation
  useButlerMemory.getState().setAccountScope('bob@https://rc.example.com');
  assert.equal(useButlerMemory.getState().memories.length, 0);
  const bobMem = await useButlerMemory.getState().upsertMemory({
    category: 'person_context',
    title: 'Bob 专属记忆',
    content: 'Bob 偏好早间同步',
    sourceKind: 'manual',
  });
  assert.equal(useButlerMemory.getState().memories.length, 1);

  useButlerMemory.getState().setAccountScope('alice@https://rc.example.com');
  assert.equal(useButlerMemory.getState().memories.length, 4);
  assert.ok(!useButlerMemory.getState().memories.some((m) => m.id === bobMem.id));

  // Delete & clearScope
  const deleted = await useButlerMemory.getState().deleteMemory(m1.id);
  assert.equal(deleted, true);
  assert.equal(useButlerMemory.getState().memories.length, 3);

  await assert.rejects(useButlerMemory.getState().clearScope('bob@https://rc.example.com'), /跨账号/);
  useButlerMemory.getState().setAccountScope('bob@https://rc.example.com');
  const clearedBob = await useButlerMemory
    .getState()
    .clearScope('bob@https://rc.example.com');
  assert.equal(clearedBob, 1);
  assert.equal(useButlerMemory.getState().memories.length, 0);
  useButlerMemory.getState().setAccountScope('alice@https://rc.example.com');
  assert.equal(useButlerMemory.getState().memories.length, 3);
});

test('generatePersonalAssistantBrief: 聚合待办、日程、工作卡片、ACP 会话与长期记忆并生成三类简报', async () => {
  resetStoresForTest('alice@https://rc.example.com');
  const now = new Date(2026, 10, 13, 9, 30, 0); // 2026-11-13
  const today = dateKey(now);
  const yesterday = dateKey(new Date(2026, 10, 12, 9, 30, 0));

  useTodos.setState({
    todos: [
      {
        id: 't-overdue',
        source: 'manual',
        title: '修复发布阻断项',
        due: yesterday,
        done: false,
        priority: 1,
        committedTo: 'Tech Lead',
        createdAt: now.getTime() - 86_400_000,
      },
      {
        id: 't-today',
        source: 'manual',
        title: '评审 ACP 协议文档',
        due: today,
        done: false,
        priority: 2,
        waitingFor: 'Design Team',
        createdAt: now.getTime() - 3600_000,
      },
      {
        id: 't-done-today',
        source: 'manual',
        title: '合并 Rust 迁移分支',
        done: true,
        doneAt: now.getTime() - 1800_000,
        createdAt: now.getTime() - 7200_000,
      },
    ],
    hydrated: true,
    loading: false,
  });

  useCalendar.setState({
    events: [
      {
        id: 'ev-1',
        title: '架构评审同步会',
        date: today,
        startTime: '10:00',
        endTime: '10:30',
        allDay: false,
        color: '#3370ff',
        source: 'manual',
        doneDates: [today],
        createdAt: now.getTime(),
      },
      {
        id: 'ev-2',
        title: '发布检查清单核对',
        date: today,
        startTime: '16:00',
        endTime: '16:30',
        allDay: false,
        color: '#00b96b',
        source: 'manual',
        createdAt: now.getTime(),
      },
    ],
  });

  useWorkLedger.getState().syncWithTodos();
  await useWorkLedger.getState().updateCard('t-overdue', {
    stage: 'in_progress',
    waitState: 'waiting_approval',
    waitReason: '等待人工审批写入配置',
  });
  await useWorkLedger.getState().updateCard('t-today', {
    stage: 'in_progress',
    waitState: 'blocked',
    waitReason: '等待上游设计稿确认',
  });

  useAcpAgents.setState({
    sessions: {
      'acp:claude:1': {
        sessionKey: 'acp:claude:1',
        agentId: 'claude-1',
        agentName: 'Claude Code',
        preset: 'claude-code',
        acpSessionId: 'sess-1',
        title: '修复发布阻断项会话',
        workspaceRoot: 'D:/Repos/rocketchatx',
        linkedTodoId: 't-overdue',
        autonomyMode: 'confirm',
        status: 'waiting_approval',
        error: null,
        modes: null,
        models: null,
        availableCommands: [],
        plan: [],
        messages: [],
        streamingText: '',
        streamingThought: '',
        toolCalls: [],
        pendingPermissions: [
          {
            requestId: 'perm-1',
            sessionId: 'sess-1',
            toolCall: { toolCallId: 'tc-1', title: 'Edit main.rs', kind: 'edit', status: 'pending' },
            options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
            reason: '需确认写入',
            createdAt: now.getTime(),
          },
        ],
        stderrLogs: [],
        lastStopReason: null,
        turnCount: 1,
        createdAt: now.getTime(),
        updatedAt: now.getTime(),
      },
    },
  });

  await useButlerMemory.getState().upsertMemory({
    category: 'workflow_habit',
    title: '发版前必检',
    content: '发版前需跑完 typecheck 和 cargo test',
    sourceKind: 'manual',
    pinned: true,
  });

  const morning = generatePersonalAssistantBrief('morning_brief', now);
  assert.equal(morning.kind, 'morning_brief');
  assert.equal(morning.dateKey, today);
  assert.equal(morning.metrics.openTodos, 2);
  assert.equal(morning.metrics.overdueTodos, 1);
  assert.equal(morning.metrics.dueTodayTodos, 1);
  assert.equal(morning.metrics.completedTodayTodos, 1);
  assert.equal(morning.metrics.todayEvents, 2);
  assert.equal(morning.metrics.completedTodayEvents, 1);
  assert.equal(morning.metrics.activeWorkflows, 1);
  assert.equal(morning.metrics.waitingApprovalCount, 2); // 1 card + 1 ACP pending permission
  assert.equal(morning.metrics.blockedCount, 1);
  assert.equal(morning.metrics.acpActiveSessions, 1);
  assert.equal(morning.metrics.memoryCount, 1);
  assert.equal(morning.focusItems[0]?.id, 't-overdue');
  assert.equal(morning.commitments.length, 2);
  assert.equal(morning.schedule.length, 2);
  assert.equal(morning.relevantMemories.length, 1);
  assert.ok(morning.markdown.includes('晨间个人简报'));
  assert.ok(morning.markdown.includes('修复发布阻断项'));

  const evening = generatePersonalAssistantBrief('evening_review', now);
  assert.equal(evening.kind, 'evening_review');
  assert.ok(evening.markdown.includes('晚间复盘与收尾'));
  assert.ok(evening.actionItems.some((a) => a.includes('回顾今日已完成 1 项待办与 1 项日程')));

  const focus = generatePersonalAssistantBrief('focus_digest', now);
  assert.equal(focus.kind, 'focus_digest');
  assert.ok(focus.markdown.includes('当前聚焦摘要'));

  // memoryPaused hides relevantMemories in snapshot
  useButlerMemory.getState().setMemoryPaused(true);
  const pausedSnap = generatePersonalAssistantBrief('focus_digest', now);
  assert.deepEqual(pausedSnap.relevantMemories, []);
  useButlerMemory.getState().setMemoryPaused(false);

  // saveAssistantSnapshotDigest persists digest
  const digest = await saveAssistantSnapshotDigest(morning);
  assert.equal(digest.kind, 'morning_brief');
  assert.equal(useButlerMemory.getState().digests.length, 1);
});

test('ROCKETX_DYNAMIC_TOOLS & executeRocketxDynamicTool: memory_* / assistant_daily_brief / workflow_report_generate / acp_list_agents', async () => {
  resetStoresForTest('alice@https://rc.example.com');

  const toolNames = new Set(ROCKETX_DYNAMIC_TOOLS.map((t) => t.name));
  for (const requiredName of [
    'memory_save',
    'memory_search',
    'memory_delete',
    'assistant_daily_brief',
    'workflow_report_generate',
    'acp_list_agents',
  ]) {
    assert.ok(toolNames.has(requiredName), `Missing dynamic tool spec: ${requiredName}`);
  }

  // 1. memory_save (valid + secret rejection)
  const saveRes = await executeRocketxDynamicTool({
    tool: 'memory_save',
    arguments: {
      category: 'project_fact',
      title: '测试命令规范',
      content: '使用 pnpm test:pure 运行纯函数测试',
      tags: ['test', 'pnpm'],
      workspaceRoot: 'D:/Repos/rocketchatx',
      pinned: true,
    },
  });
  assert.equal(saveRes.success, true);
  const savedPayload = parseToolResponse(saveRes);
  assert.ok(typeof savedPayload.id === 'string');

  const badSaveRes = await executeRocketxDynamicTool({
    tool: 'memory_save',
    arguments: {
      category: 'project_fact',
      title: 'Secret',
      content: 'sk-proj-1234567890abcdef1234',
    },
  });
  assert.equal(badSaveRes.success, false);

  // 2. memory_search
  const searchRes = await executeRocketxDynamicTool({
    tool: 'memory_search',
    arguments: { query: 'test:pure', workspaceRoot: 'D:/Repos/rocketchatx' },
  });
  assert.equal(searchRes.success, true);
  const searchPayload = parseToolResponse(searchRes);
  assert.equal(searchPayload.returned, 1);
  assert.equal(
    (searchPayload.items as Array<Record<string, unknown>>)[0]?.id,
    savedPayload.id,
  );

  // 3. memory_delete
  const delRes = await executeRocketxDynamicTool({
    tool: 'memory_delete',
    arguments: { id: savedPayload.id },
  });
  assert.equal(delRes.success, true);
  assert.equal(parseToolResponse(delRes).deleted, true);

  // 4. assistant_daily_brief (with saveDigest: true)
  const briefRes = await executeRocketxDynamicTool({
    tool: 'assistant_daily_brief',
    arguments: { kind: 'morning_brief', saveDigest: true },
  });
  assert.equal(briefRes.success, true);
  const briefPayload = parseToolResponse(briefRes);
  assert.equal(briefPayload.kind, 'morning_brief');
  assert.ok(typeof briefPayload.digestId === 'string');
  assert.ok(typeof briefPayload.markdown === 'string');
  assert.equal(useButlerMemory.getState().digests.length, 1);

  // 5. workflow_report_generate (with recordEvidence + distillMemory)
  useTodos.setState({
    todos: [
      {
        id: 'todo-rpt-1',
        source: 'manual',
        title: '完成 ACP 回归测试',
        done: false,
        priority: 1,
        createdAt: Date.now(),
      },
    ],
    hydrated: true,
    loading: false,
  });
  useWorkLedger.getState().syncWithTodos();
  await useWorkLedger.getState().updateCard('todo-rpt-1', {
    stage: 'verifying',
    goal: '完成 ACP 回归并验证记忆拦截',
    acceptance: ['ACP 握手通过', 'Memory 拦截有效'],
  });

  const rptRes = await executeRocketxDynamicTool({
    tool: 'workflow_report_generate',
    arguments: {
      todoId: 'todo-rpt-1',
      recordEvidence: true,
      distillMemory: true,
    },
  });
  assert.equal(rptRes.success, true);
  const rptPayload = parseToolResponse(rptRes);
  assert.equal(rptPayload.todoId, 'todo-rpt-1');
  assert.equal(rptPayload.status, 'verifying');
  assert.equal(useWorkLedger.getState().evidences.length, 1);
  assert.equal(useButlerMemory.getState().memories.length, 1);
  assert.equal(useButlerMemory.getState().memories[0]?.sourceKind, 'workflow_report');

  // 6. acp_list_agents
  await useAcpAgents.getState().upsertAgent({
    id: 'acp-claude',
    name: 'Claude Code',
    preset: 'claude-code',
    command: 'claude-code-acp',
    args: [],
    enabled: true,
  });
  await useAcpAgents.getState().upsertAgent({
    id: 'acp-disabled',
    name: 'Disabled Agent',
    preset: 'custom',
    command: 'disabled-acp',
    args: [],
    enabled: false,
  });

  const listAllRes = await executeRocketxDynamicTool({
    tool: 'acp_list_agents',
    arguments: { includeDisabled: true },
  });
  assert.equal(listAllRes.success, true);
  assert.equal((parseToolResponse(listAllRes).agents as unknown[]).length, 2);

  const listEnabledRes = await executeRocketxDynamicTool({
    tool: 'acp_list_agents',
    arguments: { includeDisabled: false },
  });
  assert.equal(listEnabledRes.success, true);
  assert.equal((parseToolResponse(listEnabledRes).agents as unknown[]).length, 1);
});
