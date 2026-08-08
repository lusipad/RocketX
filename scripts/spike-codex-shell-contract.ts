import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ThreadItem } from '../apps/web/src/agent/protocol/generated/v2/ThreadItem';
import { AppServerClient } from '../apps/web/src/agent/protocol/client';
import {
  codexInvocation,
  codexRuntimeSourceFromArgs,
  NodeCodexTransport,
  removeSpikeTempRoot,
  type CodexInvocation,
  type SpikeCodexRuntimeSource,
} from './lib/codex-app-server-spike';

const SKILL_NAME = 'contract-probe';
const CHILD_MARKER = 'RCX_SHELL_CHILD_OK';
const PARENT_MARKER = 'RCX_SHELL_PARENT_OK';

interface ContractChecks {
  skillListed: boolean;
  skillDisabled: boolean;
  skillReenabled: boolean;
  ephemeralGoalRejected: boolean;
  persistentGoalLifecycle: boolean;
  automationManagementAbsent: boolean;
  turnSteerExposed: boolean;
  subagentPersisted: boolean;
  subagentParentLinked: boolean;
  subagentResultReturned: boolean;
}

interface RuntimeContractResult {
  runtimeSource: SpikeCodexRuntimeSource;
  runtimePath: string;
  cliVersion: string;
  result: 'PASS' | 'FAIL';
  checks: ContractChecks;
  protocol: {
    methodCount: number;
    automationManagementMethods: string[];
    turnMethods: string[];
  };
  subagent: {
    parentThreadId?: string;
    childThreadId?: string;
    liveActivityExposed: boolean;
  };
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestedRuntimeSources(): SpikeCodexRuntimeSource[] {
  return process.argv.includes('--runtime')
    ? [codexRuntimeSourceFromArgs()]
    : ['pinned', 'system'];
}

function generateProtocol(invocation: CodexInvocation, outputRoot: string): void {
  const generated = spawnSync(
    invocation.command,
    [
      ...invocation.args,
      'app-server',
      'generate-ts',
      '--experimental',
      '--out',
      outputRoot,
    ],
    { encoding: 'utf8' },
  );
  if (generated.status !== 0) {
    throw new Error(
      `无法生成 ${invocation.source} Codex 协议：${generated.stderr.trim() || generated.stdout.trim()}`,
    );
  }
}

async function readProtocolMethods(outputRoot: string): Promise<string[]> {
  const source = await readFile(join(outputRoot, 'ClientRequest.ts'), 'utf8');
  return [...source.matchAll(/"method": "([^"]+)"/g)].map((match) => match[1]!);
}

function automationManagementMethods(methods: readonly string[]): string[] {
  return methods.filter((method) =>
    /^(?:automation|scheduledTask|schedule)\//i.test(method),
  );
}

function turnMethods(methods: readonly string[]): string[] {
  return methods.filter((method) => method.startsWith('turn/'));
}

async function runStaticContract(invocation: CodexInvocation): Promise<{
  checks: Pick<
    ContractChecks,
    | 'skillListed'
    | 'skillDisabled'
    | 'skillReenabled'
    | 'ephemeralGoalRejected'
    | 'persistentGoalLifecycle'
    | 'automationManagementAbsent'
    | 'turnSteerExposed'
  >;
  methodCount: number;
  automationMethods: string[];
  turnMethods: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'rocketx-shell-static-'));
  const workspace = join(root, 'workspace');
  const codexHome = join(root, 'codex-home');
  const protocolRoot = join(root, 'protocol');
  const skillPath = join(
    workspace,
    '.agents',
    'skills',
    SKILL_NAME,
    'SKILL.md',
  );
  await mkdir(dirname(skillPath), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    skillPath,
    [
      '---',
      `name: ${SKILL_NAME}`,
      'description: Verify the native Codex shell contract.',
      '---',
      '',
      '# Contract probe',
      '',
    ].join('\n'),
  );

  const client = new AppServerClient(
    new NodeCodexTransport(workspace, invocation, { codexHome }),
  );
  try {
    await client.start();
    const listed = await client.request('skills/list', {
      cwds: [workspace],
      forceReload: true,
    });
    const initial = listed.data
      .flatMap((entry) => entry.skills)
      .find((skill) => skill.name === SKILL_NAME);

    const disabled = await client.request('skills/config/write', {
      path: skillPath,
      enabled: false,
    });
    const listedDisabled = await client.request('skills/list', {
      cwds: [workspace],
      forceReload: true,
    });
    const disabledSkill = listedDisabled.data
      .flatMap((entry) => entry.skills)
      .find((skill) => skill.name === SKILL_NAME);
    const enabled = await client.request('skills/config/write', {
      path: skillPath,
      enabled: true,
    });

    const ephemeral = await client.request('thread/start', {
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      ephemeral: true,
    });
    let ephemeralGoalRejected = false;
    try {
      await client.request('thread/goal/set', {
        threadId: ephemeral.thread.id,
        objective: 'This must be rejected',
      });
    } catch (error) {
      ephemeralGoalRejected = error instanceof Error
        && /ephemeral thread does not support goals/i.test(error.message);
    }

    const persistent = await client.request('thread/start', {
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
    });
    const setGoal = await client.request('thread/goal/set', {
      threadId: persistent.thread.id,
      objective: 'Verify the native Goal lifecycle',
      tokenBudget: 500,
    });
    const getGoal = await client.request('thread/goal/get', {
      threadId: persistent.thread.id,
    });
    const clearGoal = await client.request('thread/goal/clear', {
      threadId: persistent.thread.id,
    });
    const getCleared = await client.request('thread/goal/get', {
      threadId: persistent.thread.id,
    });

    generateProtocol(invocation, protocolRoot);
    const methods = await readProtocolMethods(protocolRoot);
    const automationMethods = automationManagementMethods(methods);
    const exposedTurnMethods = turnMethods(methods);
    return {
      checks: {
        skillListed: initial?.enabled === true && initial.path === skillPath,
        skillDisabled:
          disabled.effectiveEnabled === false
          && disabledSkill?.enabled === false,
        skillReenabled: enabled.effectiveEnabled === true,
        ephemeralGoalRejected,
        persistentGoalLifecycle:
          setGoal.goal.status === 'active'
          && getGoal.goal?.tokenBudget === 500
          && clearGoal.cleared
          && getCleared.goal === null,
        automationManagementAbsent: automationMethods.length === 0,
        turnSteerExposed: exposedTurnMethods.includes('turn/steer'),
      },
      methodCount: methods.length,
      automationMethods,
      turnMethods: exposedTurnMethods,
    };
  } finally {
    await client.stop().catch(() => undefined);
    await removeSpikeTempRoot(root, 'rocketx-shell-static-');
  }
}

