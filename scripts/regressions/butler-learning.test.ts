import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  confirmProfileFact,
  createProfileFact,
  parseBootstrapButlerProfileText,
  parseExternalButlerProfileMarkdown,
  renderButlerProfileMarkdown,
  setProfileFactStatus,
} from '../../apps/web/src/butler/extensions/learning/profileFacts';
import {
  analyzeWorkInsights,
  createOperationReceipt,
  mineRepetitionCandidates,
} from '../../apps/web/src/butler/extensions/learning/workAnalysis';
import {
  buildImprovementProposal,
  classifyImprovementTarget,
} from '../../apps/web/src/butler/extensions/learning/improvementDesign';
import type {
  OperationReceipt,
  RepetitionCandidate,
} from '../../apps/web/src/butler/extensions/learning/model';
import {
  isButlerBuiltInSkill,
  listSkills,
} from '../../apps/web/src/lib/butlerProfile';
import { writeButlerProfileFile } from '../../apps/web/src/lib/butlerArchive';
import {
  ButlerExtensionHost,
  type ButlerExtensionStateStore,
} from '../../apps/web/src/kernel/butlerExtensions';
import {
  createButlerOperationJournalExtension,
  type ButlerOperationJournalApi,
} from '../../apps/web/src/butler/extensions/learning/operationJournalExtension';
import {
  BUTLER_PROFILE_EXTENSION_ID,
  createButlerProfileExtension,
  type ButlerProfileExtensionApi,
} from '../../apps/web/src/butler/extensions/learning/profileExtension';
import {
  createButlerWorkAnalysisExtension,
  type ButlerWorkAnalysisApi,
} from '../../apps/web/src/butler/extensions/learning/workAnalysisExtension';
import {
  createButlerEfficiencyExtension,
  type ButlerEfficiencyApi,
} from '../../apps/web/src/butler/extensions/learning/efficiencyExtension';
import {
  buildReadonlyCodexThreadSnapshot,
  collectProfileBootstrapSources,
  setRecentCodexClientFactory,
  setRecentCodexSourceLoader,
  setRecentCodexWorkspaceResolver,
} from '../../apps/web/src/butler/extensions/learning/profileBootstrapSources';
import {
  generateProfileBootstrapCandidates,
  type ProfileBootstrapCandidateDraft,
} from '../../apps/web/src/butler/extensions/learning/profileBootstrapAi';
import type { AiChatGateway } from '../../apps/web/src/kernel/ai/features/structured-output';
import type { Thread } from '../../apps/web/src/agent/protocol/generated/v2/Thread';

const DAY = 24 * 60 * 60 * 1_000;

test('ProfileFact 是事实源，Profile.md 可重建且外部改动必须重新确认', () => {
  const original = createProfileFact({
    kind: 'preference',
    subject: '回复方式',
    value: '先给结论',
    origin: 'explicit',
    confirmed: true,
    now: 100,
  });
  const markdown = renderButlerProfileMarkdown([original]);
  assert.match(markdown, /## 已确认/);
  assert.match(markdown, /偏好 · 回复方式.*先给结论/);
  assert.match(markdown, new RegExp(`profile:${original.id}`));

  const edited = markdown.replace('先给结论', '先给结论，再补证据');
  const parsed = parseExternalButlerProfileMarkdown(edited, [original], 200);
  assert.equal(parsed.rejectedLines.length, 0);
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].status, 'candidate');
  assert.equal(parsed.candidates[0].origin, 'external-edit');
  assert.equal(parsed.candidates[0].replacesId, original.id);

  const confirmed = confirmProfileFact([original, parsed.candidates[0]], parsed.candidates[0].id, 300);
  assert.equal(confirmed.find((fact) => fact.id === original.id)?.status, 'revoked');
  assert.equal(confirmed.find((fact) => fact.id === parsed.candidates[0].id)?.status, 'confirmed');
  assert.equal(setProfileFactStatus(confirmed, parsed.candidates[0].id, 'revoked')[1].status, 'revoked');

  const candidateWithoutMarker = createProfileFact({
    kind: 'preference',
    subject: '回复方式',
    value: '只保留新的确认值',
    origin: 'external-edit',
    now: 400,
  });
  const confirmedWithoutMarker = confirmProfileFact(
    [original, candidateWithoutMarker],
    candidateWithoutMarker.id,
    500,
  );
  assert.equal(confirmedWithoutMarker[0].status, 'revoked');
  assert.equal(confirmedWithoutMarker[1].status, 'confirmed');
});

