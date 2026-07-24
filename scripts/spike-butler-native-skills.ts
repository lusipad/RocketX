import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setButlerBrainStorage,
  setButlerBrainTauriProvider,
  setCodexBrainUnavailableReason,
} from '../apps/web/src/lib/butlerBrain';
import { writeButlerWorkspaceFiles } from '../apps/web/src/lib/butlerArchive';
import {
  runButlerCodexEphemeral,
  setButlerCodexTransportFactory,
  setButlerCodexWorkspaceResolver,
} from '../apps/web/src/stores/butlerCodex';
import {
  codexInvocation,
  NodeCodexTransport,
  turnInputs,
} from './lib/codex-app-server-spike';

const AGENTS_MARKER = 'RCX_AGENTS_E2E_7C41';
const SKILL_MARKER = 'RCX_SKILL_E2E_9B27';
const SKILL_NAME = 'effect-probe';

class MemoryStorage {
  private readonly values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'rocketx-butler-native-skill-'));
  const invocation = codexInvocation();
  const transports: NodeCodexTransport[] = [];
  const restoreStorage = setButlerBrainStorage(new MemoryStorage());
  const restorePlatform = setButlerBrainTauriProvider(() => true);
  const restoreWorkspace = setButlerCodexWorkspaceResolver(async () => workspaceRoot);
  const restoreTransport = setButlerCodexTransportFactory((_sessionId, root) => {
    const transport = new NodeCodexTransport(root, invocation);
    transports.push(transport);
    return transport;
  });
  setCodexBrainUnavailableReason(undefined);

  try {
    await writeButlerWorkspaceFiles(
      workspaceRoot,
      [
        '你正在执行 RocketX 原生 Skill 真实效果测试。',
        `最终回答必须包含唯一标记 ${AGENTS_MARKER}。`,
      ].join('\n'),
      [{
        name: SKILL_NAME,
        description: '验证显式原生 Skill 加载。仅在用户显式调用时使用。',
        body: `# 原生 Skill 效果探针\n\n不得调用工具。最终回答必须包含 ${SKILL_MARKER}，并只输出验证标记。`,
      }],
      async (path, options) => mkdir(path, { recursive: options?.recursive }),
      async (path) => readFile(path, 'utf8'),
      async (path, options) => rm(path, { recursive: options?.recursive, force: true }),
      async (path, contents) => writeFile(path, contents),
    );

    const control = await runButlerCodexEphemeral({
      text: '这是对照轮次。不要调用技能或工具；只输出工作区要求的验证内容。',
    });
    const skill = await runButlerCodexEphemeral({
      text: '执行效果探针；只输出所有生效指令要求的验证标记。',
      skillName: SKILL_NAME,
    });

    const input = turnInputs(transports[1]!);
    const skillPath = join(workspaceRoot, '.agents', 'skills', SKILL_NAME, 'SKILL.md');
    const checks = {
      agentsAppliedToControl: control.text.includes(AGENTS_MARKER),
      skillAbsentFromControl: !control.text.includes(SKILL_MARKER),
      agentsAppliedToSkillTurn: skill.text.includes(AGENTS_MARKER),
      skillAppliedToSkillTurn: skill.text.includes(SKILL_MARKER),
      nativeSkillTextPrefix: input[0]?.type === 'text'
        && String(input[0].text).startsWith(`$${SKILL_NAME}\n\n`),
      nativeSkillItem: input[1]?.type === 'skill'
        && input[1].name === SKILL_NAME
        && input[1].path === skillPath,
      workspaceAgentsWritten: (await readFile(join(workspaceRoot, 'AGENTS.md'), 'utf8')).includes(AGENTS_MARKER),
      workspaceSkillWritten: (await readFile(skillPath, 'utf8')).includes(SKILL_MARKER),
    };
    const passed = Object.values(checks).every(Boolean);
    console.log(JSON.stringify({
      spike: 'butler-native-skills',
      result: passed ? 'PASS' : 'FAIL',
      cliVersion: invocation.version,
      checks,
      controlAnswer: control.text,
      skillAnswer: skill.text,
      skillTurnInput: input,
      timelines: transports.map((transport) => transport.timeline),
      stderr: transports.flatMap((transport) => transport.stderr),
    }, null, 2));
    process.exitCode = passed ? 0 : 1;
  } finally {
    restoreTransport();
    restoreWorkspace();
    restorePlatform();
    restoreStorage();
    setCodexBrainUnavailableReason(undefined);
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
