import { useMemo, useRef, useState } from 'react';
import { FileUp, Globe, Loader2 } from 'lucide-react';
import Dialog from './Dialog';
import { toast } from '../stores/toast';
import { getServerBase, setServerBase } from '../lib/client';
import { ADO_WEB_KEY, adoWebBase, loadWorkbenchConfig } from '../lib/ado';
import { useWorkbench } from '../stores/workbench';
import { useWiTemplates } from '../stores/wiTemplates';
import { loadUpdateSource, saveUpdateSource } from '../lib/updateSource';
import { loadHierarchyLayout, saveHierarchyLayout } from '../stores/wiTemplates';
import { useAuth } from '../stores/auth';
import { useAliases } from '../stores/aliases';
import {
  fetchWorkspaceConfigFromSource,
  parseWorkspaceConfigRemoteInput,
  remoteWorkspaceConfigSource,
  type WorkspaceConfigRemoteSource,
} from '../lib/workspaceConfigSource';
import {
  adoConnectionChanged,
  inlineWorkItemTemplatesFingerprint,
  loadWorkspaceSource,
  mergeAppliedFields,
  parseWorkspaceConfig,
  planWorkspaceFields,
  saveWorkspaceSource,
  updateSourceFingerprint,
  type WorkspaceConfig,
  type WorkspaceCurrentValues,
  type WorkspaceField,
} from '../lib/workspaceConfig';
import { useI18n, useT, type MessageKey } from '../i18n';
import { formatDateTime } from '../i18n/format';

const ADO_AUTH_LABEL_KEYS: Record<'ntlm' | 'pat' | 'bearer' | 'none', MessageKey> = {
  ntlm: 'settings.workspace.adoAuth.ntlm',
  pat: 'settings.workspace.adoAuth.pat',
  bearer: 'settings.workspace.adoAuth.bearer',
  none: 'settings.workspace.adoAuth.none',
};

const WORKSPACE_FIELD_LABEL_KEYS: Record<string, MessageKey> = {
  'server.url': 'settings.workspace.field.serverUrl',
  'ado.base': 'settings.workspace.field.adoBase',
  'ado.auth': 'settings.workspace.field.adoAuth',
  'ado.webUrl': 'settings.workspace.field.adoWebUrl',
  'templates.url': 'settings.workspace.field.templatesUrl',
  'templates.inline': 'settings.workspace.field.templatesInline',
  'update.source': 'settings.workspace.field.updateSource',
  'workItems.hierarchyLayout': 'settings.workspace.field.hierarchyLayout',
  aliases: 'settings.workspace.field.aliases',
};

/**
 * 团队配置导入（issue #67）。
 * 配置文件提供默认值；用户自己改过的字段默认保留本地值（仍可勾选强制覆盖），
 * 其余字段跟随配置。凭据不在配置文件里。
 */

export function collectCurrentValues(): WorkspaceCurrentValues {
  const workbench = loadWorkbenchConfig();
  const templateState = useWiTemplates.getState();
  return {
    serverUrl: getServerBase(),
    adoBase: workbench?.adoBase ?? '',
    adoAuth: workbench?.auth ?? '',
    adoWebUrl: adoWebBase() ?? '',
    templatesUrl: templateState.url,
    templatesInline: !templateState.url && templateState.remote
      ? inlineWorkItemTemplatesFingerprint(templateState.remote)
      : '',
    updateSource: updateSourceFingerprint(loadUpdateSource()),
    hierarchyLayout: loadHierarchyLayout(),
    aliases: JSON.stringify(useAliases.getState().aliases, Object.keys(useAliases.getState().aliases).sort()),
  };
}