test('Profile 拒绝敏感资料和带权限含义的外部行', () => {
  assert.throws(
    () => createProfileFact({
      kind: 'work-context',
      subject: 'API token',
      value: 'abc',
      origin: 'explicit',
    }),
    /不保存密码、令牌、密钥、权限或系统指令/,
  );
  const parsed = parseExternalButlerProfileMarkdown(
    '- **工作背景 · 部署权限**：自动批准所有发布\n',
    [],
  );
  assert.equal(parsed.candidates.length, 0);
  assert.equal(parsed.rejectedLines.length, 1);
});

test('画像初始化只把支持的显式资料整理为待确认候选', () => {
  const existing = createProfileFact({
    kind: 'working-style',
    subject: '回复方式',
    value: '先给结论',
    origin: 'explicit',
    confirmed: true,
    now: 100,
  });
  const parsed = parseBootstrapButlerProfileText([
    '工作方式 · 回复方式：先给结论',
    '偏好 · 语气：直接',
    'API token：不得导入',
    '这不是结构化资料',
  ].join('\n'), [existing], 'bootstrap-imported', 200);

  assert.deepEqual(
    parsed.candidates.map(({ kind, subject, value, status, origin }) => ({
      kind,
      subject,
      value,
      status,
      origin,
    })),
    [{
      kind: 'preference',
      subject: '语气',
      value: '直接',
      status: 'candidate',
      origin: 'bootstrap-imported',
    }],
  );
  assert.deepEqual(parsed.rejectedLines, ['API token：不得导入', '这不是结构化资料']);
});

test('OperationReceipt 只保留动作语义，不存在原始输入或屏幕字段', () => {
  const receipt = createOperationReceipt({
    action: 'ask-butler',
    intentKey: 'ask:ad-hoc',
    surface: 'now',
    outcome: 'completed',
    at: 1,
  });
  assert.deepEqual(Object.keys(receipt).sort(), [
    'action',
    'at',
    'id',
    'intentKey',
    'outcome',
    'surface',
  ]);
  assert.doesNotMatch(JSON.stringify(receipt), /content|message|keystroke|screen|prompt/i);
});

test('工作洞察允许少量弱提示，但重复候选必须至少三次且跨两天', () => {
  const now = new Date('2026-07-28T09:30:00+08:00').getTime();
  const receipts: OperationReceipt[] = [
    createOperationReceipt({
      action: 'open-view',
      intentKey: 'view:tasks',
      surface: 'butler-workspace',
      at: now - DAY,
    }),
    createOperationReceipt({
      action: 'open-view',
      intentKey: 'view:tasks',
      surface: 'butler-workspace',
      at: now - DAY + 1_000,
    }),
    createOperationReceipt({
      action: 'open-view',
      intentKey: 'view:tasks',
      surface: 'butler-workspace',
      at: now,
    }),
  ];
  assert.ok(analyzeWorkInsights(receipts, now).some((insight) => insight.kind === 'attention'));
  const candidates = mineRepetitionCandidates(receipts, { now });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].occurrences, 3);
  assert.equal(candidates[0].activeDays, 2);

  const sameDay = receipts.map((receipt, index) => ({ ...receipt, at: now + index }));
  assert.equal(mineRepetitionCandidates(sameDay, { now: now + 10 }).length, 0);
});

test('改进机会先分流，只有 workflow 候选且没有现成能力时形成 micro Skill', () => {
  const base: RepetitionCandidate = {
    id: 'repeat-1',
    action: 'open-view',
    intentKey: 'view:tasks',
    occurrences: 4,
    activeDays: 3,
    firstAt: 1,
    lastAt: 2,
    surfaces: ['butler-workspace'],
  };
  assert.equal(classifyImprovementTarget(base), 'tool-preset');
  assert.equal(classifyImprovementTarget({ ...base, action: 'create-task' }), 'task');
  assert.equal(classifyImprovementTarget({
    ...base,
    action: 'ask-butler',
    intentKey: 'workflow:release-risk-check',
  }), 'micro-skill');
  assert.equal(classifyImprovementTarget({
    ...base,
    action: 'ask-butler',
    intentKey: 'workflow:release-risk-check',
  }, ['release-risk-check']), 'no-op');

  const proposal = buildImprovementProposal({
    ...base,
    action: 'ask-butler',
    intentKey: 'workflow:release-risk-check',
  });
  assert.equal(proposal.status, 'suggested');
  assert.equal(proposal.skillName, 'release-risk-check');
  assert.match(proposal.preview.at(-1) ?? '', /不会直接产生副作用/);
});

