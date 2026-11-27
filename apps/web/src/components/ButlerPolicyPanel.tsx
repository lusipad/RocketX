import { Check, Loader2, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { isTauriRuntime } from '../lib/client';
import {
  butlerPolicyEvaluate,
  butlerPolicyGet,
  butlerPolicySave,
  type ProjectPolicyConfig,
  type ProjectPolicyDecision,
} from '../platform/desktopCommands';
import { toast } from '../stores/toast';

function splitLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function ButlerPolicyPanel({ workspaceRoot }: { workspaceRoot: string }) {
  const { t } = useI18n();
  const desktop = isTauriRuntime();
  const hasWorkspace = Boolean(workspaceRoot.trim());

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [maxAutonomyMode, setMaxAutonomyMode] = useState<'readonly' | 'confirm' | 'autonomous'>('confirm');
  const [requireExternal, setRequireExternal] = useState(true);
  const [allowNetworkTools, setAllowNetworkTools] = useState(true);
  const [allowedCmdsText, setAllowedCmdsText] = useState('');
  const [deniedCmdsText, setDeniedCmdsText] = useState('');
  const [allowedPathsText, setAllowedPathsText] = useState('');
  const [deniedPathsText, setDeniedPathsText] = useState('');

  const [simKind, setSimKind] = useState<'command' | 'file_read' | 'file_write' | 'network' | 'external'>('command');
  const [simTarget, setSimTarget] = useState('');
  const [simResult, setSimResult] = useState<ProjectPolicyDecision | null>(null);

  const loadPolicy = useCallback(async () => {
    if (!desktop || !hasWorkspace) return;
    setLoading(true);
    try {
      const p = await butlerPolicyGet(workspaceRoot);
      setMaxAutonomyMode(
        p.maxAutonomyMode === 'readonly' || p.maxAutonomyMode === 'autonomous'
          ? p.maxAutonomyMode
          : 'confirm',
      );
      setRequireExternal(p.requireApprovalForExternal);
      setAllowNetworkTools(p.allowNetworkTools);
      setAllowedCmdsText(p.allowedCommands.join('\n'));
      setDeniedCmdsText(p.deniedCommands.join('\n'));
      setAllowedPathsText(p.allowedPaths.join('\n'));
      setDeniedPathsText(p.deniedPaths.join('\n'));
    } catch (error) {
      toast.error(error, t('butler.policy.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [desktop, hasWorkspace, t, workspaceRoot]);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!desktop || !hasWorkspace) return;
    setSaving(true);
    try {
      const payload: ProjectPolicyConfig = {
        version: 1,
        maxAutonomyMode,
        requireApprovalForExternal: requireExternal,
        allowNetworkTools,
        allowedCommands: splitLines(allowedCmdsText),
        deniedCommands: splitLines(deniedCmdsText),
        allowedPaths: splitLines(allowedPathsText),
        deniedPaths: splitLines(deniedPathsText),
      };
      await butlerPolicySave(workspaceRoot, payload);
      toast.success(t('butler.policy.savedToast'));
    } catch (error) {
      toast.error(error, t('butler.policy.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleEvaluate = async (event: FormEvent) => {
    event.preventDefault();
    if (!desktop || !simTarget.trim()) return;
    try {
      const decision = await butlerPolicyEvaluate({
        workspaceRoot,
        actionKind: simKind,
        target: simTarget.trim(),
      });
      setSimResult(decision);
    } catch (error) {
      toast.error(error, t('butler.policy.evalFailed'));
    }
  };

  if (!desktop || !hasWorkspace) {
    return (
      <div className="rounded-2xl border border-dashed border-line bg-surface-3 p-6 text-center text-xs text-ink-3">
        {t('butler.policy.workspaceRequired')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => void handleSave(e)}
        className="space-y-4 rounded-2xl border border-line bg-surface-3 p-4 shadow-card"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-primary" />
            <div>
              <h2 className="text-sm font-semibold text-ink">{t('butler.policy.title')}</h2>
              <p className="text-xs text-ink-3">{t('butler.policy.subtitle')}</p>
            </div>
          </div>
          <button
            type="submit"
            disabled={saving || loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            <span>{t('common.save')}</span>
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-xs">
            <span className="font-medium text-ink-2">{t('butler.policy.maxAutonomy')}</span>
            <select
              value={maxAutonomyMode}
              onChange={(e) => setMaxAutonomyMode(e.target.value as 'readonly' | 'confirm' | 'autonomous')}
              className="h-8 w-full rounded-xl border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
            >
              <option value="readonly">{t('butler.policy.autonomy.readonly')}</option>
              <option value="confirm">{t('butler.policy.autonomy.confirm')}</option>
              <option value="autonomous">{t('butler.policy.autonomy.autonomous')}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs text-ink">
            <input
              type="checkbox"
              checked={requireExternal}
              onChange={(e) => setRequireExternal(e.target.checked)}
            />
            <span>{t('butler.policy.requireExternalApproval')}</span>
          </label>
          <label className="flex items-center gap-2 rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs text-ink">
            <input
              type="checkbox"
              checked={allowNetworkTools}
              onChange={(e) => setAllowNetworkTools(e.target.checked)}
            />
            <span>{t('butler.policy.allowNetworkTools')}</span>
          </label>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="font-medium text-ink-2">{t('butler.policy.allowedCommands')}</span>
            <textarea
              rows={3}
              value={allowedCmdsText}
              onChange={(e) => setAllowedCmdsText(e.target.value)}
              placeholder={'pnpm test\ncargo check'}
              className="w-full rounded-xl border border-line bg-surface-4 p-2 font-mono text-xs text-ink outline-none focus:border-primary"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium text-ink-2">{t('butler.policy.deniedCommands')}</span>
            <textarea
              rows={3}
              value={deniedCmdsText}
              onChange={(e) => setDeniedCmdsText(e.target.value)}
              placeholder={'git push --force\nrm -rf /'}
              className="w-full rounded-xl border border-line bg-surface-4 p-2 font-mono text-xs text-ink outline-none focus:border-primary"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium text-ink-2">{t('butler.policy.allowedPaths')}</span>
            <textarea
              rows={3}
              value={allowedPathsText}
              onChange={(e) => setAllowedPathsText(e.target.value)}
              placeholder={t('butler.policy.allowedPathsPlaceholder')}
              className="w-full rounded-xl border border-line bg-surface-4 p-2 font-mono text-xs text-ink outline-none focus:border-primary"
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="font-medium text-ink-2">{t('butler.policy.deniedPaths')}</span>
            <textarea
              rows={3}
              value={deniedPathsText}
              onChange={(e) => setDeniedPathsText(e.target.value)}
              placeholder={'.env\n**/.ssh/**'}
              className="w-full rounded-xl border border-line bg-surface-4 p-2 font-mono text-xs text-ink outline-none focus:border-primary"
            />
          </label>
        </div>
      </form>

      {/* Policy Simulator */}
      <form
        onSubmit={(e) => void handleEvaluate(e)}
        className="space-y-2.5 rounded-2xl border border-line bg-surface-3 p-4 shadow-card"
      >
        <h3 className="text-xs font-semibold text-ink">{t('butler.policy.simulatorTitle')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={simKind}
            onChange={(e) => setSimKind(e.target.value as typeof simKind)}
            className="h-8 rounded-xl border border-line bg-surface-4 px-2 text-xs text-ink outline-none focus:border-primary"
          >
            <option value="command">{t('butler.policy.actionKind.command')}</option>
            <option value="file_read">{t('butler.policy.actionKind.file_read')}</option>
            <option value="file_write">{t('butler.policy.actionKind.file_write')}</option>
            <option value="network">{t('butler.policy.actionKind.network')}</option>
            <option value="external">{t('butler.policy.actionKind.external')}</option>
          </select>
          <input
            type="text"
            value={simTarget}
            onChange={(e) => setSimTarget(e.target.value)}
            placeholder={t('butler.policy.simulatorPlaceholder')}
            className="h-8 min-w-60 flex-1 rounded-xl border border-line bg-surface-4 px-2.5 font-mono text-xs text-ink outline-none focus:border-primary"
          />
          <button
            type="submit"
            className="h-8 rounded-xl border border-primary/30 bg-primary/10 px-3 text-xs font-medium text-primary hover:bg-primary/20"
          >
            {t('butler.policy.evaluateAction')}
          </button>
        </div>
        {simResult && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-soft bg-surface-4 px-3 py-2 text-xs">
            <span
              className={`rounded-full px-2 py-0.5 text-2xs font-medium ${
                simResult.verdict === 'allow'
                  ? 'bg-success/15 text-success'
                  : simResult.verdict === 'deny'
                    ? 'bg-danger/15 text-danger'
                    : 'bg-warning/15 text-warning'
              }`}
            >
              {simResult.verdict === 'allow'
                ? t('butler.policy.verdict.allow')
                : simResult.verdict === 'deny'
                  ? t('butler.policy.verdict.deny')
                  : t('butler.policy.verdict.confirm')}
            </span>
            <span className="text-ink">{simResult.reason}</span>
            {simResult.matchedRule && (
              <code className="rounded bg-fill-1 px-1.5 py-0.5 text-ink-3">{simResult.matchedRule}</code>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
