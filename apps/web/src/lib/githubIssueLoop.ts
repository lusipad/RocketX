import type { GitHubIssueDetail } from '../platform/desktopCommands';

export interface LinkedGitHubIssue {
  owner: string;
  repo: string;
  number: number;
  title: string;
  htmlUrl: string;
}

const VALID_SEGMENT_RE = /^[A-Za-z0-9._-]{1,100}$/;

function isValidRepoSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    VALID_SEGMENT_RE.test(segment)
  );
}

/**
 * Parse `#42`, `42`, `owner/repo#42`, or `https://host/owner/repo/issues/42`.
 */
export function parseGitHubIssueReference(
  raw: string,
  fallbackRepo?: { owner: string; repo: string } | null,
): { owner: string; repo: string; number: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const urlMatch = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:[/?#].*)?$/i.exec(
    trimmed,
  );
  if (urlMatch) {
    const [, owner, repo, numStr] = urlMatch;
    const number = Number.parseInt(numStr, 10);
    if (isValidRepoSegment(owner) && isValidRepoSegment(repo) && number > 0) {
      return { owner, repo, number };
    }
    return null;
  }

  const slugMatch = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(trimmed);
  if (slugMatch) {
    const [, owner, repo, numStr] = slugMatch;
    const number = Number.parseInt(numStr, 10);
    if (isValidRepoSegment(owner) && isValidRepoSegment(repo) && number > 0) {
      return { owner, repo, number };
    }
    return null;
  }

  const numMatch = /^#?(\d+)$/.exec(trimmed);
  if (numMatch && fallbackRepo?.owner?.trim() && fallbackRepo?.repo?.trim()) {
    const owner = fallbackRepo.owner.trim();
    const repo = fallbackRepo.repo.trim();
    const number = Number.parseInt(numMatch[1], 10);
    if (isValidRepoSegment(owner) && isValidRepoSegment(repo) && number > 0) {
      return { owner, repo, number };
    }
  }

  return null;
}

/**
 * Format fetched GitHub Issue metadata, body, and recent comments into an actionable prompt.
 */
export function buildGitHubIssueBriefPrompt(
  issue: GitHubIssueDetail,
  target: 'roundtable' | 'kanban' = 'roundtable',
): string {
  const lines: string[] = [
    `[GitHub Issue #${issue.number}] ${issue.title}`,
    `Repo: ${issue.owner}/${issue.repo}`,
    `URL: ${issue.htmlUrl}`,
  ];
  if (issue.labels.length > 0) {
    lines.push(`Labels: ${issue.labels.join(', ')}`);
  }
  lines.push('');
  lines.push('Issue Body:');
  lines.push(issue.body.trim() || '(no body provided)');

  const recentComments = issue.comments.slice(0, 8);
  if (recentComments.length > 0) {
    lines.push('');
    lines.push('Recent Comments:');
    for (const c of recentComments) {
      const bodyPreview = c.body.trim().replace(/\s+/g, ' ').slice(0, 500);
      lines.push(`- @${c.author || 'user'}: ${bodyPreview}`);
    }
  }

  lines.push('');
  if (target === 'kanban') {
    lines.push(
      `Goal: Diagnose the root cause in this repository, implement the fix with automated tests covering edge cases, and verify all tests pass locally for issue #${issue.number} (PR delivery for Closes #${issue.number} happens after local verification).`,
    );
  } else {
    lines.push(
      `Please analyze the root cause, edge cases, and local test plan for GitHub issue #${issue.number}. Keep workspace changes local and uncommitted during implementation/verification — RocketX will handle branching, pushing, PR creation (Closes #${issue.number}), and issue commenting in the PR Delivery step after verification passes.`,
    );
  }

  return lines.join('\n');
}

export function isProtectedPrimaryBranch(branch: string | null | undefined): boolean {
  const clean = branch?.trim() ?? '';
  return !clean || clean === 'HEAD' || clean === 'main' || clean === 'master' || clean === 'trunk';
}

export interface GitHubIssuePrDraft {
  branchName: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  buildIssueComment: (prUrl: string, branch: string) => string;
}

/**
 * Build deterministic branch, commit, PR, and closing comment text for a linked GitHub Issue.
 */
export function buildGitHubIssuePrDraft(
  issue: LinkedGitHubIssue,
  decisionTitle?: string,
  decisionSummary?: string,
): GitHubIssuePrDraft {
  const shortTitle = issue.title.replace(/\s+/g, ' ').trim();
  const branchName = `fix/issue-${issue.number}`;
  const commitMessage = `fix: resolve #${issue.number} ${shortTitle.slice(0, 72).trim()}`;
  const prTitle = `fix: ${shortTitle.slice(0, 80).trim()} (#${issue.number})`;
  const summaryBlock = (decisionSummary || decisionTitle || shortTitle).trim();
  const prBody = [
    `Closes #${issue.number}`,
    '',
    `Source Issue: ${issue.htmlUrl || `${issue.owner}/${issue.repo}#${issue.number}`}`,
    '',
    summaryBlock,
  ].join('\n');

  const buildIssueComment = (prUrl: string, branch: string): string =>
    [
      `RocketX has completed implementation and independent verification on branch \`${branch}\`.`,
      '',
      `Pull Request: ${prUrl}`,
      `Linked Issue: Closes #${issue.number}`,
    ].join('\n');

  return {
    branchName,
    commitMessage,
    prTitle,
    prBody,
    buildIssueComment,
  };
}
