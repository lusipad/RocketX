import { t } from '../i18n';
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
  if (!latest?.headSha || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(latest.headSha)) throw new Error(t('agent.workCi.incompleteHead'));
  if (candidates.some((link) => link.lastVerifiedAt === latest.lastVerifiedAt && link.headSha?.toLowerCase() !== latest.headSha!.toLowerCase())) throw new Error(t('agent.workCi.multipleHeads'));
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
  if (!card) throw new Error(t('agent.workCi.workMissing'));
  const project = input.project.trim();
  if (!Number.isInteger(input.buildId) || input.buildId <= 0 || !project) throw new Error(t('agent.workCi.invalidBuildOrProject'));
  const projectMatches = [card.adoProject, ...ledger.links.filter((link) => link.todoId === card.id && ['ado_work_item', 'ado_pr', 'ci_build'].includes(link.kind)).map((link) => link.project)]
    .some((linked) => linked?.trim().toLowerCase() === project.toLowerCase());
  if (!projectMatches) throw new Error(t('agent.workCi.projectMismatch'));
  if (input.requirementsVersion !== (card.state.requirementsVersion ?? 0) || input.contentVersion !== (card.state.contentVersion ?? 0)) throw new Error(t('agent.workCi.versionChanged'));
  const criteria = [...new Set(input.criterionIds.map((item) => item.trim()))];
  if (!criteria.length || criteria.some((criterion) => !card.state.acceptance.includes(criterion))) throw new Error(t('agent.workCi.missingCriteria'));
  if (criteria.some((criterion) => !/\bci\b|构建|流水线|pipeline|build/i.test(criterion))) throw new Error(t('agent.workCi.ciScopeOnly'));
  const config = loadWorkbenchConfig();
  if (!config?.adoBase) throw new Error(t('agent.workCi.connectAdo'));
  let sourceHead: string;
  let sourceFingerprint: string | null = null;
  const workspaceRoot = ledger.sessions.filter((session) => session.todoId === card.id).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.workspaceRoot
    ?? ledger.links.find((link) => link.todoId === card.id && link.kind === 'kanban_card' && link.stateSnapshot === 'workspace')?.repo ?? null;
  if (inspectWorkspace) {
    if (!workspaceRoot) throw new Error(t('agent.workCi.bindWorkspace'));
    const git = await inspectWorkspace(workspaceRoot);
    await observeWorkArtifacts(card.id, { workspaceRoot, inspect: async () => git });
    const observedCard = useWorkLedger.getState().cards.find((item) => item.id === card.id);
    if (!observedCard || (observedCard.state.requirementsVersion ?? 0) !== input.requirementsVersion || (observedCard.state.contentVersion ?? 0) !== input.contentVersion) {
      throw new Error(t('agent.workCi.versionUpdatedByObserve'));
    }
    if (!git.headSha || !git.branch || git.dirtyFiles.length) throw new Error(t('agent.workCi.dirtyOrNoHead'));
    sourceFingerprint = git.contentFingerprint;
    sourceHead = git.headSha.toLowerCase();
  } else sourceHead = currentHead(ledger.links, card.id);
  const build = await directGetBuild({ adoBase: config.adoBase, pat: config.pat ?? '', auth: config.auth }, project, input.buildId);
  if (build.id !== input.buildId || build.project.toLowerCase() !== project.toLowerCase()) throw new Error(t('agent.workCi.buildIdentityMismatch'));
  if (build.status !== 'completed' || build.result !== 'succeeded') throw new Error(t('agent.workCi.notSucceeded', { status: build.status || t('agent.workCi.unknownStatus'), result: build.result || t('agent.workCi.unknownResult') }));
  if (!build.definition || !Number.isInteger(build.definitionId) || !build.sourceVersion || build.sourceVersion.toLowerCase() !== sourceHead) throw new Error(t('agent.workCi.sourceMismatch'));
  if (inspectWorkspace && workspaceRoot) {
    const git = await inspectWorkspace(workspaceRoot);
    await observeWorkArtifacts(card.id, { workspaceRoot, inspect: async () => git });
    if (git.headSha?.toLowerCase() !== sourceHead || git.dirtyFiles.length || git.contentFingerprint !== sourceFingerprint) throw new Error(t('agent.workCi.workspaceChanged'));
  }
  const latest = useWorkLedger.getState();
  const current = latest.cards.find((item) => item.id === card.id);
  const currentConfig = loadWorkbenchConfig();
  if (!current || (current.state.requirementsVersion ?? 0) !== input.requirementsVersion || (current.state.contentVersion ?? 0) !== input.contentVersion ||
    currentHead(latest.links, card.id) !== sourceHead || currentConfig?.adoBase !== config.adoBase || currentConfig.account !== config.account ||
    (useAuth.getState().user?._id ?? 'local-user') !== actorId || getServerBase() !== server) throw new Error(t('agent.workCi.contextChanged'));
  const duplicate = latest.evidences.find((evidence) => evidence.todoId === card.id && evidence.kind === 'ci_build' && !evidence.stale && evidence.passed &&
    evidence.headSha === sourceHead && evidence.webUrl === build.webUrl && evidence.requirementsVersion === input.requirementsVersion && evidence.contentVersion === input.contentVersion &&
    criteria.length === evidence.criterionIds?.length && criteria.every((criterion) => evidence.criterionIds?.includes(criterion)));
  if (duplicate) return duplicate;
  const receipt = { source: 'ado_build_api', adoBase: config.adoBase, account: config.account, actorId, server, project: build.project, buildId: build.id,
    buildNumber: build.buildNumber, definitionId: build.definitionId, definition: build.definition, sourceVersion: build.sourceVersion,
    sourceBranch: build.sourceBranch, status: build.status, result: build.result, observedAt: Date.now(),
    requirementsVersion: input.requirementsVersion, contentVersion: input.contentVersion };
  return latest.addEvidence({ todoId: card.id, sessionId: null, kind: 'ci_build', title: t('agent.workCi.evidenceTitle', { definition: build.definition, buildNumber: build.buildNumber }),
    summary: t('agent.workCi.evidenceSummary', { receipt: JSON.stringify(receipt) }),
    headSha: sourceHead, workspaceRoot, webUrl: build.webUrl, passed: true, criterionIds: criteria,
    requirementsVersion: input.requirementsVersion, contentVersion: input.contentVersion });
}
