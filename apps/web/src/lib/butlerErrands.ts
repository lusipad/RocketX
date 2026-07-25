import { renderDispatchSpec, type DispatchSpec } from '../agent/dispatchSpec';
import { useAgentEnvironments } from '../stores/agentEnvironments';
import { useLocalCodex } from '../stores/localCodex';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import { assertRegisteredWorkspace, type DispatchTarget } from './dispatchWorkspaces';

/** 管家拟好、等用户在卡上过目的任务规格草案 */
export interface ButlerErrandDraft {
  spec: DispatchSpec;
  /** 模型对目标工作区的猜测，只参与选择器排序 */
  workspaceHint?: string;
  checkpointId: string;
}

/**
 * 派活 v1 走薄路径：不新建派工 store，直接把规格卡送进执行间（`localCodex`）开跑。
 * 代价说清楚了——同一时刻只能有一个活在跑，进度在执行间看；等真实需求出现
 * 再把执行间升级成多会话（决策 13：复用优先，不提前造基础设施）。
 */
export async function dispatchButlerErrand(
  spec: DispatchSpec,
  target: DispatchTarget,
): Promise<{ workspaceName: string }> {
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

  codex.setWorkspaceRoot(environment.path);
  // 换目录会清线程；同目录但线程不在（首次/中断）也需要新起
  if (!useLocalCodex.getState().threadId) {
    await useLocalCodex.getState().startNew();
  }
  await useLocalCodex.getState().send(renderDispatchSpec(spec));

  useAgentEnvironments.getState().rememberDispatchEnvironment(environment.id);
  watchErrandCompletion(spec.title, useLocalCodex.getState().threadId);
  return { workspaceName: environment.name };
}

/**
 * 派出去的活干完了要吱一声——不然用户得自己盯执行间。
 * 只盯本次派发的线程；换线程、关应用即失效（v1 不做跨重启跟踪）。
 */
function watchErrandCompletion(title: string, threadId: string | undefined): void {
  if (!threadId) return;
  const unsubscribe = useLocalCodex.subscribe((state, previous) => {
    if (state.threadId !== threadId) {
      // 线程换了：这个活的进度已无从谈起，别再报喜
      unsubscribe();
      return;
    }
    if (previous.status !== 'running' || state.status === 'running') return;
    unsubscribe();
    if (state.status === 'ready') {
      toast.success(`派出去的活「${title}」有结果了`, {
        label: '去看看',
        onClick: () => useUI.getState().setModule('codex'),
      });
    } else {
      toast.info(`派出去的活「${title}」停下来了，去执行间看看原因`);
    }
  });
}
