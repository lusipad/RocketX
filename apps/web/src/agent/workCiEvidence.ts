import { loadWorkbenchConfig } from '../lib/ado';
import { directGetBuild } from '../lib/adoDirect';
import { isTauri } from '../lib/http';
import { getServerBase } from '../lib/client';
import { inspectNativeWorkspaceGit, type NativeWorkEvidence, type NativeWorkLink } from '../platform/desktopCommands';
import { useWorkLedger } from '../stores/workLedger';
import { useAuth } from '../stores/auth';
import { observeWorkArtifacts } from './workArtifacts';

function currentHead(links: NativeWorkLink[], workId: string): string {
  const candidates = links.filter((link) => link.todoId === workId && ['git_branch', 'ado_pr'].includes(link.kind) && link.headSha)
    .sort((a, b) => b.lastVerifiedAt - a.lastVerifiedAt);
  const latest = candidates[0];
  if (!latest?.headSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(latest.headSha)) throw new Error('当前工作尚无完整且可核对的 HEAD SHA，请先刷新工作区来源');
  if (candidates.some((link) => link.lastVerifiedAt === latest.lastVerifiedAt && link.headSha?.toLowerCase() !== latest.headSha!.toLowerCase())) throw new Error('工作关联多个不同 HEAD，请先明确当前成果');
  return latest.headSha.toLowerCase();
}

