import {
  CheckCircle2,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Globe,
  KeyRound,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  canUseGitHubIssueRuntime,
  fetchGitHubIssueDetail,
  resolveWorkspaceGitHubRepo,
} from '../agent/githubIssueDelivery';
import { useI18n } from '../i18n';
import { buildGitHubIssueBriefPrompt, type LinkedGitHubIssue } from '../lib/githubIssueLoop';
import {
  butlerBrowserInspect,
  butlerGithubClearConfig,
  butlerGithubGetPrDiff,
  butlerGithubListIssues,
  butlerGithubListPrs,
  butlerGithubSaveConfig,
  butlerGithubStatus,
  butlerGithubTestConnection,
  type BrowserInspectResult,
  type GitHubConnectorStatus,
  type GitHubIssueDetail,
  type GitHubIssueSummary,
  type GitHubPullSummary,
} from '../platform/desktopCommands';
import { newWorkDraftKey, useNewWorkDrafts } from '../stores/newWorkDrafts';
import { resolvePreferredProjectWorkspace } from '../stores/roomAiParticipants';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import CreateRoomDiscussionDialog from './CreateRoomDiscussionDialog';

interface IssueRoundtableDraft {
  name: string;
  initialPrompt: string;
  linkedIssue: LinkedGitHubIssue;
}