function itemsFromThreadRead(value: unknown): ThreadItem[] {
  if (!isRecord(value) || !isRecord(value.thread) || !Array.isArray(value.thread.turns)) {
    return [];
  }
  return value.thread.turns.flatMap((turn) =>
    isRecord(turn) && Array.isArray(turn.items)
      ? turn.items as ThreadItem[]
      : [],
  );
}

async function runSubagentContract(invocation: CodexInvocation): Promise<{
  checks: Pick<
    ContractChecks,
    'subagentPersisted' | 'subagentParentLinked' | 'subagentResultReturned'
  >;
  parentThreadId?: string;
  childThreadId?: string;
  liveActivityExposed: boolean;
}> {
  const workspace = await mkdtemp(join(tmpdir(), 'rocketx-shell-subagent-'));
  let parentThreadId: string | undefined;
  let childThreadId: string | undefined;
  let liveActivityExposed = false;
  let resolveCompleted: (() => void) | undefined;
  let rejectCompleted: ((error: Error) => void) | undefined;
  const completed = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveCompleted = resolvePromise;
    rejectCompleted = rejectPromise;
  });
  const client = new AppServerClient(
    new NodeCodexTransport(workspace, invocation),
    {
      onNotification: (method, params) => {
        if (
          method === 'item/completed'
          && isRecord(params)
          && isRecord(params.item)
          && params.item.type === 'subAgentActivity'
        ) {
          liveActivityExposed = true;
        }
        if (
          method === 'turn/completed'
          && isRecord(params)
          && params.threadId === parentThreadId
        ) {
          resolveCompleted?.();
        }
      },
      onInterrupted: (error) => rejectCompleted?.(error),
    },
  );
  try {
    await client.start();
    const parent = await client.request('thread/start', {
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      developerInstructions: [
        '这是 RocketX 原生子代理合同测试。',
        `必须先调用 spawn_agent，让子代理只返回 ${CHILD_MARKER}。`,
        `等待子代理结束后，只返回 ${PARENT_MARKER} 和子代理标记。`,
        '不得调用其他工具。',
      ].join('\n'),
    });
    parentThreadId = parent.thread.id;
    await client.request(
      'turn/start',
      {
        threadId: parentThreadId,
        input: [{
          type: 'text',
          text: '执行子代理合同测试。',
          text_elements: [],
        }],
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      },
      30_000,
    );
    let completionTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        completed,
        new Promise<never>((_, reject) => {
          completionTimer = setTimeout(
            () => reject(new Error('子代理合同测试超时')),
            180_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(completionTimer);
    }

    const parentRead = await client.request('thread/read', {
      threadId: parentThreadId,
      includeTurns: true,
    });
    const parentItems = itemsFromThreadRead(parentRead);
    const activity = parentItems.find(
      (item) => item.type === 'subAgentActivity' && item.kind === 'started',
    );
    childThreadId = activity?.type === 'subAgentActivity'
      ? activity.agentThreadId
      : undefined;
    const childRead = childThreadId
      ? await client.request('thread/read', {
        threadId: childThreadId,
        includeTurns: true,
      })
      : undefined;
    const childItems = itemsFromThreadRead(childRead);
    const parentAnswer = parentItems
      .filter((item) => item.type === 'agentMessage')
      .map((item) => item.text)
      .join('\n');
    const childAnswer = childItems
      .filter((item) => item.type === 'agentMessage')
      .map((item) => item.text)
      .join('\n');

    return {
      checks: {
        subagentPersisted: Boolean(childThreadId) && childItems.length > 0,
        subagentParentLinked:
          isRecord(childRead)
          && isRecord(childRead.thread)
          && childRead.thread.parentThreadId === parentThreadId,
        subagentResultReturned:
          childAnswer.includes(CHILD_MARKER)
          && parentAnswer.includes(CHILD_MARKER)
          && parentAnswer.includes(PARENT_MARKER),
      },
      parentThreadId,
      childThreadId,
      liveActivityExposed,
    };
  } finally {
    if (childThreadId) {
      await client.request('thread/archive', { threadId: childThreadId }).catch(() => undefined);
    }
    if (parentThreadId) {
      await client.request('thread/archive', { threadId: parentThreadId }).catch(() => undefined);
    }
    await client.stop().catch(() => undefined);
    await removeSpikeTempRoot(workspace, 'rocketx-shell-subagent-');
  }
}

async function runRuntimeContract(
  source: SpikeCodexRuntimeSource,
): Promise<RuntimeContractResult> {
  const invocation = codexInvocation(source);
  try {
    const staticContract = await runStaticContract(invocation);
    const subagentContract = await runSubagentContract(invocation);
    const checks: ContractChecks = {
      ...staticContract.checks,
      ...subagentContract.checks,
    };
    const passed = Object.values(checks).every(Boolean);
    return {
      runtimeSource: source,
      runtimePath: invocation.displayPath,
      cliVersion: invocation.version,
      result: passed ? 'PASS' : 'FAIL',
      checks,
      protocol: {
        methodCount: staticContract.methodCount,
        automationManagementMethods: staticContract.automationMethods,
        turnMethods: staticContract.turnMethods,
      },
      subagent: {
        parentThreadId: subagentContract.parentThreadId,
        childThreadId: subagentContract.childThreadId,
        liveActivityExposed: subagentContract.liveActivityExposed,
      },
    };
  } catch (error) {
    return {
      runtimeSource: source,
      runtimePath: invocation.displayPath,
      cliVersion: invocation.version,
      result: 'FAIL',
      checks: {
        skillListed: false,
        skillDisabled: false,
        skillReenabled: false,
        ephemeralGoalRejected: false,
        persistentGoalLifecycle: false,
        automationManagementAbsent: false,
        turnSteerExposed: false,
        subagentPersisted: false,
        subagentParentLinked: false,
        subagentResultReturned: false,
      },
      protocol: {
        methodCount: 0,
        automationManagementMethods: [],
        turnMethods: [],
      },
      subagent: {
        liveActivityExposed: false,
      },
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  const results: RuntimeContractResult[] = [];
  for (const source of requestedRuntimeSources()) {
    results.push(await runRuntimeContract(source));
  }

  const passed = results.every((result) => result.result === 'PASS');
  console.log(JSON.stringify({
    spike: 'codex-shell-contract',
    result: passed ? 'PASS' : 'FAIL',
    runtimes: results,
  }, null, 2));
  process.exitCode = passed ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
