import { t } from '../i18n';
import { isTauri } from '../lib/http';
import { workContextPathKey } from '../lib/workContext';
import { inspectNativeWorkspaceGit, type NativeWorkspaceGitSnapshot } from '../platform/desktopCommands';
import { captureWorkLedgerAccount, useWorkLedger } from '../stores/workLedger';

/** Persist a real content observation before accepting or publishing completed work. */
export async function observeWorkArtifacts(workId: string, options: {
  workspaceRoot?: string;
  inspect?: (root: string) => Promise<NativeWorkspaceGitSnapshot>;
} = {}): Promise<NativeWorkspaceGitSnapshot | null> {
  if (!isTauri && !options.inspect) return null;
  const assertAccount = captureWorkLedgerAccount();
  const ledger = useWorkLedger.getState();
  const card = ledger.cards.find((item) => item.id === workId);
  if (!card) throw new Error(t('agent.workArtifacts.workMissing'));
  const root = options.workspaceRoot || ledger.sessions.filter((session) => session.todoId === workId && session.workspaceRoot)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.workspaceRoot
    || ledger.links.find((link) => link.todoId === workId && link.kind === 'kanban_card' && link.stateSnapshot === 'workspace')?.repo;
  if (!root) return null;
  let snapshot: NativeWorkspaceGitSnapshot;
  try { snapshot = await (options.inspect ?? inspectNativeWorkspaceGit)(root); } catch (error) {
    assertAccount();
    const knownCode = ledger.links.some((link) => link.todoId === workId && ['git_branch', 'ado_pr'].includes(link.kind))
      || ledger.evidences.some((evidence) => evidence.todoId === workId && evidence.passed && ['ci_build', 'test_run', 'diff_check', 'git_commit'].includes(evidence.kind));
    if (!knownCode && /不是.*Git|not a git repository/i.test(error instanceof Error ? error.message : String(error))) return null;
    throw error;
  }
  assertAccount();
  if (!snapshot.contentFingerprint) throw new Error(t('agent.workArtifacts.hostUnsupported'));
  await useWorkLedger.getState().upsertLink({
    todoId: workId, kind: 'git_branch', externalId: `workspace:${workContextPathKey(snapshot.repoTopLevel || root)}`,
    project: card.state.projectKey, repo: snapshot.repoTopLevel || root, rid: card.rid,
    headSha: snapshot.headSha, title: t('agent.workArtifacts.currentOutcome', { branch: snapshot.branch || t('agent.workArtifacts.unnamedBranch') }),
    webUrl: null, stateSnapshot: `content:${snapshot.contentFingerprint}`,
  });
  assertAccount();
  return snapshot;
}