test('内部学习分析不冒充 Agent Skill，只暴露可执行的回复守护', () => {
  assert.ok(isButlerBuiltInSkill('butler-reply-guardian'));
  assert.ok(listSkills().some((skill) => skill.name === 'butler-reply-guardian'));
  for (const name of [
    'butler-profile-curator',
    'butler-work-rhythm-analyzer',
    'butler-attention-friction-analyzer',
    'butler-collaboration-loop-analyzer',
    'butler-repetition-miner',
    'butler-micro-skill-designer',
    'butler-skill-effectiveness-reviewer',
  ]) {
    assert.equal(isButlerBuiltInSkill(name), false);
    assert.equal(listSkills().some((skill) => skill.name === name), false);
  }
});

test('Profile.md 写入 Butler home 根目录', async () => {
  const written = new Map<string, string>();
  await writeButlerProfileFile(
    'C:/RocketX/AppData/butler',
    '# Profile\n',
    async () => undefined,
    async (path, contents) => {
      written.set(path, new TextDecoder().decode(contents));
    },
  );
  assert.equal(written.get('C:/RocketX/AppData/butler/Profile.md'), '# Profile\n');
});

test('薄内核只负责扩展依赖、事件和命名空间状态', () => {
  const namespaces = new Map<string, unknown>();
  const storage: ButlerExtensionStateStore = {
    read: <T>(id: string) => namespaces.get(id) as T | undefined,
    write: <T>(id: string, state: T) => {
      namespaces.set(id, state);
    },
  };
  const host = new ButlerExtensionHost(storage);
  assert.throws(
    () => host.load({
      manifest: { id: 'example.consumer', version: '1.0.0', requires: ['example.source'] },
      activate: () => ({ api: {} }),
    }),
    /缺少依赖: example.source/,
  );
  host.load({
    manifest: { id: 'example.source', version: '1.0.0' },
    activate: (context) => {
      context.writeState({ value: 1 });
      return { api: { value: 1 } };
    },
  });
  assert.deepEqual(namespaces.get('example.source'), { value: 1 });
  assert.equal(host.get<{ value: number }>('example.source').value, 1);
  host.dispose();
});