/** 只读 ADO 真实构建结果；不接受模型传入的 result 或源提交。 */
export async function verifyWorkCiEvidence(input: {
  workId: string;
  project: string;
  buildId: number;
  requirementsVersion: number;
  contentVersion: number;
  criterionIds: string[];
}, inspectWorkspace = isTauri ? inspectNativeWorkspaceGit : undefined): Promise<NativeWorkEvidence> {
  const ledger = useWorkLedger.getState();
  const actorId = useAuth.getState().user?._id ?? 'local-user';
  const server = getServerBase();
  const card = ledger.cards.find((item) => item.id === input.workId);
  if (!card) throw new Error('工作不存在');
  const project = input.project.trim();
  if (!Number.isInteger(input.buildId) || input.buildId <= 0 || !project) throw new Error('CI 验证需要有效的项目和构建 ID');
  const projectMatches = [card.adoProject, ...ledger.links.filter((link) => link.todoId === card.id && ['ado_work_item', 'ado_pr', 'ci_build'].includes(link.kind)).map((link) => link.project)]
    .some((linked) => linked?.trim().toLowerCase() === project.toLowerCase());
  if (!projectMatches) throw new Error('CI 项目与工作关联不匹配');
  if (input.requirementsVersion !== (card.state.requirementsVersion ?? 0) || input.contentVersion !== (card.state.contentVersion ?? 0)) throw new Error('工作版本已改变，请先重新读取要求和成果');
  const criteria = [...new Set(input.criterionIds.map((item) => item.trim()))];
  if (!criteria.length || criteria.some((criterion) => !card.state.acceptance.includes(criterion))) throw new Error('CI 证据必须明确映射当前已有的验收条件');
  if (criteria.some((criterion) => !/\bci\b|构建|流水线|pipeline|build/i.test(criterion))) throw new Error('此工具只验证 CI、构建或流水线状态，不能代替业务人工验收或独立本地测试');
  const config = loadWorkbenchConfig();
  if (!config?.adoBase) throw new Error('请先连接 ADO');
  let sourceHead: string;
  let sourceFingerprint: string | null = null;
  const workspaceRoot = ledger.sessions.filter((session) => session.todoId === card.id).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.workspaceRoot
    ?? ledger.links.find((link) => link.todoId === card.id && link.kind === 'kanban_card' && link.stateSnapshot === 'workspace')?.repo ?? null;
  if (inspectWorkspace) {
    if (!workspaceRoot) throw new Error('请先关联工作目录，以核对当前 HEAD');
    const git = await inspectWorkspace(workspaceRoot);
    await observeWorkArtifacts(card.id, { workspaceRoot, inspect: async () => git });
    const observedCard = useWorkLedger.getState().cards.find((item) => item.id === card.id);
    if (!observedCard || (observedCard.state.requirementsVersion ?? 0) !== input.requirementsVersion || (observedCard.state.contentVersion ?? 0) !== input.contentVersion) {
      throw new Error('实际成果观察已更新工作版本，请重新读取当前要求和成果后核对 CI');
    }
    if (!git.headSha || !git.branch || git.dirtyFiles.length) throw new Error('工作目录 HEAD 不明确或尚有未提交修改，不能用构建证明当前成果');
    sourceFingerprint = git.contentFingerprint;
    sourceHead = git.headSha.toLowerCase();
  } else sourceHead = currentHead(ledger.links, card.id);
  const build = await directGetBuild({ adoBase: config.adoBase, pat: config.pat ?? '', auth: config.auth }, project, input.buildId);
  if (build.id !== input.buildId || build.project.toLowerCase() !== project.toLowerCase()) throw new Error('ADO 返回的构建身份或项目与请求不一致');
  if (build.status !== 'completed' || build.result !== 'succeeded') throw new Error(`CI 尚未确认成功：${build.status || '未知状态'} / ${build.result || '未知结果'}`);
  if (!build.definition || !Number.isInteger(build.definitionId) || !build.sourceVersion || build.sourceVersion.toLowerCase() !== sourceHead) throw new Error('CI 定义或源提交与当前工作成果不匹配');
  if (inspectWorkspace && workspaceRoot) {
    const git = await inspectWorkspace(workspaceRoot);
    await observeWorkArtifacts(card.id, { workspaceRoot, inspect: async () => git });
    if (git.headSha?.toLowerCase() !== sourceHead || git.dirtyFiles.length || git.contentFingerprint !== sourceFingerprint) throw new Error('读取 CI 期间工作目录已改变，未登记旧构建证据');
  }
  const latest = useWorkLedger.getState();
  const current = latest.cards.find((item) => item.id === card.id);
  const currentConfig = loadWorkbenchConfig();
  if (!current || (current.state.requirementsVersion ?? 0) !== input.requirementsVersion || (current.state.contentVersion ?? 0) !== input.contentVersion ||
    currentHead(latest.links, card.id) !== sourceHead || currentConfig?.adoBase !== config.adoBase || currentConfig.account !== config.account ||
    (useAuth.getState().user?._id ?? 'local-user') !== actorId || getServerBase() !== server) throw new Error('读取 CI 期间工作或连接已改变，未将旧结果绑定到新版本');
  const duplicate = latest.evidences.find((evidence) => evidence.todoId === card.id && evidence.kind === 'ci_build' && !evidence.stale && evidence.passed &&
    evidence.headSha === sourceHead && evidence.webUrl === build.webUrl && evidence.requirementsVersion === input.requirementsVersion && evidence.contentVersion === input.contentVersion &&
    criteria.length === evidence.criterionIds?.length && criteria.every((criterion) => evidence.criterionIds?.includes(criterion)));
  if (duplicate) return duplicate;
  const receipt = { source: 'ado_build_api', adoBase: config.adoBase, account: config.account, actorId, server, project: build.project, buildId: build.id,
    buildNumber: build.buildNumber, definitionId: build.definitionId, definition: build.definition, sourceVersion: build.sourceVersion,
    sourceBranch: build.sourceBranch, status: build.status, result: build.result, observedAt: Date.now(),
    requirementsVersion: input.requirementsVersion, contentVersion: input.contentVersion };
  return latest.addEvidence({ todoId: card.id, sessionId: null, kind: 'ci_build', title: `CI 构建核对：${build.definition} #${build.buildNumber}`,
    summary: `仅证明指定提交的 CI 构建完成且成功，不代表业务人工验收。\n${JSON.stringify(receipt)}`,
    headSha: sourceHead, workspaceRoot, webUrl: build.webUrl, passed: true, criterionIds: criteria,
    requirementsVersion: input.requirementsVersion, contentVersion: input.contentVersion });
}
