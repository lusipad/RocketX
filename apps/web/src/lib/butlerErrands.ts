import { renderDispatchSpec, type DispatchSpec } from '../agent/dispatchSpec';
import { useAgentEnvironments } from '../stores/agentEnvironments';
import { useLocalCodex } from '../stores/localCodex';
import { assertRegisteredWorkspace, type DispatchTarget } from './dispatchWorkspaces';

/** 管家拟好、等用户在卡上过目的任务规格草案 */
export interface ButlerErrandDraft {
  spec: DispatchSpec;
  /** 模型对目标工作区的猜测，只参与选择器排序 */
  workspaceHint?: string;
  checkpointId: string;
}

/** 一个已经派出去、正在办的活。管家页据此显示进度、审批与结论。 */
export interface ButlerErrandRun {
  title: string;
  threadId: string;
  workspaceName: string;
  readOnly: boolean;
  startedAt: number;
  /** Codex 的最终回复；干完或停下时填入 */
  reply?: string;
  outcome?: 'replied' | 'stopped';
}

export interface DispatchErrandOptions {
  /** 只调查不改文件。默认 false——派活多半是要动手，只读会让活结构性干不完。 */
  readOnly?: boolean;
}

/**
 * 派活 v1：管家替你去执行间干活，**你留在管家页**。
 *
 * 执行间是厨房不是餐厅——你点菜不该被带进厨房看厨师颠勺。这里只负责把活
 * 送进去并交出运行态，进度、审批与结论都由管家页呈现（`ButlerErrandRunCard`）。
 *
 * v1 代价：同一时刻只能有一个活在跑（执行间是单会话）。
 */
export async function dispatchButlerErrand(
  spec: DispatchSpec,
  target: DispatchTarget,
  options: DispatchErrandOptions = {},
): Promise<ButlerErrandRun> {
  const readOnly = options.readOnly === true;
  const environmentsStore = useAgentEnvironments.getState();

  // 零配置兜底项（执行间已选目录合成的候选）：选中派发时才落库拿 id
  let workspaceId = target.id;
  if (!workspaceId) {
    if (!target.pending) throw new Error('派活的目标必须是已添加的工作区。');
    workspaceId = environmentsStore.addEnvironment({
      name: target.name,
      path: target.path,
      adoProjects: [],
      defaultBaseBranch: '',
      branchPrefix: '',
    }).id;
  }

  // 最后一道闸：目标必须在白名单（注册表）里，聊天内容诱导不出新目录
  const environment = assertRegisteredWorkspace(
    workspaceId,
    useAgentEnvironments.getState().environments,
  );

  const codex = useLocalCodex.getState();
  if (codex.status === 'running' || codex.status === 'starting') {
    throw new Error('执行间正忙，等当前的活干完再派，或先在执行间停掉它。');
  }

  const workspaceChanged = codex.workspaceRoot !== environment.path;
  codex.setWorkspaceRoot(environment.path);

  // 沙箱必须与这次派活的意图一致：给「修 bug」只读权限＝保证干不完。
  // 沙箱是 thread/start 的参数，改了就得重起线程才生效。
  const sandboxMode = readOnly ? 'read-only' : 'workspace-write';
  const sandboxChanged = useLocalCodex.getState().sandboxMode !== sandboxMode;
  if (sandboxChanged) useLocalCodex.getState().setSandboxMode(sandboxMode);

  if (sandboxChanged || workspaceChanged || !useLocalCodex.getState().threadId) {
    await useLocalCodex.getState().startNew();
  }
  await useLocalCodex.getState().send(renderDispatchSpec(spec));

  useAgentEnvironments.getState().rememberDispatchEnvironment(environment.id);
  const threadId = useLocalCodex.getState().threadId;
  if (!threadId) throw new Error('执行间没能建立会话，活没派出去。');

  return {
    title: spec.title,
    threadId,
    workspaceName: environment.name,
    readOnly,
    startedAt: Date.now(),
  };
}

/**
 * 这个活是不是还在办。用于管家页判断：线程被换掉（用户去执行间手动开了新会话）
 * 就不再冒充它汇报。
 */
export function errandRunIsCurrent(run: ButlerErrandRun, threadId: string | undefined): boolean {
  return Boolean(threadId) && run.threadId === threadId;
}

/** 取执行间最后一条回复作为结论——干没干完由用户看内容判断，我们不替它宣布成功。 */
export function latestCodexReply(): string | undefined {
  const messages = useLocalCodex.getState().messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'assistant' && message.text.trim()) return message.text.trim();
  }
  return undefined;
}