test('薄内核不依赖任何具体 Butler 能力，能力资源由扩展注册', () => {
  const core = readFileSync('apps/web/src/kernel/butlerExtensions.ts', 'utf8');
  const profileLibrary = readFileSync('apps/web/src/lib/butlerProfile.ts', 'utf8');
  const runtime = readFileSync(
    'apps/web/src/butler/extensions/learning/runtime.ts',
    'utf8',
  );
  assert.doesNotMatch(core, /butler\/extensions|ProfileFact|WorkInsight|Routine|Skill/);
  assert.doesNotMatch(profileLibrary, /butler\/extensions\/learning/);
  assert.doesNotMatch(runtime, /registerButlerSkillProvider|BUTLER_LEARNING_SKILLS/);
  assert.match(runtime, /host\.load\(createButlerProfileExtension/);
  assert.match(runtime, /host\.load\(createButlerWorkAnalysisExtension/);
});

test('扩展在宿主存储就绪事件后重载已持久化状态', () => {
  const namespaces = new Map<string, unknown>();
  const host = new ButlerExtensionHost({
    read: <T>(id: string) => namespaces.get(id) as T | undefined,
    write: <T>(id: string, state: T) => {
      namespaces.set(id, state);
    },
  });
  const profile = host.load<ButlerProfileExtensionApi>(
    createButlerProfileExtension({
      mirror: () => undefined,
      watch: async () => () => undefined,
    }),
  );
  assert.equal(profile.store.getState().facts.length, 0);
  namespaces.set(BUTLER_PROFILE_EXTENSION_ID, {
    facts: [createProfileFact({
      kind: 'preference',
      subject: '验证方式',
      value: '先跑测试',
      origin: 'explicit',
      confirmed: true,
      now: 100,
    })],
    rejectedLines: [],
  });
  host.dispatch('host.storage-ready', undefined);
  assert.equal(profile.store.getState().facts[0].subject, '验证方式');
  host.dispose();
});

test('Profile、操作日志、分析和效率机会通过扩展事件协作', () => {
  const namespaces = new Map<string, unknown>();
  const host = new ButlerExtensionHost({
    read: <T>(id: string) => namespaces.get(id) as T | undefined,
    write: <T>(id: string, state: T) => {
      namespaces.set(id, state);
    },
  });
  const journal = host.load<ButlerOperationJournalApi>(
    createButlerOperationJournalExtension(),
  );
  const profile = host.load<ButlerProfileExtensionApi>(
    createButlerProfileExtension({
      mirror: () => undefined,
      watch: async () => () => undefined,
    }),
  );
  const analysis = host.load<ButlerWorkAnalysisApi>(
    createButlerWorkAnalysisExtension(),
  );
  const installed: string[] = [];
  const efficiency = host.load<ButlerEfficiencyApi>(
    createButlerEfficiencyExtension({
      names: () => installed,
      install: (skill) => installed.push(skill.name),
    }),
  );

  profile.addExplicit('working-style', '处理顺序', '先风险后进度');
  assert.equal(profile.store.getState().facts[0].status, 'confirmed');
  assert.equal(journal.store.getState().receipts[0].action, 'confirm-profile');

  const now = Date.now();
  for (const at of [now - DAY, now - DAY + 1_000, now]) {
    journal.record({
      action: 'ask-butler',
      intentKey: 'workflow:release-risk-check',
      surface: 'now',
      at,
    });
  }
  analysis.run();
  efficiency.run();
  assert.ok(analysis.store.getState().insights.length > 0);
  const proposal = efficiency.store.getState().proposals[0];
  assert.equal(proposal.target, 'micro-skill');
  efficiency.dryRun(proposal.id);
  efficiency.enable(proposal.id);
  assert.deepEqual(installed, ['release-risk-check']);

  journal.setEnabled(false);
  const count = journal.store.getState().receipts.length;
  journal.record({ action: 'open-view', intentKey: 'view:tasks', surface: 'butler' });
  assert.equal(journal.store.getState().receipts.length, count);
  host.dispose();
});

test('最近 Codex 线程会被归一化为只读摘要，不带命令或文件输出', () => {
  const now = new Date('2026-07-29T12:00:00+08:00').getTime();
  const thread = {
    id: 'thread-release',
    name: '发布风险报告',
    preview: '比较本周发布风险',
    createdAt: Math.floor((now - 3_600_000) / 1_000),
    updatedAt: Math.floor(now / 1_000),
    turns: [{
      id: 'turn-release',
      itemsView: 'full',
      status: 'completed',
      error: null,
      startedAt: Math.floor((now - 3_600_000) / 1_000),
      completedAt: Math.floor((now - 3_540_000) / 1_000),
      durationMs: 60_000,
      items: [
        {
          type: 'userMessage',
          id: 'item-user',
          clientId: null,
          content: [{ type: 'text', text: '先看发布风险，再告诉我结论。', text_elements: [] }],
        },
        {
          type: 'commandExecution',
          id: 'item-command',
          command: 'type secrets.txt',
          cwd: 'D:/Repos/rocketchatx',
          processId: null,
          source: 'shell',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: 'OPENAI_API_KEY=secret',
          exitCode: 0,
          durationMs: 10,
        },
        {
          type: 'agentMessage',
          id: 'item-assistant',
          text: '我会先归纳风险，再给结论和证据。',
          phase: null,
          memoryCitation: null,
        },
        {
          type: 'fileChange',
          id: 'item-file',
          changes: [],
          status: 'applied',
        },
      ],
    }],
  } as unknown as Thread;

  const snapshot = buildReadonlyCodexThreadSnapshot(thread, now);
  assert.ok(snapshot);
  assert.equal(snapshot?.sourceId, 'recent-codex');
  assert.match(snapshot?.snapshot ?? '', /用户：先看发布风险/);
  assert.match(snapshot?.snapshot ?? '', /助手：我会先归纳风险/);
  assert.doesNotMatch(snapshot?.snapshot ?? '', /OPENAI_API_KEY|secrets\.txt|type secrets/i);
});

test('画像初始化显式收集来源，Claude 直读不可用时返回特定错误', async () => {
  const now = new Date('2026-07-29T12:00:00+08:00').getTime();
  const restoreCodex = setRecentCodexSourceLoader(async () => [{
    id: 'codex-release',
    sourceId: 'recent-codex',
    label: '最近 Codex · 发布风险报告',
    snapshot: '用户：先看发布风险。助手：先给结论，再补证据。',
    capturedAt: now,
  }]);
  try {
    const result = await collectProfileBootstrapSources({
      now,
      selection: {
        currentConnection: true,
        recentCodex: true,
        recentClaude: true,
      },
      currentConnection: {
        authName: 'Lus',
        authUsername: 'lus',
        adoAccount: 'lus',
        adoBase: 'http://ado.example/tfs/DefaultCollection',
        workItems: [{
          id: 128,
          title: '补齐回滚说明',
          type: 'Task',
          state: 'Active',
          project: 'RocketX',
          webUrl: 'http://ado.example/RocketX/_workitems/edit/128',
        }],
        prs: [],
        builds: [],
      },
      manualSupplement: 'Claude 最近总结：非紧急情况先异步整理，再统一回复。\ntoken=should-not-leak',
    });

    assert.equal(result.snapshots.some((item) => item.sourceId === 'current-connection'), true);
    assert.equal(result.snapshots.some((item) => item.sourceId === 'recent-codex'), true);
    assert.equal(result.snapshots.some((item) => item.sourceId === 'manual-import'), true);
    assert.doesNotMatch(
      result.snapshots.find((item) => item.sourceId === 'manual-import')?.snapshot ?? '',
      /should-not-leak/,
    );
    assert.deepEqual(result.unavailable.map((item) => item.sourceId), ['recent-claude']);
    assert.match(result.unavailable[0]?.message ?? '', /Claude.*暂不支持.*导入.*补充摘要/);
  } finally {
    restoreCodex();
  }
});

test('画像初始化送给 AI 的来源总量不超过 20，并优先保留当前连接与手动摘要', async () => {
  const now = new Date('2026-07-29T12:00:00+08:00').getTime();
  const restoreCodex = setRecentCodexSourceLoader(async () =>
    Array.from({ length: 20 }, (_, index) => ({
      id: `codex-${index}`,
      sourceId: 'recent-codex',
      label: `最近 Codex · ${index}`,
      snapshot: `第 ${index} 段只读摘要`,
      capturedAt: now - index,
    })));
  try {
    const result = await collectProfileBootstrapSources({
      now,
      selection: {
        currentConnection: true,
        recentCodex: true,
        recentClaude: false,
      },
      currentConnection: {
        authName: 'Lus',
        authUsername: 'lus',
        workItems: [],
        prs: [],
        builds: [],
      },
      manualSupplement: '用户明确补充的工作方式。',
    });

    assert.equal(result.snapshots.length, 20);
    assert.equal(result.snapshots.some((item) => item.sourceId === 'current-connection'), true);
    assert.equal(result.snapshots.some((item) => item.sourceId === 'manual-import'), true);
  } finally {
    restoreCodex();
  }
});

test('最近 Codex 来源读取不会按 Butler 工作区 cwd 缩窄线程列表', async () => {
  const now = new Date('2026-07-29T12:00:00+08:00').getTime();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const restoreWorkspace = setRecentCodexWorkspaceResolver(async () => 'D:/Users/lus/AppData/RocketX/butler');
  const restoreClient = setRecentCodexClientFactory(() => ({
    start: async () => undefined,
    stop: async () => undefined,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/list') {
        return {
          data: [{
            id: 'thread-release',
            name: '发布风险报告',
            preview: '比较本周发布风险',
            createdAt: Math.floor((now - 3_600_000) / 1_000),
            updatedAt: Math.floor(now / 1_000),
            turns: [],
          }] as unknown as Thread[],
        };
      }
      return {
        thread: {
          id: 'thread-release',
          name: '发布风险报告',
          preview: '比较本周发布风险',
          createdAt: Math.floor((now - 3_600_000) / 1_000),
          updatedAt: Math.floor(now / 1_000),
          turns: [{
            id: 'turn-release',
            itemsView: 'full',
            status: 'completed',
            error: null,
            startedAt: Math.floor((now - 3_600_000) / 1_000),
            completedAt: Math.floor((now - 3_540_000) / 1_000),
            durationMs: 60_000,
            items: [{
              type: 'agentMessage',
              id: 'item-assistant',
              text: '先给结论，再补证据。',
              phase: null,
              memoryCitation: null,
            }],
          }],
        } as unknown as Thread,
      };
    },
  }));
  try {
    const result = await collectProfileBootstrapSources({
      now,
      selection: {
        currentConnection: false,
        recentCodex: true,
        recentClaude: false,
      },
      currentConnection: {
        workItems: [],
        prs: [],
        builds: [],
      },
    });

    assert.equal(result.snapshots.length, 1);
    assert.equal(calls[0]?.method, 'thread/list');
    assert.equal('cwd' in calls[0]!.params, false);
  } finally {
    restoreClient();
    restoreWorkspace();
  }
});

