import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  FolderGit2,
  GitBranch,
  GitCommit,
  GitPullRequest,
  History,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { useT } from '../i18n';
import { openExternal } from '../lib/client';
import { buildGitHubIssuePrDraft, type LinkedGitHubIssue } from '../lib/githubIssueLoop';
import { buildSplitDiffRows, parseUnifiedPatch, type DiffHunk } from '../lib/workDiff';
import {
  checkoutGitBranch,
  commitGitChanges,
  createGitCheckpoint,
  createGitPullRequest,
  diffGitCheckpoints,
  diffWorkspaceGit,
  discardGitFile,
  listGitBranches,
  listGitCheckpoints,
  listGitWorktrees,
  prepareNativeWorktree,
  pushGitBranch,
  revertGitCheckpoint,
  stageGitFile,
  unstageGitFile,
  type GitBranchItem,
  type GitCheckpointRecord,
  type GitWorkspaceDiff,
  type GitWorktreeItem,
} from '../platform/desktopCommands';
import { toast } from '../stores/toast';

export interface WorkDiffDrawerProps {
  workspaceRoot: string;
  open: boolean;
  onClose: () => void;
  defaultBranchName?: string;
  linkedIssue?: LinkedGitHubIssue | null;
  onWorkspaceChanged?: () => void;
  onOpenWorktree?: (worktreePath: string, branch: string) => void;
}

type DiffViewMode = 'unified' | 'split';
type FooterToolPanel = 'none' | 'commit' | 'pr' | 'worktree';

function statusBadgeClass(status: string): string {
  if (status === 'A' || status === '?') return 'bg-success/15 text-success';
  if (status === 'D') return 'bg-danger/15 text-danger';
  if (status === 'R') return 'bg-primary/15 text-primary';
  return 'bg-warning/15 text-warning';
}