async function applySelectedFields(
  config: WorkspaceConfig,
  fields: WorkspaceField[],
  selected: ReadonlySet<string>,
  source?: WorkspaceConfigRemoteSource,
): Promise<number> {
  const applied: Record<string, string> = {};
  for (const field of fields) {
    if (selected.has(field.key)) applied[field.key] = field.incoming;
  }

  const serverChanged = selected.has('server.url')
    && !!config.rocketChat
    && getServerBase() !== config.rocketChat.url;
  const wasAuthed = serverChanged && useAuth.getState().status === 'authed';
  if (wasAuthed) useAuth.getState().handleAuthLost();
  if (selected.has('server.url') && config.rocketChat) {
    setServerBase(config.rocketChat.url);
  }

  const adoTouched = ['ado.base', 'ado.auth'].some((key) => selected.has(key));
  if (adoTouched) {
    const existing = loadWorkbenchConfig();
    const nextBase = selected.has('ado.base') && config.ado?.url
      ? config.ado.url
      : existing?.adoBase;
    const nextAuth = selected.has('ado.auth') && config.ado?.auth
      ? config.ado.auth
      : existing?.auth;
    const connectionChanged = adoConnectionChanged(existing ?? undefined, {
      adoBase: nextBase,
      auth: nextAuth,
    });
    useWorkbench.getState().setConfig({
      adoBase: nextBase,
      pat: connectionChanged ? undefined : existing?.pat,
      auth: nextAuth,
      account: existing?.account ?? '',
    });
  }

  if (selected.has('ado.webUrl')) {
    const webUrl = config.ado?.webUrl ?? config.ado?.url;
    if (webUrl) {
      try {
        localStorage.setItem(ADO_WEB_KEY, webUrl);
      } catch {
        /* 存储不可用时跳过 */
      }
    }
  }

  if (selected.has('templates.url') && config.workItemTemplates && 'url' in config.workItemTemplates) {
    useWiTemplates.getState().setUrl(config.workItemTemplates.url);
  }
  if (selected.has('templates.inline') && config.workItemTemplates && 'templates' in config.workItemTemplates) {
    useWiTemplates.getState().setInline(config.workItemTemplates);
  }

  if (selected.has('update.source') && config.update) {
    saveUpdateSource({ kind: config.update.source, location: config.update.location ?? '' });
  }

  if (selected.has('workItems.hierarchyLayout') && config.workItems?.hierarchyLayout) {
    saveHierarchyLayout(config.workItems.hierarchyLayout);
  }

  if (selected.has('aliases') && config.aliases) {
    await useAliases.getState().applySharedAliases(config.aliases);
  }

  const importedAt = Date.now();
  saveWorkspaceSource(
    mergeAppliedFields(
      loadWorkspaceSource(),
      {
        ...(source?.kind === 'url' ? { url: source.url, sourceKind: 'url' as const, checkedAt: importedAt } : {}),
        ...(source?.kind === 'ado' ? { sourceKind: 'ado' as const, ado: source.ado, checkedAt: importedAt } : {}),
        ...(source?.kind === 'unc' ? { sourceKind: 'unc' as const, uncPath: source.path, checkedAt: importedAt } : {}),
        ...(source ? {} : { sourceKind: 'file' as const }),
        name: config.name,
        importedAt,
      },
      applied,
    ),
  );
  if (wasAuthed) queueMicrotask(() => location.reload());
  return Object.keys(applied).length;
}

/** 首次加入团队时应用所有默认选中的字段；已有本地覆盖仍按团队配置规则保留。 */
export function applyWorkspaceConfigDefaults(config: WorkspaceConfig, sourceUrl?: string): Promise<number> {
  const fields = planWorkspaceFields(
    config,
    collectCurrentValues(),
    loadWorkspaceSource()?.applied ?? {},
  );
  const selected = new Set(fields.filter((field) => field.selected).map((field) => field.key));
  return applySelectedFields(
    config,
    fields,
    selected,
    sourceUrl ? { kind: 'url', url: sourceUrl } : undefined,
  );
}

