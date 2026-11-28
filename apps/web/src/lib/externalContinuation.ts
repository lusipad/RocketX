/**
 * DP1 pure contract for external editor / terminal / CLI handoff & live workspace mirror.
 * Zero dependency on stores/, agent/, kernel/, lan/, or lib/client.ts.
 */

export type ExternalToolId =
  | 'vscode'
  | 'cursor'
  | 'windsurf'
  | 'zed'
  | 'antigravity'
  | 'system_terminal'
  | 'file_explorer'
  | 'external_cli_resume';

export interface DetectedExternalTool {
  id: ExternalToolId | string;
  label: string;
  available: boolean;
  kind: 'editor' | 'terminal' | 'explorer' | string;
}

export interface ExternalPulseMessage {
  id: string;
  role: 'user' | 'assistant' | string;
  text: string;
  timestamp: number;
}

export interface ExternalPulseGitSnapshot {
  contentFingerprint: string;
  workspaceRoot: string;
  repoTopLevel: string;
  branch: string | null;
  headSha: string | null;
  isWorktree: boolean;
  dirtyFiles: string[];
  diffStat: string | null;
  recentCommits: string[];
  unpushedCommits?: number;
  hasUntracked?: boolean;
}

export interface ExternalWorkspacePulse {
  workspaceRoot: string;
  externalWriterActive: boolean;
  writerHint: string | null;
  transcriptMtimeMs: number | null;
  transcriptSizeBytes: number | null;
  latestMessages: ExternalPulseMessage[];
  gitSnapshot: ExternalPulseGitSnapshot | null;
}

export interface ExternalPulseDiff {
  externalWriterActive: boolean;
  writerHint: string | null;
  lockComposer: boolean;
  gitChangedSinceBaseline: boolean;
  dirtyCount: number;
  unpushedCount: number;
  newExternalMessages: ExternalPulseMessage[];
  latestMessagePreview: string | null;
}

export function diffExternalWorkspacePulse(
  baseline: {
    gitFingerprint?: string | null;
    knownMessageIds?: Iterable<string>;
  } | null,
  latest: ExternalWorkspacePulse | null,
): ExternalPulseDiff {
  if (!latest) {
    return {
      externalWriterActive: false,
      writerHint: null,
      lockComposer: false,
      gitChangedSinceBaseline: false,
      dirtyCount: 0,
      unpushedCount: 0,
      newExternalMessages: [],
      latestMessagePreview: null,
    };
  }

  const knownIds = new Set(baseline?.knownMessageIds ?? []);
  const newExternalMessages = knownIds.size > 0
    ? latest.latestMessages.filter((msg) => !knownIds.has(msg.id))
    : [];

  const latestFingerprint = latest.gitSnapshot?.contentFingerprint ?? null;
  const baselineFingerprint = baseline?.gitFingerprint ?? null;
  const gitChangedSinceBaseline = Boolean(
    baselineFingerprint && latestFingerprint && baselineFingerprint !== latestFingerprint,
  );

  const dirtyCount = latest.gitSnapshot?.dirtyFiles.length ?? 0;
  const unpushedCount = latest.gitSnapshot?.unpushedCommits ?? 0;
  const lastMsg = latest.latestMessages.at(-1);
  const latestMessagePreview = lastMsg?.text.trim()
    ? lastMsg.text.trim().slice(0, 140)
    : null;

  return {
    externalWriterActive: latest.externalWriterActive,
    writerHint: latest.writerHint,
    lockComposer: latest.externalWriterActive,
    gitChangedSinceBaseline,
    dirtyCount,
    unpushedCount,
    newExternalMessages,
    latestMessagePreview,
  };
}