export default function WorkDiffDrawer({
  workspaceRoot,
  open,
  onClose,
  defaultBranchName,
  linkedIssue = null,
  onWorkspaceChanged,
  onOpenWorktree,
}: WorkDiffDrawerProps) {
  const t = useT();
  const [diff, setDiff] = useState<GitWorkspaceDiff | null>(null);
  const [checkpoints, setCheckpoints] = useState<GitCheckpointRecord[]>([]);
  const [branches, setBranches] = useState<GitBranchItem[]>([]);
  const [worktrees, setWorktrees] = useState<GitWorktreeItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedCheckpointId, setSelectedCheckpointId] = useState<string>('working');
  const [viewMode, setViewMode] = useState<DiffViewMode>('unified');
  const [fileFilter, setFileFilter] = useState('');
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [collapsedHunks, setCollapsedHunks] = useState<Record<string, boolean>>({});
  const [confirmDiscardPath, setConfirmDiscardPath] = useState<string | null>(null);
  const [confirmRevertId, setConfirmRevertId] = useState<string | null>(null);

  const [footerPanel, setFooterPanel] = useState<FooterToolPanel>('none');
  const [commitMessage, setCommitMessage] = useState('');
  const [stageAllOnCommit, setStageAllOnCommit] = useState(true);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prBase, setPrBase] = useState(defaultBranchName || 'main');
  const [prResultUrl, setPrResultUrl] = useState<string | null>(null);
  const [newBranchName, setNewBranchName] = useState('');

  const refreshAll = useCallback(async (checkpointSelection = selectedCheckpointId) => {
    if (!workspaceRoot.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const [cpList, branchList, wtList] = await Promise.all([
        listGitCheckpoints(workspaceRoot).catch(() => [] as GitCheckpointRecord[]),
        listGitBranches(workspaceRoot).catch(() => [] as GitBranchItem[]),
        listGitWorktrees(workspaceRoot).catch(() => [] as GitWorktreeItem[]),
      ]);
      setCheckpoints(cpList);
      setBranches(branchList);
      setWorktrees(wtList);

      const cp = checkpointSelection !== 'working'
        ? cpList.find((item) => item.id === checkpointSelection)
        : undefined;
      const nextDiff = cp
        ? await diffGitCheckpoints(workspaceRoot, cp.refName, null)
        : await diffWorkspaceGit(workspaceRoot, null);
      setDiff(nextDiff);
      setSelectedFilePath((prev) => {
        if (prev && nextDiff.files.some((f) => f.path === prev)) return prev;
        return nextDiff.files[0]?.path ?? null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedCheckpointId, workspaceRoot]);

  useEffect(() => {
    if (!open || !workspaceRoot.trim()) return;
    void refreshAll(selectedCheckpointId);
  }, [open, workspaceRoot, selectedCheckpointId, refreshAll]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const filteredFiles = useMemo(() => {
    const files = diff?.files ?? [];
    const q = fileFilter.trim().toLowerCase();
    if (!q) return files;
    return files.filter((file) => file.path.toLowerCase().includes(q));
  }, [diff?.files, fileFilter]);

  const activeFile = useMemo(
    () => filteredFiles.find((f) => f.path === selectedFilePath) ?? filteredFiles[0] ?? null,
    [filteredFiles, selectedFilePath],
  );

  const parsedHunks = useMemo<DiffHunk[]>(
    () => (activeFile && !activeFile.binary ? parseUnifiedPatch(activeFile.patch) : []),
    [activeFile],
  );

  if (!open) return null;

  const runAction = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await refreshAll(selectedCheckpointId);
      onWorkspaceChanged?.();
    } catch (err) {
      toast.error(err, t('agent.diff.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCheckpoint = () => void runAction(async () => {
    const label = t('agent.diff.manualCheckpointLabel', {
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    });
    const created = await createGitCheckpoint(workspaceRoot, label, 'manual');
    setSelectedCheckpointId(created.id);
    toast.success(t('agent.diff.toast.checkpointSaved', { label: created.label }));
  });

  const handleRevertCheckpoint = (checkpointId: string) => void runAction(async () => {
    const backup = await revertGitCheckpoint(workspaceRoot, checkpointId, 'working_tree');
    setConfirmRevertId(null);
    setSelectedCheckpointId('working');
    toast.success(t('agent.diff.toast.revertedWithBackup', { backupId: backup.id.slice(0, 12) }));
  });

  const handleStage = (path: string) => void runAction(async () => {
    await stageGitFile(workspaceRoot, path);
  });

  const handleUnstage = (path: string) => void runAction(async () => {
    await unstageGitFile(workspaceRoot, path);
  });

  const handleDiscard = (path: string) => void runAction(async () => {
    await discardGitFile(workspaceRoot, path);
    setConfirmDiscardPath(null);
    toast.success(t('agent.diff.toast.discardedFile', { path }));
  });

  const handleCommit = (andPush: boolean) => void runAction(async () => {
    const res = await commitGitChanges(workspaceRoot, commitMessage, stageAllOnCommit);
    setCommitMessage('');
    if (andPush) {
      const pushRes = await pushGitBranch({ workspaceRoot, setUpstream: true });
      toast.success(t('agent.diff.toast.committedAndPushed', { sha: res.commitSha.slice(0, 7), branch: pushRes.branch }));
    } else {
      toast.success(t('agent.diff.toast.committed', { summary: res.summary }));
    }
    setFooterPanel('none');
  });

  const handlePushOnly = () => void runAction(async () => {
    const pushRes = await pushGitBranch({ workspaceRoot, setUpstream: true });
    toast.success(t('agent.diff.toast.pushed', { branch: pushRes.branch }));
  });

  const handleCreatePr = () => void runAction(async () => {
    const res = await createGitPullRequest({
      workspaceRoot,
      title: prTitle.trim(),
      body: prBody.trim(),
      base: prBase.trim() || null,
    });
    const targetUrl = res.url || res.fallbackCompareUrl;
    if (targetUrl) setPrResultUrl(targetUrl);
    if (res.created) {
      toast.success(res.message);
    } else {
      toast.info(res.message);
    }
  });

  const handleCreateWorktree = () => void runAction(async () => {
    const branch = newBranchName.trim();
    if (!branch) return;
    const info = await prepareNativeWorktree({
      repoRoot: workspaceRoot,
      branchName: branch,
      slug: branch,
    });
    setNewBranchName('');
    toast.success(t('agent.diff.toast.worktreeReady', { branch: info.branch }));
    onOpenWorktree?.(info.worktreePath, info.branch);
  });

  return (
    <aside
      aria-label={t('agent.diff.drawerAria')}
      className="flex h-full w-full max-w-[680px] shrink-0 flex-col border-l border-line bg-surface-3 shadow-card"
    >
      {/* Top Bar */}
      <header className="flex h-[52px] min-h-[52px] items-center justify-between gap-2 border-b border-line px-3">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch size={15} className="shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate text-sm font-semibold text-ink">
            {diff?.branch ?? t('agent.diff.detachedHead')}
          </span>
          {diff && (diff.ahead > 0 || diff.behind > 0) ? (
            <span className="rounded bg-fill-2 px-1.5 py-0.5 text-xs text-ink-2">
              {diff.ahead > 0 ? `↑${diff.ahead}` : ''} {diff.behind > 0 ? `↓${diff.behind}` : ''}
            </span>
          ) : null}
          {diff ? (
            <span className="rounded bg-fill-2 px-1.5 py-0.5 text-xs font-mono">
              <span className="text-success">+{diff.totalAdditions}</span>
              {' / '}
              <span className="text-danger">-{diff.totalDeletions}</span>
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div className="inline-flex rounded-md border border-line bg-surface-2 p-0.5" role="group" aria-label={t('agent.diff.viewModeAria')}>
            <button
              type="button"
              onClick={() => setViewMode('unified')}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition ${viewMode === 'unified' ? 'bg-surface-3 text-ink font-medium shadow-xs' : 'text-ink-3 hover:text-ink'}`}
              title={t('agent.diff.unifiedView')}
            >
              <Rows2 size={12} aria-hidden="true" />
              {t('agent.diff.unifiedView')}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('split')}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition ${viewMode === 'split' ? 'bg-surface-3 text-ink font-medium shadow-xs' : 'text-ink-3 hover:text-ink'}`}
              title={t('agent.diff.splitView')}
            >
              <Columns2 size={12} aria-hidden="true" />
              {t('agent.diff.splitView')}
            </button>
          </div>
          <button
            type="button"
            disabled={loading || busy}
            onClick={() => void refreshAll(selectedCheckpointId)}
            aria-label={t('agent.diff.refreshAria')}
            title={t('agent.diff.refreshAria')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 hover:bg-fill-hover hover:text-ink disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('agent.diff.closeAria')}
            title={t('agent.diff.closeAria')}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 hover:bg-fill-hover hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      </header>

      {/* Zero-Pollution Checkpoint Strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2 px-3 py-2 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <History size={13} className="shrink-0 text-ink-3" aria-hidden="true" />
          <label htmlFor="rcx-checkpoint-select" className="sr-only">{t('agent.diff.checkpointSelectAria')}</label>
          <select
            id="rcx-checkpoint-select"
            value={selectedCheckpointId}
            onChange={(e) => {
              setSelectedCheckpointId(e.target.value);
              setConfirmRevertId(null);
            }}
            className="min-w-0 max-w-[260px] flex-1 rounded border border-line bg-surface-3 px-2 py-1 text-xs text-ink outline-none focus:border-primary"
          >
            <option value="working">{t('agent.diff.workingTreeOption')}</option>
            {checkpoints.map((cp) => (
              <option key={cp.id} value={cp.id}>
                {cp.label} ({cp.changedFiles})
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={handleSaveCheckpoint}
            className="inline-flex items-center gap-1 rounded border border-line bg-surface-3 px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover hover:text-ink disabled:opacity-50"
          >
            <Plus size={12} aria-hidden="true" />
            {t('agent.diff.saveCheckpointBtn')}
          </button>
        </div>
        {selectedCheckpointId !== 'working' ? (
          confirmRevertId === selectedCheckpointId ? (
            <div className="flex items-center gap-1.5">
              <span className="text-warning">{t('agent.diff.revertSafetyNote')}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleRevertCheckpoint(selectedCheckpointId)}
                className="inline-flex items-center gap-1 rounded bg-warning px-2 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                <Check size={12} />
                {t('agent.diff.confirmRevertBtn')}
              </button>
              <button
                type="button"
                onClick={() => setConfirmRevertId(null)}
                className="rounded border border-line px-2 py-1 text-xs text-ink-2 hover:bg-fill-hover"
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmRevertId(selectedCheckpointId)}
              className="inline-flex items-center gap-1 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-xs font-medium text-warning hover:bg-warning/20 disabled:opacity-50"
            >
              <RotateCcw size={12} aria-hidden="true" />
              {t('agent.diff.revertCheckpointBtn')}
            </button>
          )
        ) : (
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => setFooterPanel((p) => (p === 'commit' ? 'none' : 'commit'))}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs border transition ${footerPanel === 'commit' ? 'border-primary bg-primary/15 text-primary' : 'border-line bg-surface-3 text-ink-2 hover:text-ink'}`}
            >
              <GitCommit size={12} />
              {t('agent.diff.commitTab')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                setFooterPanel((p) => {
                  const next = p === 'pr' ? 'none' : 'pr';
                  if (next === 'pr' && linkedIssue && !prTitle.trim() && !prBody.trim()) {
                    const draft = buildGitHubIssuePrDraft(linkedIssue);
                    setPrTitle(draft.prTitle);
                    setPrBody(draft.prBody);
                  }
                  return next;
                })
              }
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs border transition ${footerPanel === 'pr' ? 'border-primary bg-primary/15 text-primary' : 'border-line bg-surface-3 text-ink-2 hover:text-ink'}`}
            >
              <GitPullRequest size={12} />
              {t('agent.diff.prTab')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setFooterPanel((p) => (p === 'worktree' ? 'none' : 'worktree'))}
              className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs border transition ${footerPanel === 'worktree' ? 'border-primary bg-primary/15 text-primary' : 'border-line bg-surface-3 text-ink-2 hover:text-ink'}`}
            >
              <FolderGit2 size={12} />
              {t('agent.diff.worktreeTab')} ({worktrees.length})
            </button>
          </div>
        )}
      </div>

      {/* Expandable Source Control Panels */}
      {footerPanel === 'commit' && (
        <div className="space-y-2 border-b border-line bg-surface-2 px-3 py-2.5 text-xs">
          <div className="flex gap-2">
            <input
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && commitMessage.trim() && !busy) {
                  e.preventDefault();
                  handleCommit(false);
                }
              }}
              placeholder={t('agent.diff.commitPlaceholder')}
              className="flex-1 rounded border border-line bg-surface-3 px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
            />
            <button
              type="button"
              disabled={busy || !commitMessage.trim()}
              onClick={() => handleCommit(false)}
              className="rounded bg-primary px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              {t('agent.diff.commitBtn')}
            </button>
            <button
              type="button"
              disabled={busy || !commitMessage.trim()}
              onClick={() => handleCommit(true)}
              className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2.5 py-1.5 font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
            >
              <Upload size={12} />
              {t('agent.diff.commitPushBtn')}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <label className="inline-flex items-center gap-1.5 text-ink-2">
              <input
                type="checkbox"
                checked={stageAllOnCommit}
                onChange={(e) => setStageAllOnCommit(e.target.checked)}
              />
              {t('agent.diff.stageAllLabel')}
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={handlePushOnly}
              className="text-ink-2 hover:text-primary hover:underline"
            >
              {t('agent.diff.pushBranchBtn')}
            </button>
          </div>
        </div>
      )}

      {footerPanel === 'pr' && (
        <div className="space-y-2 border-b border-line bg-surface-2 px-3 py-2.5 text-xs">
          <div className="flex gap-2">
            <input
              type="text"
              value={prTitle}
              onChange={(e) => setPrTitle(e.target.value)}
              placeholder={t('agent.diff.prTitlePlaceholder')}
              className="flex-1 rounded border border-line bg-surface-3 px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
            />
            <input
              type="text"
              value={prBase}
              onChange={(e) => setPrBase(e.target.value)}
              placeholder={t('agent.diff.prBasePlaceholder')}
              aria-label={t('agent.diff.prBaseAria')}
              className="w-24 rounded border border-line bg-surface-3 px-2 py-1.5 text-xs text-ink outline-none focus:border-primary"
            />
            <button
              type="button"
              disabled={busy || !prTitle.trim()}
              onClick={handleCreatePr}
              className="rounded bg-primary px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              {t('agent.diff.createPrBtn')}
            </button>
          </div>
          <textarea
            value={prBody}
            onChange={(e) => setPrBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && prTitle.trim() && !busy) {
                e.preventDefault();
                handleCreatePr();
              }
            }}
            rows={2}
            placeholder={t('agent.diff.prBodyPlaceholder')}
            className="w-full rounded border border-line bg-surface-3 px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
          />
          {prResultUrl ? (
            <button
              type="button"
              onClick={() => void openExternal(prResultUrl)}
              className="text-primary hover:underline"
            >
              {t('agent.diff.openPrUrlBtn', { url: prResultUrl })}
            </button>
          ) : null}
        </div>
      )}

      {footerPanel === 'worktree' && (
        <div className="space-y-2 border-b border-line bg-surface-2 px-3 py-2.5 text-xs">
          <div className="flex gap-2">
            <input
              type="text"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder={t('agent.diff.newWorktreePlaceholder')}
              className="flex-1 rounded border border-line bg-surface-3 px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary"
            />
            <button
              type="button"
              disabled={busy || !newBranchName.trim()}
              onClick={handleCreateWorktree}
              className="rounded bg-primary px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              {t('agent.diff.createWorktreeBtn')}
            </button>
            <button
              type="button"
              disabled={busy || !newBranchName.trim()}
              onClick={() => void runAction(async () => {
                await checkoutGitBranch(workspaceRoot, newBranchName.trim(), true);
                setNewBranchName('');
              })}
              className="rounded border border-line bg-surface-3 px-2.5 py-1.5 text-ink-2 hover:bg-fill-hover hover:text-ink disabled:opacity-50"
            >
              {t('agent.diff.checkoutNewBranchBtn')}
            </button>
          </div>
          {branches.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-ink-3">{t('agent.diff.branchesLabel')}</span>
              {branches.slice(0, 8).map((b) => (
                <button
                  key={b.name}
                  type="button"
                  disabled={busy || b.current}
                  onClick={() => void runAction(() => checkoutGitBranch(workspaceRoot, b.name, false))}
                  className={`rounded px-1.5 py-0.5 text-xs ${b.current ? 'bg-primary text-white' : 'bg-surface-3 text-ink-2 hover:bg-fill-hover'}`}
                >
                  {b.name}
                </button>
              ))}
            </div>
          ) : null}
          {worktrees.length > 0 ? (
            <div className="max-h-28 space-y-1 overflow-y-auto">
              {worktrees.map((wt) => (
                <div key={wt.path} className="flex items-center justify-between gap-2 rounded border border-line bg-surface-3 px-2 py-1">
                  <div className="min-w-0 flex-1">
                    <span className="font-medium text-ink">{wt.branch ?? (wt.detached ? 'detached' : 'worktree')}</span>
                    <span className="ml-2 truncate text-ink-3">{wt.path}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {wt.isCurrent ? (
                      <span className="rounded bg-success/15 px-1.5 py-0.5 text-xs text-success">{t('agent.diff.currentBadge')}</span>
                    ) : onOpenWorktree ? (
                      <button
                        type="button"
                        onClick={() => onOpenWorktree(wt.path, wt.branch ?? '')}
                        className="rounded border border-line px-1.5 py-0.5 text-xs text-primary hover:bg-fill-hover"
                      >
                        {t('agent.diff.switchWorktreeBtn')}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {error ? (
        <div role="alert" className="m-3 rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          {error}
        </div>
      ) : null}

      {/* Main Split Body: File List + Diff Hunks */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* File sidebar */}
        <div className="flex max-h-48 w-full shrink-0 flex-col border-b border-line bg-surface-2 md:max-h-none md:w-56 md:border-b-0 md:border-r">
          <div className="flex items-center gap-1 border-b border-line p-2">
            <input
              type="search"
              value={fileFilter}
              onChange={(e) => setFileFilter(e.target.value)}
              placeholder={t('agent.diff.filterFilesPlaceholder')}
              className="min-w-0 flex-1 rounded border border-line bg-surface-3 px-2 py-1 text-xs text-ink outline-none focus:border-primary"
            />
            {selectedCheckpointId === 'working' && (diff?.files.length ?? 0) > 0 ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleStage('*')}
                  title={t('agent.diff.stageAllBtn')}
                  className="rounded border border-line bg-surface-3 px-1.5 py-1 text-xs text-ink-2 hover:text-ink"
                >
                  +A
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => handleUnstage('*')}
                  title={t('agent.diff.unstageAllBtn')}
                  className="rounded border border-line bg-surface-3 px-1.5 py-1 text-xs text-ink-2 hover:text-ink"
                >
                  -A
                </button>
              </>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-1">
            {filteredFiles.length === 0 ? (
              <p className="p-3 text-center text-xs text-ink-3">{t('agent.diff.emptyClean')}</p>
            ) : (
              filteredFiles.map((file) => {
                const selected = activeFile?.path === file.path;
                const fileName = file.path.split('/').at(-1) || file.path;
                return (
                  <div
                    key={file.path}
                    className={`group flex items-center justify-between gap-1 rounded px-2 py-1.5 text-xs ${selected ? 'bg-primary/15 text-ink' : 'text-ink-2 hover:bg-fill-hover'}`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedFilePath(file.path)}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                      title={file.path}
                    >
                      <span className={`shrink-0 rounded px-1 py-0.5 font-mono text-xs ${statusBadgeClass(file.status)}`}>
                        {file.status}
                      </span>
                      <span className="truncate font-mono">{fileName}</span>
                    </button>
                    <span className="shrink-0 font-mono text-xs text-ink-3">
                      +{file.additions}/-{file.deletions}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Diff viewer */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-surface p-3">
          {!activeFile ? (
            <div className="flex h-full items-center justify-center text-xs text-ink-3">
              {loading ? t('agent.diff.loading') : t('agent.diff.selectFileHint')}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 font-mono text-xs ${statusBadgeClass(activeFile.status)}`}>
                    {activeFile.status}
                  </span>
                  <span className="truncate font-mono font-medium text-ink">{activeFile.path}</span>
                </div>
                {selectedCheckpointId === 'working' ? (
                  <div className="flex items-center gap-1.5">
                    {activeFile.unstaged || activeFile.status === '?' ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleStage(activeFile.path)}
                        className="rounded border border-line bg-surface-3 px-2 py-1 text-xs text-ink-2 hover:text-ink"
                      >
                        {t('agent.diff.stageBtn')}
                      </button>
                    ) : null}
                    {activeFile.staged ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleUnstage(activeFile.path)}
                        className="rounded border border-line bg-surface-3 px-2 py-1 text-xs text-ink-2 hover:text-ink"
                      >
                        {t('agent.diff.unstageBtn')}
                      </button>
                    ) : null}
                    {confirmDiscardPath === activeFile.path ? (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => handleDiscard(activeFile.path)}
                          className="rounded bg-danger px-2 py-1 text-xs font-medium text-white"
                        >
                          {t('agent.diff.confirmDiscardBtn')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDiscardPath(null)}
                          className="rounded border border-line px-2 py-1 text-xs text-ink-2"
                        >
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDiscardPath(activeFile.path)}
                        className="inline-flex items-center gap-1 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-xs text-danger hover:bg-danger/20"
                      >
                        <Trash2 size={11} />
                        {t('agent.diff.discardBtn')}
                      </button>
                    )}
                  </div>
                ) : null}
              </div>

              {activeFile.binary ? (
                <div className="rounded-lg border border-line bg-surface-2 p-4 text-center text-xs text-ink-3">
                  {t('agent.diff.binaryFileNotice')}
                </div>
              ) : parsedHunks.length === 0 ? (
                <div className="rounded-lg border border-line bg-surface-2 p-4 text-center text-xs text-ink-3">
                  {activeFile.truncated ? t('agent.diff.truncatedNotice') : t('agent.diff.noHunks')}
                </div>
              ) : (
                parsedHunks.map((hunk) => {
                  const key = `${activeFile.path}:${hunk.id}`;
                  const collapsed = Boolean(collapsedHunks[key]);
                  const splitRows = viewMode === 'split' ? buildSplitDiffRows(hunk.lines) : [];
                  return (
                    <div key={key} className="overflow-hidden rounded-lg border border-line bg-surface-2">
                      <button
                        type="button"
                        onClick={() => setCollapsedHunks((prev) => ({ ...prev, [key]: !collapsed }))}
                        className="flex w-full items-center gap-1.5 border-b border-line bg-surface-3 px-2.5 py-1.5 text-left font-mono text-xs text-ink-3 hover:text-ink"
                      >
                        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                        <span className="truncate">{hunk.header}</span>
                      </button>
                      {!collapsed && (
                        viewMode === 'unified' ? (
                          <div className="overflow-x-auto font-mono text-xs leading-5">
                            {hunk.lines.map((line, idx) => (
                              <div
                                key={idx}
                                className={`flex whitespace-pre ${
                                  line.type === 'add'
                                    ? 'bg-success/10 text-ink'
                                    : line.type === 'del'
                                      ? 'bg-danger/10 text-ink'
                                      : 'text-ink-2'
                                }`}
                              >
                                <span className="w-10 shrink-0 select-none border-r border-line/50 px-1.5 text-right text-ink-3">
                                  {line.oldLine ?? ''}
                                </span>
                                <span className="w-10 shrink-0 select-none border-r border-line/50 px-1.5 text-right text-ink-3">
                                  {line.newLine ?? ''}
                                </span>
                                <span className="w-5 shrink-0 select-none text-center text-ink-3">
                                  {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
                                </span>
                                <span className="min-w-0 flex-1 pr-3">{line.text}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <div className="overflow-x-auto font-mono text-xs leading-5">
                            {splitRows.map((row, idx) => (
                              <div key={idx} className="grid grid-cols-2 border-b border-line/30 last:border-b-0">
                                <div className={`flex min-w-0 border-r border-line/60 whitespace-pre ${row.left?.type === 'del' ? 'bg-danger/10 text-ink' : 'text-ink-2'}`}>
                                  <span className="w-9 shrink-0 select-none border-r border-line/40 px-1 text-right text-ink-3">
                                    {row.left?.oldLine ?? ''}
                                  </span>
                                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis px-2">
                                    {row.left?.text ?? ''}
                                  </span>
                                </div>
                                <div className={`flex min-w-0 whitespace-pre ${row.right?.type === 'add' ? 'bg-success/10 text-ink' : 'text-ink-2'}`}>
                                  <span className="w-9 shrink-0 select-none border-r border-line/40 px-1 text-right text-ink-3">
                                    {row.right?.newLine ?? ''}
                                  </span>
                                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis px-2">
                                    {row.right?.text ?? ''}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
