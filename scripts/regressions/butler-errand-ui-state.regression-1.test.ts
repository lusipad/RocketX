import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { useAgentEnvironments } from '../../apps/web/src/stores/agentEnvironments';
import { useButler } from '../../apps/web/src/stores/butler';
import { useButlerErrandRuns } from '../../apps/web/src/stores/butlerErrandRuns';

// Regression: ISSUE-QA-001 — 离开对话再返回时“只调查”会恢复为未勾选
// Found by /qa on 2026-08-07
// Report: .gstack/qa-reports/qa-report-rocketx-workspace-2026-08-07.md
test('派活草案的只读选择由草案状态持有，组件重新挂载后仍保留', () => {
  const previousDraft = useButler.getState().errandDraft;
  useButler.setState({
    errandDraft: {
      checkpointId: 'draft-read-only',
      spec: {
        title: '工作区只读冒烟',
        goal: '只读取 README 第一行',
        acceptance: ['返回第一行'],
        boundaries: ['禁止修改文件'],
        evidence: [],
      },
      readOnly: false,
    } as never,
  });

  try {
    const setter = (useButler.getState() as unknown as {
      setErrandDraftReadOnly?: (readOnly: boolean) => void;
    }).setErrandDraftReadOnly;
    assert.equal(typeof setter, 'function');
    setter?.(true);
    assert.equal(
      (useButler.getState().errandDraft as { readOnly?: boolean } | null)?.readOnly,
      true,
    );

    const source = readFileSync('apps/web/src/components/ButlerErrandCard.tsx', 'utf8');
    assert.match(source, /errandDraft\?\.readOnly/);
    assert.doesNotMatch(source, /const \[readOnly, setReadOnly\] = useState\(false\)/);
  } finally {
    useButler.setState({ errandDraft: previousDraft });
  }
});

// Regression: ISSUE-QA-002 — 失败任务被标成“回话了”，用户无法分辨成功与失败
// Found by /qa on 2026-08-07
// Report: .gstack/qa-reports/qa-report-rocketx-workspace-2026-08-07.md
test('失败任务显示没办成，同时保留收下归档入口', () => {
  const source = readFileSync('apps/web/src/components/ButlerErrandRunCard.tsx', 'utf8');
  assert.match(source, /const failed = errand\.status === 'failed'/);
  assert.match(source, /failed[^\n]+没办成/);
  assert.doesNotMatch(
    source,
    /const replied = errand\.status === 'replied' \|\| errand\.status === 'failed'/,
  );
  assert.match(source, /aria-label=\{`收下\$\{errand\.title\}`\}/);
});

// Regression: ISSUE-QA-003 — 达到上限时只提示“收下”，但暂停任务需要继续或叫停
// Found by /qa on 2026-08-07
// Report: .gstack/qa-reports/qa-report-rocketx-workspace-2026-08-07.md
test('派活达到五件时给出覆盖暂停与终态任务的可执行指引', async () => {
  const previousEnvironments = useAgentEnvironments.getState().environments;
  const previousRuns = useButlerErrandRuns.getState().runs;
  const previousVisibleRuns = useButlerErrandRuns.getState().visibleRuns;
  const environment = {
    id: 'environment-limit-guidance',
    name: 'rocketchatx',
    path: 'D:/Repos/rocketchatx',
    adoProjects: [],
    defaultBaseBranch: 'main',
    branchPrefix: '',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const pausedRuns = Array.from({ length: 5 }, (_, index) => ({
    id: `paused-${index}`,
    title: `暂停任务 ${index + 1}`,
    threadId: `thread-${index}`,
    workspaceRoot: environment.path,
    workspaceName: environment.name,
    readOnly: true,
    startedAt: index + 1,
    status: 'paused' as const,
    approvals: [],
    traces: [],
  }));

  useAgentEnvironments.setState({ environments: [environment] });
  useButlerErrandRuns.setState({ runs: pausedRuns, visibleRuns: pausedRuns });

  try {
    await assert.rejects(
      () => useButlerErrandRuns.getState().dispatchErrand(
        { title: '第六件', goal: '', acceptance: [], boundaries: [], evidence: [] },
        { id: environment.id, name: environment.name, path: environment.path },
      ),
      /收几件再派；暂停中的先继续或叫停/,
    );
  } finally {
    useAgentEnvironments.setState({ environments: previousEnvironments });
    useButlerErrandRuns.setState({ runs: previousRuns, visibleRuns: previousVisibleRuns });
  }
});