export default function ButlerConnectorsPanel({ workspaceRoot = '' }: { workspaceRoot?: string }) {
  const { t } = useI18n();
  const desktop = canUseGitHubIssueRuntime();

  const [ghStatus, setGhStatus] = useState<GitHubConnectorStatus | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState('https://api.github.com');
  const [tokenInput, setTokenInput] = useState('');
  const [savingGh, setSavingGh] = useState(false);
  const [testingGh, setTestingGh] = useState(false);
  const [ghUser, setGhUser] = useState<string | null>(null);

  const [owner, setOwner] = useState('');
  const [repo, setRepo] = useState('');
  const [loadingItems, setLoadingItems] = useState(false);
  const [busyIssueNumber, setBusyIssueNumber] = useState<number | null>(null);
  const [pulls, setPulls] = useState<GitHubPullSummary[]>([]);
  const [issues, setIssues] = useState<GitHubIssueSummary[]>([]);
  const [prDiffPreview, setPrDiffPreview] = useState<{ number: number; diff: string; truncated: boolean } | null>(null);
  const [issuePreview, setIssuePreview] = useState<GitHubIssueDetail | null>(null);
  const [roundtableDraft, setRoundtableDraft] = useState<IssueRoundtableDraft | null>(null);

  const [inspectUrl, setInspectUrl] = useState('http://127.0.0.1:1420');
  const [allowLan, setAllowLan] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [inspectResult, setInspectResult] = useState<BrowserInspectResult | null>(null);

  const refreshStatus = useCallback(async () => {
    if (!desktop) return;
    try {
      const status = await butlerGithubStatus();
      setGhStatus(status);
      setApiBaseUrl(status.apiBaseUrl);
    } catch {
      /* ignore initial probe error */
    }
  }, [desktop]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!desktop || !workspaceRoot.trim() || owner.trim() || repo.trim()) return;
    let canceled = false;
    void resolveWorkspaceGitHubRepo(workspaceRoot).then((detected) => {
      if (canceled || !detected) return;
      setOwner((prev) => prev || detected.owner);
      setRepo((prev) => prev || detected.repo);
    });
    return () => {
      canceled = true;
    };
  }, [desktop, workspaceRoot, owner, repo]);

  const loadIssueDetailOrFallback = useCallback(
    async (issue: GitHubIssueSummary): Promise<GitHubIssueDetail> => {
      const cleanOwner = owner.trim();
      const cleanRepo = repo.trim();
      try {
        return await fetchGitHubIssueDetail({
          owner: cleanOwner,
          repo: cleanRepo,
          number: issue.number,
        });
      } catch {
        return {
          owner: cleanOwner,
          repo: cleanRepo,
          number: issue.number,
          title: issue.title,
          body: '',
          bodyTruncated: false,
          state: issue.state,
          author: issue.author,
          labels: issue.labels,
          assignees: [],
          htmlUrl: issue.htmlUrl,
          createdAt: issue.updatedAt,
          updatedAt: issue.updatedAt,
          comments: [],
        };
      }
    },
    [owner, repo],
  );

  const handleInspectIssue = async (issue: GitHubIssueSummary) => {
    setBusyIssueNumber(issue.number);
    try {
      const detail = await fetchGitHubIssueDetail({
        owner: owner.trim(),
        repo: repo.trim(),
        number: issue.number,
      });
      setIssuePreview(detail);
    } catch (error) {
      toast.error(error, t('butler.connectors.fetchFailed'));
    } finally {
      setBusyIssueNumber(null);
    }
  };

  const handleStartIssueRoundtable = async (issue: GitHubIssueSummary) => {
    setBusyIssueNumber(issue.number);
    try {
      const detail = await loadIssueDetailOrFallback(issue);
      setRoundtableDraft({
        name: `#${detail.number} ${detail.title}`.slice(0, 40),
        initialPrompt: buildGitHubIssueBriefPrompt(detail, 'roundtable'),
        linkedIssue: {
          owner: detail.owner,
          repo: detail.repo,
          number: detail.number,
          title: detail.title,
          htmlUrl: detail.htmlUrl,
        },
      });
    } finally {
      setBusyIssueNumber(null);
    }
  };

  const handleDispatchIssueKanban = async (issue: GitHubIssueSummary) => {
    setBusyIssueNumber(issue.number);
    try {
      const detail = await loadIssueDetailOrFallback(issue);
      const targetWorkspace = workspaceRoot.trim() || resolvePreferredProjectWorkspace();
      useNewWorkDrafts.getState().edit(newWorkDraftKey(), {
        open: true,
        goal: buildGitHubIssueBriefPrompt(detail, 'kanban'),
        ...(targetWorkspace ? { workspace: targetWorkspace } : {}),
      });
      useUI.getState().setButlerView('kanban');
    } finally {
      setBusyIssueNumber(null);
    }
  };

  const handleSaveGithub = async (event: FormEvent) => {
    event.preventDefault();
    setSavingGh(true);
    try {
      const next = await butlerGithubSaveConfig({
        apiBaseUrl,
        token: tokenInput.trim() || null,
      });
      setGhStatus(next);
      setTokenInput('');
      toast.success(t('butler.connectors.ghSavedToast'));
    } catch (error) {
      toast.error(error, t('butler.connectors.ghSaveFailed'));
    } finally {
      setSavingGh(false);
    }
  };

  const handleTestGithub = async () => {
    setTestingGh(true);
    try {
      const res = await butlerGithubTestConnection();
      setGhUser(res.login);
      toast.success(t('butler.connectors.ghConnectedToast', { login: res.login }));
    } catch (error) {
      toast.error(error, t('butler.connectors.ghTestFailed'));
    } finally {
      setTestingGh(false);
    }
  };

  const handleFetchRepo = async (kind: 'prs' | 'issues') => {
    if (!owner.trim() || !repo.trim()) {
      toast.error(t('butler.connectors.repoRequired'));
      return;
    }
    setLoadingItems(true);
    setPrDiffPreview(null);
    setIssuePreview(null);
    try {
      if (kind === 'prs') {
        const list = await butlerGithubListPrs({ owner: owner.trim(), repo: repo.trim(), state: 'open', limit: 15 });
        setPulls(list);
        setIssues([]);
      } else {
        const list = await butlerGithubListIssues({ owner: owner.trim(), repo: repo.trim(), state: 'open', limit: 15 });
        setIssues(list);
        setPulls([]);
      }
    } catch (error) {
      toast.error(error, t('butler.connectors.fetchFailed'));
    } finally {
      setLoadingItems(false);
    }
  };

  const handleInspect = async (event: FormEvent) => {
    event.preventDefault();
    if (!inspectUrl.trim()) return;
    setInspecting(true);
    try {
      const res = await butlerBrowserInspect({ url: inspectUrl.trim(), allowInsecureLan: allowLan });
      setInspectResult(res);
    } catch (error) {
      toast.error(error, t('butler.connectors.inspectFailed'));
    } finally {
      setInspecting(false);
    }
  };

  if (!desktop) {
    return (
      <div className="rounded-2xl border border-dashed border-line bg-surface-3 p-6 text-center text-xs text-ink-3">
        {t('butler.connectors.desktopOnly')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* GitHub Connector */}
      <section className="space-y-3 rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <GitPullRequest size={16} className="text-primary" />
            <div>
              <h2 className="text-sm font-semibold text-ink">{t('butler.connectors.githubTitle')}</h2>
              <p className="text-xs text-ink-3">{t('butler.connectors.githubDesc')}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {ghStatus?.hasToken ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2.5 py-0.5 text-2xs font-medium text-success">
                <CheckCircle2 size={11} />
                {t('butler.connectors.tokenConfigured', { hint: ghStatus.tokenHint || '***' })}
              </span>
            ) : ghStatus?.ghCliAuthenticated ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2.5 py-0.5 text-2xs font-medium text-success">
                <CheckCircle2 size={11} />
                {t('butler.connectors.ghCliAuthenticated')}
              </span>
            ) : (
              <span className="rounded-full bg-fill-2 px-2.5 py-0.5 text-2xs text-ink-3">
                {t('butler.connectors.tokenMissing')}
              </span>
            )}
            {ghUser ? (
              <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-2xs font-medium text-primary">
                @{ghUser}
              </span>
            ) : null}
          </div>
        </div>

        <form onSubmit={(e) => void handleSaveGithub(e)} className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="font-medium text-ink-2">{t('butler.connectors.apiBaseLabel')}</span>
            <input
              type="url"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              className="h-8 w-full rounded-xl border border-line bg-surface-4 px-2.5 font-mono text-xs text-ink outline-none focus:border-primary"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium text-ink-2">{t('butler.connectors.patLabel')}</span>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={ghStatus?.hasToken ? ghStatus.tokenHint || '••••••••' : 'ghp_...'}
              className="h-8 w-full rounded-xl border border-line bg-surface-4 px-2.5 text-xs text-ink outline-none focus:border-primary"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2 md:col-span-2">
            <button
              type="submit"
              disabled={savingGh}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {savingGh ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
              <span>{t('common.save')}</span>
            </button>
            <button
              type="button"
              disabled={testingGh || (!ghStatus?.hasToken && !ghStatus?.ghCliAuthenticated)}
              onClick={() => void handleTestGithub()}
              className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-line bg-surface-4 px-3 text-xs text-ink-2 hover:text-ink disabled:opacity-50"
            >
              {testingGh ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              <span>{t('butler.connectors.testConnection')}</span>
            </button>
            {ghStatus?.hasToken && (
              <button
                type="button"
                onClick={() => {
                  void butlerGithubClearConfig().then(() => {
                    setGhUser(null);
                    void refreshStatus();
                    toast.info(t('butler.connectors.ghClearedToast'));
                  });
                }}
                className="inline-flex h-8 items-center gap-1 rounded-xl border border-danger/30 bg-danger/10 px-2.5 text-xs text-danger"
              >
                <Trash2 size={12} />
                <span>{t('butler.connectors.clearToken')}</span>
              </button>
            )}
          </div>
        </form>

        {/* PR / Issue Quick Browser */}
        <div className="border-t border-line-soft pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder={t('butler.connectors.ownerPlaceholder')}
              className="h-8 w-40 rounded-xl border border-line bg-surface-4 px-2.5 text-xs text-ink outline-none focus:border-primary"
            />
            <input
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder={t('butler.connectors.repoPlaceholder')}
              className="h-8 w-44 rounded-xl border border-line bg-surface-4 px-2.5 text-xs text-ink outline-none focus:border-primary"
            />
            <button
              type="button"
              disabled={loadingItems}
              onClick={() => void handleFetchRepo('prs')}
              className="h-8 rounded-xl border border-line bg-surface-4 px-3 text-xs font-medium text-ink hover:bg-fill-hover disabled:opacity-50"
            >
              {t('butler.connectors.listPrs')}
            </button>
            <button
              type="button"
              disabled={loadingItems}
              onClick={() => void handleFetchRepo('issues')}
              className="h-8 rounded-xl border border-line bg-surface-4 px-3 text-xs font-medium text-ink hover:bg-fill-hover disabled:opacity-50"
            >
              {t('butler.connectors.listIssues')}
            </button>
            {loadingItems ? <Loader2 size={14} className="animate-spin text-primary" /> : null}
          </div>

          {pulls.length > 0 && (
            <div className="mt-2.5 space-y-1.5">
              {pulls.map((pr) => (
                <div
                  key={pr.number}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-primary">#{pr.number}</span>{' '}
                    <span className="font-medium text-ink">{pr.title}</span>
                    <span className="ml-2 text-ink-3">{pr.headRef} → {pr.baseRef} · @{pr.author}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        void butlerGithubGetPrDiff({ owner: owner.trim(), repo: repo.trim(), number: pr.number })
                          .then((d) => setPrDiffPreview({ number: d.number, diff: d.diff, truncated: d.truncated }))
                          .catch((err) => toast.error(err, t('butler.connectors.fetchFailed')));
                      }}
                      className="rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary hover:bg-primary/20"
                    >
                      {t('butler.connectors.viewDiff')}
                    </button>
                    <a
                      href={pr.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded p-1 text-ink-3 hover:text-ink"
                    >
                      <ExternalLink size={12} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}

          {issues.length > 0 && (
            <div className="mt-2.5 space-y-1.5">
              {issues.map((issue) => (
                <div
                  key={issue.number}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-primary">#{issue.number}</span>{' '}
                    <span className="font-medium text-ink">{issue.title}</span>
                    <span className="ml-2 text-ink-3">@{issue.author}</span>
                    {issue.labels.length > 0 ? (
                      <span className="ml-2 inline-flex flex-wrap gap-1">
                        {issue.labels.slice(0, 3).map((label) => (
                          <span key={label} className="rounded bg-fill-2 px-1.5 py-0.5 text-xs text-ink-2">
                            {label}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busyIssueNumber === issue.number}
                      onClick={() => void handleInspectIssue(issue)}
                      className="rounded border border-line bg-surface-3 px-2 py-0.5 text-xs text-ink-2 hover:text-ink disabled:opacity-50"
                    >
                      {t('butler.connectors.viewIssueDetailBtn')}
                    </button>
                    <button
                      type="button"
                      disabled={busyIssueNumber === issue.number}
                      onClick={() => void handleStartIssueRoundtable(issue)}
                      className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
                    >
                      <MessageSquarePlus size={11} />
                      <span>{t('butler.connectors.startIssueRoundtableBtn')}</span>
                    </button>
                    <button
                      type="button"
                      disabled={busyIssueNumber === issue.number}
                      onClick={() => void handleDispatchIssueKanban(issue)}
                      className="inline-flex items-center gap-1 rounded border border-line bg-surface-3 px-2 py-0.5 text-xs text-ink-2 hover:border-primary/40 hover:text-primary disabled:opacity-50"
                    >
                      <Wrench size={11} />
                      <span>{t('butler.connectors.dispatchIssueKanbanBtn')}</span>
                    </button>
                    <a href={issue.htmlUrl} target="_blank" rel="noreferrer" className="text-ink-3 hover:text-ink">
                      <ExternalLink size={12} />
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}

          {issuePreview && (
            <div className="mt-2.5 space-y-2 rounded-xl border border-line bg-surface-4 p-3 text-xs">
              <div className="flex items-center justify-between gap-2 font-semibold text-ink">
                <div className="flex min-w-0 items-center gap-2">
                  <GitBranch size={13} className="shrink-0 text-primary" />
                  <span className="truncate font-mono">
                    {issuePreview.owner}/{issuePreview.repo}#{issuePreview.number} · {issuePreview.title}
                  </span>
                </div>
                <button type="button" onClick={() => setIssuePreview(null)} className="shrink-0 text-ink-3 hover:text-ink">
                  {t('common.close')}
                </button>
              </div>
              <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-3 p-2.5 text-xs text-ink-2">
                {issuePreview.body.trim() || t('butler.connectors.issueNoBody')}
              </pre>
              {issuePreview.comments.length > 0 ? (
                <div className="space-y-1">
                  <div className="font-medium text-ink-3">
                    {t('butler.connectors.issueCommentsHeader', { count: issuePreview.comments.length })}
                  </div>
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {issuePreview.comments.map((comment) => (
                      <div key={comment.id} className="rounded bg-surface-3 px-2.5 py-1.5 text-ink-2">
                        <span className="font-medium text-ink">@{comment.author || 'user'}</span>:{' '}
                        <span>{comment.body}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {prDiffPreview && (
            <div className="mt-2.5 rounded-xl border border-line bg-surface-4 p-3">
              <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-ink">
                <span>PR #{prDiffPreview.number} {prDiffPreview.truncated ? t('butler.connectors.diffTruncatedBadge') : ''}</span>
                <button type="button" onClick={() => setPrDiffPreview(null)} className="text-ink-3 hover:text-ink">
                  {t('common.close')}
                </button>
              </div>
              <pre className="max-h-56 overflow-auto text-xs text-ink-2">{prDiffPreview.diff}</pre>
            </div>
          )}
        </div>
      </section>

      {/* Local Browser Inspector */}
      <section className="space-y-3 rounded-2xl border border-line bg-surface-3 p-4 shadow-card">
        <div className="flex items-center gap-2">
          <Globe size={16} className="text-primary" />
          <div>
            <h2 className="text-sm font-semibold text-ink">{t('butler.connectors.browserTitle')}</h2>
            <p className="text-xs text-ink-3">{t('butler.connectors.browserDesc')}</p>
          </div>
        </div>
        <form onSubmit={(e) => void handleInspect(e)} className="flex flex-wrap items-center gap-2">
          <input
            type="url"
            value={inspectUrl}
            onChange={(e) => setInspectUrl(e.target.value)}
            className="h-8 min-w-64 flex-1 rounded-xl border border-line bg-surface-4 px-2.5 font-mono text-xs text-ink outline-none focus:border-primary"
          />
          <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
            <input type="checkbox" checked={allowLan} onChange={(e) => setAllowLan(e.target.checked)} />
            <span>{t('butler.connectors.allowLanHttp')}</span>
          </label>
          <button
            type="submit"
            disabled={inspecting}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {inspecting ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
            <span>{t('butler.connectors.inspectAction')}</span>
          </button>
        </form>
        {inspectResult && (
          <div className="space-y-1.5 rounded-xl border border-line-soft bg-surface-4 p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2 font-semibold text-ink">
              <span>{inspectResult.title || inspectResult.finalUrl}</span>
              <span className="rounded-full bg-fill-2 px-2 py-0.5 text-2xs font-mono text-ink-2">
                HTTP {inspectResult.status} · {inspectResult.durationMs}ms
              </span>
            </div>
            <p className="line-clamp-4 text-ink-2">{inspectResult.textExcerpt}</p>
          </div>
        )}
      </section>
      {roundtableDraft ? (
        <CreateRoomDiscussionDialog
          defaultAi
          defaultName={roundtableDraft.name}
          defaultInitialPrompt={roundtableDraft.initialPrompt}
          defaultWorkspaceRoot={workspaceRoot.trim() || undefined}
          defaultLinkedGithubIssue={roundtableDraft.linkedIssue}
          onCreated={() => {
            useUI.getState().setModule('messages');
          }}
          onClose={() => setRoundtableDraft(null)}
        />
      ) : null}
    </div>
  );
}
