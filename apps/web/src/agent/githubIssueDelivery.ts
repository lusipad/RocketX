import { isTauriRuntime } from '../lib/client';
import {
  buildGitHubIssuePrDraft,
  isProtectedPrimaryBranch,
  type LinkedGitHubIssue,
} from '../lib/githubIssueLoop';
import {
  butlerGithubCreateComment,
  butlerGithubDetectWorkspaceRepo,
  butlerGithubGetIssueDetail,
  checkoutGitBranch,
  commitGitChanges,
  createGitPullRequest,
  diffWorkspaceGit,
  pushGitBranch,
  type GitCommitResult,
  type GitCreatePrResult,
  type GitHubIssueDetail,
  type GitHubRepoIdentity,
  type GitPushResult,
  type GitWorkspaceDiff,
} from '../platform/desktopCommands';

export interface GitHubIssueDeliveryDrivers {
  isAvailable?: () => boolean;
  detectWorkspaceRepo: (workspaceRoot: string) => Promise<GitHubRepoIdentity | null>;
  getIssueDetail: (input: {
    owner: string;
    repo: string;
    number: number;
    commentLimit?: number;
  }) => Promise<GitHubIssueDetail>;
  diffWorkspace: (workspaceRoot: string) => Promise<GitWorkspaceDiff>;
  checkoutBranch: (workspaceRoot: string, branch: string, create?: boolean) => Promise<void>;
  commitChanges: (
    workspaceRoot: string,
    message: string,
    stageAll?: boolean,
  ) => Promise<GitCommitResult>;
  pushBranch: (input: {
    workspaceRoot: string;
    remote?: string | null;
    branch?: string | null;
    setUpstream?: boolean;
  }) => Promise<GitPushResult>;
  createPullRequest: (input: {
    workspaceRoot: string;
    title: string;
    body?: string | null;
    base?: string | null;
    draft?: boolean;
  }) => Promise<GitCreatePrResult>;
  createIssueComment: (input: {
    owner: string;
    repo: string;
    number: number;
    body: string;
  }) => Promise<unknown>;
}

const DEFAULT_DRIVERS: GitHubIssueDeliveryDrivers = {
  isAvailable: isTauriRuntime,
  detectWorkspaceRepo: butlerGithubDetectWorkspaceRepo,
  getIssueDetail: butlerGithubGetIssueDetail,
  diffWorkspace: diffWorkspaceGit,
  checkoutBranch: checkoutGitBranch,
  commitChanges: commitGitChanges,
  pushBranch: pushGitBranch,
  createPullRequest: createGitPullRequest,
  createIssueComment: butlerGithubCreateComment,
};

let customDrivers: GitHubIssueDeliveryDrivers | null = null;

export function setGitHubIssueDeliveryDriversForTests(
  drivers: GitHubIssueDeliveryDrivers | null,
): void {
  customDrivers = drivers;
}

function getDrivers(): GitHubIssueDeliveryDrivers {
  return customDrivers ?? DEFAULT_DRIVERS;
}

export function canUseGitHubIssueRuntime(): boolean {
  if (customDrivers) {
    return customDrivers.isAvailable ? customDrivers.isAvailable() : true;
  }
  return isTauriRuntime();
}

export async function resolveWorkspaceGitHubRepo(
  workspaceRoot: string,
): Promise<GitHubRepoIdentity | null> {
  if (!canUseGitHubIssueRuntime() || !workspaceRoot.trim()) return null;
  try {
    return await getDrivers().detectWorkspaceRepo(workspaceRoot.trim());
  } catch {
    return null;
  }
}

export async function fetchGitHubIssueDetail(input: {
  owner: string;
  repo: string;
  number: number;
  commentLimit?: number;
}): Promise<GitHubIssueDetail> {
  return getDrivers().getIssueDetail(input);
}

export interface DeliverGitHubIssuePrResult {
  branch: string;
  commitSha: string | null;
  prCreated: boolean;
  prUrl: string | null;
  commented: boolean;
  message: string;
}

/**
 * Commit verified changes on a feature branch (leaving protected main/master intact),
 * push upstream, open a PR with `Closes #N`, and optionally post a back-link comment on the Issue.
 */
export async function deliverGitHubIssuePullRequest(input: {
  workspaceRoot: string;
  issue: LinkedGitHubIssue;
  decisionTitle?: string;
  decisionSummary?: string;
  commentOnIssue?: boolean;
}): Promise<DeliverGitHubIssuePrResult> {
  const drivers = getDrivers();
  const root = input.workspaceRoot.trim();
  if (!root) {
    throw new Error('Workspace path is required for GitHub PR delivery.');
  }

  const diff = await drivers.diffWorkspace(root);
  const draft = buildGitHubIssuePrDraft(
    input.issue,
    input.decisionTitle,
    input.decisionSummary,
  );

  let activeBranch = diff.branch?.trim() || draft.branchName;
  if (isProtectedPrimaryBranch(diff.branch)) {
    try {
      await drivers.checkoutBranch(root, draft.branchName, true);
    } catch {
      await drivers.checkoutBranch(root, draft.branchName, false);
    }
    activeBranch = draft.branchName;
  }

  const refreshed = await drivers.diffWorkspace(root);
  let commitSha: string | null = null;
  if (refreshed.files.length > 0) {
    const commitRes = await drivers.commitChanges(root, draft.commitMessage, true);
    commitSha = commitRes.commitSha;
  }

  await drivers.pushBranch({
    workspaceRoot: root,
    branch: activeBranch,
    setUpstream: true,
  });

  const prRes = await drivers.createPullRequest({
    workspaceRoot: root,
    title: draft.prTitle,
    body: draft.prBody,
  });
  const prUrl = prRes.url || prRes.fallbackCompareUrl || null;

  let commented = false;
  if (input.commentOnIssue !== false && prUrl) {
    try {
      await drivers.createIssueComment({
        owner: input.issue.owner,
        repo: input.issue.repo,
        number: input.issue.number,
        body: draft.buildIssueComment(prUrl, activeBranch),
      });
      commented = true;
    } catch {
      commented = false;
    }
  }

  return {
    branch: activeBranch,
    commitSha,
    prCreated: prRes.created,
    prUrl,
    commented,
    message: prRes.message,
  };
}
