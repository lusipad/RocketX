import {
  Activity,
  Check,
  KeyRound,
  Loader2,
  Plus,
  Server,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n';
import { isTauriRuntime } from '../lib/client';
import {
  butlerMcpDelete,
  butlerMcpHealthCheck,
  butlerMcpList,
  butlerMcpUpsert,
  type ButlerMcpHealthCheckResult,
  type ButlerMcpServerView,
} from '../platform/desktopCommands';
import { toast } from '../stores/toast';

function parseEnvLines(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

export default function ButlerMcpHubPanel({ workspaceRoot }: { workspaceRoot?: string }) {
  const { t } = useI18n();
  const desktop = isTauriRuntime();
  const [servers, setServers] = useState<ButlerMcpServerView[]>([]);
  const [loading, setLoading] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [argsText, setArgsText] = useState('');
  const [scope, setScope] = useState<'global' | 'workspace'>('global');
  const [publicEnvText, setPublicEnvText] = useState('');
  const [secretEnvText, setSecretEnvText] = useState('');
  const [saving, setSaving] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [healthMap, setHealthMap] = useState<Record<string, ButlerMcpHealthCheckResult>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadServers = useCallback(async () => {
    if (!desktop) return;
    setLoading(true);
    try {
      const list = await butlerMcpList(workspaceRoot?.trim() || null);
      setServers(list);
    } catch (error) {
      toast.error(error, t('butler.mcpHub.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [desktop, t, workspaceRoot]);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const openCreate = () => {
    setEditingId(undefined);
    setName('');
    setCommand('');
    setArgsText('');
    setScope('global');
    setPublicEnvText('');
    setSecretEnvText('');
    setFormOpen(true);
  };

  const openEdit = (server: ButlerMcpServerView) => {
    setEditingId(server.id);
    setName(server.name);
    setCommand(server.command);
    setArgsText(server.args.join('\n'));
    setScope(server.scope === 'workspace' ? 'workspace' : 'global');
    setPublicEnvText(
      Object.entries(server.publicEnv)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    );
    setSecretEnvText('');
    setFormOpen(true);
  };

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !command.trim()) {
      toast.error(t('butler.mcpHub.validationRequired'));
      return;
    }
    setSaving(true);
    try {
      const args = argsText
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const saved = await butlerMcpUpsert({
        id: editingId ?? null,
        name: name.trim(),
        command: command.trim(),
        args,
        scope,
        workspaceRoot: scope === 'workspace' ? workspaceRoot?.trim() || null : null,
        publicEnv: parseEnvLines(publicEnvText),
        secretEnv: parseEnvLines(secretEnvText),
      });
      setServers((prev) => [saved, ...prev.filter((s) => s.id !== saved.id)]);
      setFormOpen(false);
      toast.success(t('butler.mcpHub.savedToast'));
    } catch (error) {
      toast.error(error, t('butler.mcpHub.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggleEnabled = async (server: ButlerMcpServerView) => {
    try {
      const updated = await butlerMcpUpsert({
        id: server.id,
        name: server.name,
        command: server.command,
        args: server.args,
        publicEnv: server.publicEnv,
        scope: server.scope === 'workspace' ? 'workspace' : 'global',
        workspaceRoot: server.workspaceRoot,
        enabled: !server.enabled,
      });
      setServers((prev) => prev.map((s) => (s.id === server.id ? updated : s)));
    } catch (error) {
      toast.error(error, t('butler.mcpHub.saveFailed'));
    }
  };

  const handleHealthCheck = async (id: string) => {
    setCheckingId(id);
    try {
      const res = await butlerMcpHealthCheck(id);
      setHealthMap((prev) => ({ ...prev, [id]: res }));
      if (res.ok) {
        toast.success(t('butler.mcpHub.healthOkToast', { count: res.toolCount, ms: res.latencyMs }));
      } else {
        toast.error(res.error || t('butler.mcpHub.healthFailToast'));
      }
    } catch (error) {
      toast.error(error, t('butler.mcpHub.healthFailToast'));
    } finally {
      setCheckingId(null);
    }
  };

  if (!desktop) {
    return (
      <div className="rounded-2xl border border-dashed border-line bg-surface-3 p-6 text-center text-xs text-ink-3">
        {t('butler.mcpHub.desktopOnly')}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-line bg-surface-3 p-3.5 shadow-raise">
        <div>
          <h2 className="text-sm font-semibold text-ink">{t('butler.mcpHub.title')}</h2>
          <p className="mt-0.5 text-xs text-ink-3">{t('butler.mcpHub.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-medium text-white shadow-raise hover:bg-primary-hover"
        >
          <Plus size={13} />
          <span>{t('butler.mcpHub.addServer')}</span>
        </button>
      </div>

      {formOpen && (
        <form
          onSubmit={(e) => void handleSave(e)}
          className="space-y-3 rounded-2xl border border-primary/40 bg-surface-4 p-4 shadow-card"
        >
          <div className="flex items-center justify-between border-b border-line-soft pb-2">
            <span className="text-xs font-semibold text-ink">
              {t(editingId ? 'butler.mcpHub.editTitle' : 'butler.mcpHub.addServer')}
            </span>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="rounded p-1 text-ink-3 hover:text-ink"
              aria-label={t('common.close')}
            >
              <X size={14} />
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs">
              <span className="font-medium text-ink-2">{t('butler.mcpHub.fieldName')}</span>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('butler.mcpHub.placeholderName')}
                className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2.5 text-xs text-ink outline-none focus:border-primary"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-medium text-ink-2">{t('butler.mcpHub.fieldScope')}</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as 'global' | 'workspace')}
                className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2 text-xs text-ink outline-none focus:border-primary"
              >
                <option value="global">{t('butler.mcpHub.scopeGlobal')}</option>
                <option value="workspace" disabled={!workspaceRoot?.trim()}>
                  {t('butler.mcpHub.scopeWorkspace')}
                </option>
              </select>
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-medium text-ink-2">{t('butler.mcpHub.fieldCommand')}</span>
              <input
                type="text"
                required
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder={t('butler.mcpHub.placeholderCommand')}
                className="h-8 w-full rounded-xl border border-line bg-surface-3 px-2.5 font-mono text-xs text-ink outline-none focus:border-primary"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-medium text-ink-2">{t('butler.mcpHub.fieldArgs')}</span>
              <textarea
                rows={2}
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                className="w-full rounded-xl border border-line bg-surface-3 p-2 font-mono text-xs text-ink outline-none focus:border-primary"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-medium text-ink-2">{t('butler.mcpHub.fieldPublicEnv')}</span>
              <textarea
                rows={2}
                value={publicEnvText}
                onChange={(e) => setPublicEnvText(e.target.value)}
                placeholder={t('butler.mcpHub.placeholderPublicEnv')}
                className="w-full rounded-xl border border-line bg-surface-3 p-2 font-mono text-xs text-ink outline-none focus:border-primary"
              />
            </label>
            <label className="space-y-1 text-xs">
              <span className="font-medium text-ink-2">{t('butler.mcpHub.fieldSecretEnv')}</span>
              <textarea
                rows={2}
                value={secretEnvText}
                onChange={(e) => setSecretEnvText(e.target.value)}
                placeholder={t('butler.mcpHub.placeholderSecretEnv')}
                className="w-full rounded-xl border border-line bg-surface-3 p-2 font-mono text-xs text-ink outline-none focus:border-primary"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="rounded-xl border border-line bg-surface-3 px-3 py-1.5 text-xs text-ink-2 hover:text-ink"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-xl bg-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              <span>{t('common.save')}</span>
            </button>
          </div>
        </form>
      )}

      {loading && servers.length === 0 ? (
        <div className="flex h-36 items-center justify-center rounded-2xl border border-line bg-surface-3 text-xs text-ink-3">
          <Loader2 size={14} className="mr-2 animate-spin" />
          <span>{t('common.loading')}</span>
        </div>
      ) : servers.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-surface-3 p-6 text-center">
          <Server size={22} className="mb-2 text-ink-3 opacity-50" />
          <div className="text-xs font-medium text-ink">{t('butler.mcpHub.emptyTitle')}</div>
          <p className="mt-1 text-xs text-ink-3">{t('butler.mcpHub.emptyDesc')}</p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {servers.map((server) => {
            const health = healthMap[server.id];
            const checking = checkingId === server.id;
            return (
              <article
                key={server.id}
                className="flex flex-col justify-between rounded-2xl border border-line bg-surface-3 p-4 shadow-card"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <h3 className="truncate text-sm font-semibold text-ink">{server.name}</h3>
                        <span className="rounded-full bg-fill-2 px-2 py-0.5 text-2xs font-mono text-ink-2">
                          {server.id}
                        </span>
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs text-primary">
                          {server.scope}
                        </span>
                      </div>
                      <code className="mt-1.5 block truncate rounded-lg bg-surface-4 px-2 py-1 text-xs text-ink-2">
                        {[server.command, ...server.args].join(' ')}
                      </code>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={server.enabled}
                      onClick={() => void handleToggleEnabled(server)}
                      className={`inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium transition ${
                        server.enabled
                          ? 'border-success/40 bg-success/15 text-success'
                          : 'border-line bg-surface-4 text-ink-3'
                      }`}
                    >
                      {server.enabled ? t('common.enabled') : t('common.disabled')}
                    </button>
                  </div>

                  {server.secretEnvKeys.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {server.secretEnvKeys.map((key) => (
                        <span
                          key={key}
                          className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-2xs text-warning"
                        >
                          <KeyRound size={10} />
                          {key}
                        </span>
                      ))}
                    </div>
                  )}

                  {health && (
                    <div
                      className={`mt-2.5 rounded-xl border p-2 text-xs ${
                        health.ok
                          ? 'border-success/30 bg-success/10 text-success'
                          : 'border-danger/30 bg-danger/10 text-danger'
                      }`}
                    >
                      {health.ok
                        ? t('butler.mcpHub.healthOkToast', { count: health.toolCount, ms: health.latencyMs })
                        : health.error || t('butler.mcpHub.healthFailToast')}
                      {health.tools.length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {health.tools.slice(0, 6).map((toolName) => (
                            <span key={toolName} className="rounded bg-surface-4 px-1.5 py-0.5 font-mono text-xs text-ink">
                              {toolName}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-2.5">
                  <button
                    type="button"
                    disabled={checking}
                    onClick={() => void handleHealthCheck(server.id)}
                    className="inline-flex items-center gap-1 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
                  >
                    {checking ? <Loader2 size={11} className="animate-spin" /> : <Activity size={11} />}
                    <span>{t('butler.mcpHub.healthCheck')}</span>
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openEdit(server)}
                      className="rounded-lg border border-line bg-surface-4 px-2 py-1 text-xs text-ink-2 hover:text-ink"
                    >
                      {t('common.edit')}
                    </button>
                    {confirmDeleteId === server.id ? (
                      <button
                        type="button"
                        onClick={() => {
                          void butlerMcpDelete(server.id).then(() => {
                            setServers((prev) => prev.filter((s) => s.id !== server.id));
                            setConfirmDeleteId(null);
                            toast.info(t('butler.mcpHub.deletedToast'));
                          });
                        }}
                        className="rounded-lg bg-danger px-2 py-1 text-xs font-medium text-white"
                      >
                        {t('common.confirm')}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(server.id)}
                        aria-label={t('common.delete')}
                        className="rounded-lg p-1 text-ink-3 hover:bg-danger/10 hover:text-danger"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