function FieldRow({
  field,
  checked,
  onToggle,
}: {
  field: WorkspaceField;
  checked: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const labelKey = WORKSPACE_FIELD_LABEL_KEYS[field.key];
  const fieldLabel = labelKey ? t(labelKey) : field.label;

  return (
    <label
      className={`flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0 ${
        field.unchanged ? 'opacity-60' : 'cursor-pointer hover:bg-fill-2'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={field.unchanged}
        onChange={onToggle}
        className="mt-1 accent-[var(--color-primary,#3370ff)]"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-ink">{fieldLabel}</span>
          {field.unchanged ? (
            <span className="rounded bg-fill-2 px-1.5 py-0.5 text-xs text-ink-3">
              {t('settings.workspace.fieldUnchanged')}
            </span>
          ) : field.overridden ? (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
              {t('settings.workspace.fieldOverridden')}
            </span>
          ) : (
            <span className="rounded bg-primary-light px-1.5 py-0.5 text-xs text-primary">
              {field.current ? t('settings.workspace.fieldWillUpdate') : t('settings.workspace.fieldWillWrite')}
            </span>
          )}
        </div>
        {!field.unchanged && (
          <div className="mt-1 space-y-0.5 font-mono text-xs break-all text-ink-3">
            {field.current && <div className="line-through">{field.current}</div>}
            <div className="text-ink-2">{field.incoming}</div>
          </div>
        )}
      </div>
    </label>
  );
}

export function ImportPreviewDialog({
  config,
  source,
  onApplied,
  onClose,
}: {
  config: WorkspaceConfig;
  source?: WorkspaceConfigRemoteSource;
  onApplied: () => void;
  onClose: () => void;
}) {
  const { t, tp } = useI18n();
  const fields = useMemo(() => {
    const lastApplied = loadWorkspaceSource()?.applied ?? {};
    return planWorkspaceFields(config, collectCurrentValues(), lastApplied);
  }, [config]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(fields.filter((field) => field.selected).map((field) => field.key)),
  );

  const toggle = (key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const apply = async () => {
    try {
      const count = await applySelectedFields(config, fields, selected, source);
      toast.success(
        count > 0
          ? tp(count, 'settings.workspace.appliedOne', 'settings.workspace.appliedOther', { count })
          : t('settings.workspace.nothingToApply'),
      );
      onApplied();
    } catch (err) {
      toast.error(err, t('settings.workspace.applyFailed'));
    }
    onClose();
  };

  return (
    <Dialog
      title={config.name ? t('settings.workspace.importNamedTitle', { name: config.name }) : t('settings.workspace.importTitle')}
      hint={t('settings.workspace.importHint')}
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void apply()}
            disabled={selected.size === 0}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {tp(selected.size, 'settings.workspace.applySelectedOne', 'settings.workspace.applySelectedOther', {
              count: selected.size,
            })}
          </button>
        </>
      }
    >
      <div className="px-5 pb-2">
        {fields.length === 0 ? (
          <div className="py-8 text-center text-sm text-ink-3">{t('settings.workspace.noRecognizedFields')}</div>
        ) : (
          <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-line">
            {fields.map((field) => (
              <FieldRow
                key={field.key}
                field={field}
                checked={selected.has(field.key)}
                onToggle={() => toggle(field.key)}
              />
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** 设置页「团队配置」分区：从 URL / 文件导入配置，之后可一键重新同步 */
export function WorkspaceConfigSection() {
  const t = useT();
  const [source, setSource] = useState(() => loadWorkspaceSource());
  const [sourceInput, setSourceInput] = useState(
    source?.kind === 'url' ? source.url : source?.kind === 'unc' ? source.path : '',
  );
  const [adoProject, setAdoProject] = useState(source?.kind === 'ado' ? source.ado.project : '');
  const [adoRepository, setAdoRepository] = useState(source?.kind === 'ado' ? source.ado.repository : '');
  const [adoRef, setAdoRef] = useState(source?.kind === 'ado' ? source.ado.ref : 'refs/heads/main');
  const [adoPath, setAdoPath] = useState(source?.kind === 'ado' ? source.ado.path : '/config/rcx.workspace.json');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ config: WorkspaceConfig; source?: WorkspaceConfigRemoteSource } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const workbenchConfig = useWorkbench((state) => state.config);
  const adoConnectionLabel = workbenchConfig?.adoBase
    ? `${workbenchConfig.adoBase} · ${t(ADO_AUTH_LABEL_KEYS[workbenchConfig.auth ?? 'pat'])}`
    : t('settings.workspace.adoNotConfigured');
  const missingAdoFields = [
    [t('settings.workspace.adoProjectField'), adoProject],
    [t('settings.workspace.adoRepositoryField'), adoRepository],
    [t('settings.workspace.adoRefField'), adoRef],
    [t('settings.workspace.adoPathField'), adoPath],
  ].filter(([, value]) => !value.trim()).map(([label]) => label);

  const importText = (text: string, remoteSource?: WorkspaceConfigRemoteSource) => {
    try {
      setPreview({ config: parseWorkspaceConfig(text), source: remoteSource });
    } catch (err) {
      toast.error(err, t('settings.workspace.cannotImport'));
    }
  };

  const fetchFromRemoteSource = async (remoteSource: WorkspaceConfigRemoteSource) => {
    if (remoteSource.kind === 'ado') {
      setAdoProject(remoteSource.ado.project);
      setAdoRepository(remoteSource.ado.repository);
      setAdoRef(remoteSource.ado.ref);
      setAdoPath(remoteSource.ado.path);
    }
    setLoading(true);
    try {
      const result = await fetchWorkspaceConfigFromSource(remoteSource);
      setPreview(result);
    } catch (err) {
      toast.error(err, t('settings.workspace.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const fetchFromSourceInput = async (target: string) => {
    try {
      const remoteSource = parseWorkspaceConfigRemoteInput(target, workbenchConfig ?? null);
      await fetchFromRemoteSource(remoteSource);
    } catch (err) {
      toast.error(err, t('settings.workspace.invalidSource'));
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    importText(await file.text());
  };

  return (
    <>
      <h2 className="text-base font-semibold text-ink">{t('settings.workspace.sourceHeading')}</h2>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-3">
        {t('settings.workspace.sourceDescription')}
      </p>

      {source && (
        <div className="mt-3 max-w-2xl rounded-lg border border-line bg-fill-1 px-3 py-2.5 text-xs text-ink-2">
          <div>
            {t('settings.workspace.lastImported', {
              name: source.name || t('settings.workspace.unnamedConfig'),
              time: formatDateTime(source.importedAt),
            })}
          </div>
          {source.kind === 'url' && (
            <div className="mt-0.5 truncate font-mono text-xs text-ink-3">{source.url}</div>
          )}
          {source.kind === 'ado' && (
            <>
              <div className="mt-0.5 truncate font-mono text-xs text-ink-3">
                {source.ado.project} / {source.ado.repository} @ {source.ado.ref}
              </div>
              <div className="mt-0.5 truncate font-mono text-xs text-ink-3">{source.ado.path}</div>
            </>
          )}
          {source.kind === 'unc' && (
            <div className="mt-0.5 truncate font-mono text-xs text-ink-3">{source.path}</div>
          )}
          {(source.kind === 'url' || source.kind === 'ado' || source.kind === 'unc') && (
            <label className="mt-2 flex cursor-pointer items-center gap-2">
              <input
                type="checkbox"
                checked={source.follow !== false}
                onChange={(e) => {
                  const next = { ...source, follow: e.target.checked };
                  saveWorkspaceSource(next);
                  setSource(next);
                }}
                className="accent-[var(--color-primary,#3370ff)]"
              />
              <span>{t('settings.workspace.autoCheckUpdates')}</span>
            </label>
          )}
          {(source.kind === 'url' || source.kind === 'ado' || source.kind === 'unc') && (
            <button
              onClick={() => {
                const remoteSource = remoteWorkspaceConfigSource(source);
                if (remoteSource) void fetchFromRemoteSource(remoteSource);
              }}
              disabled={loading}
              className="mt-2 flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
              {t('settings.workspace.reloadCurrentSource')}
            </button>
          )}
        </div>
      )}

      <div className="mt-3 flex max-w-2xl gap-2">
        <input
          aria-label={t('settings.workspace.sourceInputAriaLabel')}
          value={sourceInput}
          onChange={(e) => setSourceInput(e.target.value)}
          placeholder={t('settings.workspace.sourceInputPlaceholder')}
          className="h-9 flex-1 rounded-md border border-line bg-surface-4 px-3 text-sm text-ink outline-none focus:border-primary"
        />
        <button
          onClick={() => sourceInput.trim() && void fetchFromSourceInput(sourceInput.trim())}
          disabled={loading || !sourceInput.trim()}
          className="flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-white transition hover:bg-primary-hover disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
          {t('settings.workspace.loadAction')}
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-ink-2 transition hover:bg-fill-hover"
        >
          <FileUp size={14} />
          {t('settings.workspace.chooseFileAction')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      <div className="mt-4 max-w-2xl rounded-lg border border-line bg-surface-4 px-4 py-3">
        <div className="text-sm font-medium text-ink">{t('settings.workspace.fromAdoHeading')}</div>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">
          {t('settings.workspace.fromAdoDescription')}
        </p>
        <div className="mt-1 text-xs text-ink-3">{adoConnectionLabel}</div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            aria-label={t('settings.workspace.adoProjectAriaLabel')}
            value={adoProject}
            onChange={(event) => setAdoProject(event.target.value)}
            placeholder={t('settings.workspace.adoProjectPlaceholder')}
            className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
          <input
            aria-label={t('settings.workspace.adoRepoAriaLabel')}
            value={adoRepository}
            onChange={(event) => setAdoRepository(event.target.value)}
            placeholder={t('settings.workspace.adoRepoPlaceholder')}
            className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
          <input
            aria-label={t('settings.workspace.adoRefAriaLabel')}
            value={adoRef}
            onChange={(event) => setAdoRef(event.target.value)}
            placeholder="refs/heads/main"
            className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
          <input
            aria-label={t('settings.workspace.adoPathAriaLabel')}
            value={adoPath}
            onChange={(event) => setAdoPath(event.target.value)}
            placeholder="/config/rcx.workspace.json"
            className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
        </div>
        {missingAdoFields.length > 0 ? (
          <p className="mt-2 text-xs text-warning">
            {t('settings.workspace.missingAdoFields', {
              fields: missingAdoFields.join(t('settings.common.listSeparator')),
            })}
          </p>
        ) : null}
        <button
          onClick={() =>
            void fetchFromRemoteSource({
              kind: 'ado',
              ado: {
                project: adoProject,
                repository: adoRepository,
                ref: adoRef,
                path: adoPath,
              },
            })}
          disabled={
            loading
            || !adoProject.trim()
            || !adoRepository.trim()
            || !adoRef.trim()
            || !adoPath.trim()
          }
          className="mt-3 flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-white transition hover:bg-primary-hover disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
          {t('settings.workspace.loadFromAdoAction')}
        </button>
      </div>

      {preview && (
        <ImportPreviewDialog
          config={preview.config}
          source={preview.source}
          onApplied={() => setSource(loadWorkspaceSource())}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
