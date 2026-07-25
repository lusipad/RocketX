import type { LocalAgentEnvironment } from '../stores/agentEnvironments';

export interface DispatchTarget {
  /** 已注册工作区的 id；零配置兜底项没有 id，选中时才落库 */
  id?: string;
  name: string;
  path: string;
  /** 注册表为空时由执行间已选目录合成的临时候选 */
  pending?: true;
}

export interface DispatchTargetResolution {
  options: DispatchTarget[];
  defaultId: string | undefined;
}

function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const segment = trimmed.split(/[\\/]/).pop();
  return segment?.trim() || trimmed || '本地目录';
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/** 名字或路径末段包含建议词即算命中——建议只是排序提示，命中不了就忽略 */
function matchesSuggestion(target: DispatchTarget, suggestion: string): boolean {
  const needle = normalize(suggestion);
  if (!needle) return false;
  return normalize(target.name).includes(needle) || normalize(folderName(target.path)).includes(needle);
}

/**
 * 派活时可选的工作区。
 *
 * **安全不变量**：候选只来自已注册工作区（用户亲手用系统目录框加的），
 * 或执行间已经选过的那个目录——同样来自系统目录框。模型给的 `suggestedName`
 * 只参与排序，**永远不能凭空造出一个目标**。
 *
 * 零配置：注册表为空但执行间选过目录时，合成一个临时候选，选中派发时再落库，
 * 用户不必先去设置页配置。
 */
export function resolveDispatchTargets(
  environments: readonly LocalAgentEnvironment[],
  localCodexRoot: string | undefined,
  lastDispatchEnvironmentId: string | undefined,
  suggestedName?: string,
): DispatchTargetResolution {
  const options: DispatchTarget[] = environments
    .filter((environment) => environment.enabled && environment.path.trim())
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((environment) => ({
      id: environment.id,
      name: environment.name.trim() || folderName(environment.path),
      path: environment.path,
    }));

  const root = localCodexRoot?.trim();
  if (options.length === 0 && root) {
    options.push({ name: `当前项目（${folderName(root)}）`, path: root, pending: true });
  }

  if (options.length === 0) return { options, defaultId: undefined };

  const remembered = lastDispatchEnvironmentId
    && options.find((target) => target.id === lastDispatchEnvironmentId);
  if (remembered) return { options, defaultId: remembered.id };

  const suggested = suggestedName
    ? options.find((target) => matchesSuggestion(target, suggestedName))
    : undefined;
  return { options, defaultId: (suggested ?? options[0]).id };
}

export function dispatchWorkspaceLabel(target: DispatchTarget): string {
  return target.pending ? `${target.name} · 首次使用会记住` : target.name;
}

/**
 * 派发前的最后一道闸：目标必须是已注册工作区。
 *
 * 注册表就是白名单——聊天内容再怎么诱导，也变不出一个新目录。
 * 临时候选（pending）必须先落库拿到 id 才允许派发。
 */
export function assertRegisteredWorkspace(
  workspaceId: string | undefined,
  environments: readonly LocalAgentEnvironment[],
): LocalAgentEnvironment {
  const found = workspaceId
    ? environments.find((environment) => environment.id === workspaceId)
    : undefined;
  if (!found) throw new Error('派活的目标必须是已添加的工作区，请先在选择器里选一个。');
  if (!found.enabled) throw new Error(`工作区「${found.name}」已停用，先启用它再派活。`);
  if (!found.path.trim()) throw new Error(`工作区「${found.name}」没有有效路径。`);
  return found;
}