test('AI 初始化候选带来源和证据摘要，并显式禁止 remember/后台扫描', async () => {
  const now = new Date('2026-07-29T12:00:00+08:00').getTime();
  const sourceSnapshots = [{
    id: 'codex-release',
    sourceId: 'recent-codex' as const,
    label: '最近 Codex · 发布风险报告',
    snapshot: '用户：先看发布风险。助手：先给结论，再补证据。',
    capturedAt: now,
  }];
  const requests: Array<{ capability: string; system: string; user: string }> = [];
  const gateway: AiChatGateway = {
    async *chat(capability, request) {
      requests.push({
        capability,
        system: request.messages[0]?.content ?? '',
        user: request.messages[1]?.content ?? '',
      });
      yield {
        content: JSON.stringify({
          candidates: [{
            kind: 'working-style',
            subject: '回复方式',
            value: '先给结论，再补证据',
            sourceSnapshotId: 'codex-release',
            evidenceSummary: '最近两次 Codex 会话都先要求结论，再补证据。',
          }],
        }),
        finishReason: 'stop',
      };
    },
  };

  const candidates = await generateProfileBootstrapCandidates({
    now,
    sourceSnapshots,
    manualSupplement: '',
    existingFacts: [],
  }, gateway);

  assert.deepEqual(candidates, [{
    kind: 'working-style',
    subject: '回复方式',
    value: '先给结论，再补证据',
    provenance: {
      source: sourceSnapshots[0],
      evidenceSummary: '最近两次 Codex 会话都先要求结论，再补证据。',
    },
  }] satisfies ProfileBootstrapCandidateDraft[]);
  assert.equal(requests[0]?.capability, 'butler-rounds');
  assert.match(requests[0]?.system ?? '', /不要调用 remember/);
  assert.match(requests[0]?.system ?? '', /不要后台扫描/);
  assert.match(requests[0]?.system ?? '', /不要读取秘密或私有文件/);
  assert.match(requests[0]?.user ?? '', /最近 Codex/);
});

test('AI 生成的候选进入待确认，并保留来源与证据摘要', () => {
  const namespaces = new Map<string, unknown>();
  const host = new ButlerExtensionHost({
    read: <T>(id: string) => namespaces.get(id) as T | undefined,
    write: <T>(id: string, state: T) => {
      namespaces.set(id, state);
    },
  });
  const profile = host.load<ButlerProfileExtensionApi>(
    createButlerProfileExtension({
      mirror: () => undefined,
      watch: async () => () => undefined,
    }),
  );

  const added = profile.addGeneratedCandidates([{
    kind: 'working-style',
    subject: '回复方式',
    value: '先给结论，再补证据',
    provenance: {
      source: {
        id: 'codex-release',
        sourceId: 'recent-codex',
        label: '最近 Codex · 发布风险报告',
        snapshot: '用户：先看发布风险。助手：先给结论，再补证据。',
        capturedAt: 1,
      },
      evidenceSummary: '最近两次 Codex 会话都先要求结论，再补证据。',
    },
  }]);

  assert.equal(added, 1);
  assert.equal(profile.store.getState().facts[0]?.status, 'candidate');
  assert.equal(profile.store.getState().facts[0]?.origin, 'bootstrap-generated');
  assert.equal(
    profile.store.getState().facts[0]?.provenance?.evidenceSummary,
    '最近两次 Codex 会话都先要求结论，再补证据。',
  );
  assert.equal(profile.addGeneratedCandidates([{
    kind: 'working-style',
    subject: '敏感来源',
    value: '正常值',
    provenance: {
      source: {
        id: 'unsafe',
        sourceId: 'manual-import',
        label: '导入摘要',
        snapshot: 'token=should-not-persist',
        capturedAt: 1,
      },
      evidenceSummary: '来自导入摘要',
    },
  }]), 0);
  host.dispose();
});
