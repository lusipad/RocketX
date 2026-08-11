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
import {
  fetchWorkspaceConfigFromSource,
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

const ADO_AUTH_LABELS: Record<'ntlm' | 'pat' | 'bearer' | 'none', string> = {
  ntlm: 'Windows 集成认证',
  pat: 'PAT（Basic）',
  bearer: 'Bearer Token',
  none: '不带凭据',
};

/**
 * 工作区配置导入（issue #67）。
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

  const importedAt = Date.now();
  saveWorkspaceSource(
    mergeAppliedFields(
      loadWorkspaceSource(),
      {
        ...(source?.kind === 'url' ? { url: source.url, sourceKind: 'url' as const, checkedAt: importedAt } : {}),
        ...(source?.kind === 'ado' ? { sourceKind: 'ado' as const, ado: source.ado, checkedAt: importedAt } : {}),
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
          <span className="text-sm text-ink">{field.label}</span>
          {field.unchanged ? (
            <span className="rounded bg-fill-2 px-1.5 py-0.5 text-xs text-ink-3">与本地一致</span>
          ) : field.overridden ? (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-xs text-warning">
              本地已修改，默认保留
            </span>
          ) : (
            <span className="rounded bg-primary-light px-1.5 py-0.5 text-xs text-primary">
              {field.current ? '将更新' : '将写入'}
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
      toast.success(count > 0 ? `已应用 ${count} 个配置字段` : '没有需要应用的字段');
      onApplied();
    } catch (err) {
      toast.error(err, '应用配置失败');
    }
    onClose();
  };

  return (
    <Dialog
      title={config.name ? `导入「${config.name}」` : '导入工作区配置'}
      hint="勾选字段会写入本地配置；本地修改默认保留。ADO 端点变化时会清除对应 PAT，Rocket.Chat 变化时需要重新登录。"
      onClose={onClose}
      footer={
        <>
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={() => void apply()}
            disabled={selected.size === 0}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            应用 {selected.size} 项
          </button>
        </>
      }
    >
      <div className="px-5 pb-2">
        {fields.length === 0 ? (
          <div className="py-8 text-center text-sm text-ink-3">配置文件里没有可识别的字段</div>
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

/** 设置页「工作区」分区：从 URL / 文件导入配置，之后可一键重新同步 */
export function WorkspaceConfigSection() {
  const [source, setSource] = useState(() => loadWorkspaceSource());
  const [url, setUrl] = useState(source?.kind === 'url' ? source.url : '');
  const [adoProject, setAdoProject] = useState(source?.kind === 'ado' ? source.ado.project : '');
  const [adoRepository, setAdoRepository] = useState(source?.kind === 'ado' ? source.ado.repository : '');
  const [adoRef, setAdoRef] = useState(source?.kind === 'ado' ? source.ado.ref : 'refs/heads/main');
  const [adoPath, setAdoPath] = useState(source?.kind === 'ado' ? source.ado.path : '/config/rcx.workspace.json');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ config: WorkspaceConfig; source?: WorkspaceConfigRemoteSource } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const workbenchConfig = useWorkbench((state) => state.config);
  const adoConnectionLabel = workbenchConfig?.adoBase
    ? `${workbenchConfig.adoBase} · ${ADO_AUTH_LABELS[workbenchConfig.auth ?? 'pat']}`
    : '请先在“工作台”里配置当前 Azure DevOps 连接';
  const missingAdoFields = [
    ['项目', adoProject],
    ['仓库', adoRepository],
    ['分支或提交', adoRef],
    ['文件路径', adoPath],
  ].filter(([, value]) => !value.trim()).map(([label]) => label);

  const importText = (text: string, remoteSource?: WorkspaceConfigRemoteSource) => {
    try {
      setPreview({ config: parseWorkspaceConfig(text), source: remoteSource });
    } catch (err) {
      toast.error(err, '配置无法导入');
    }
  };

  const fetchFromRemoteSource = async (remoteSource: WorkspaceConfigRemoteSource) => {
    setLoading(true);
    try {
      const result = await fetchWorkspaceConfigFromSource(remoteSource);
      setPreview(result);
    } catch (err) {
      toast.error(err, '拉取配置失败');
    } finally {
      setLoading(false);
    }
  };

  const fetchFromUrl = async (target: string) => {
    await fetchFromRemoteSource({ kind: 'url', url: target.trim() });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    importText(await file.text());
  };

  return (
    <>
      <h2 className="text-base font-semibold text-ink">工作区配置</h2>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-3">
        从团队共享的 rcx.workspace.json 一次性配好服务器、ADO、模板和更新地址。
        配置提供默认值：你自己改过的字段会保留本地值，其余跟随配置。
        凭据（如 PAT）不在配置文件里，需要单独填写。
      </p>

      {source && (
        <div className="mt-3 max-w-2xl rounded-lg border border-line bg-fill-1 px-3 py-2.5 text-xs text-ink-2">
          <div>
            上次导入：{source.name || '未命名配置'} ·{' '}
            {new Date(source.importedAt).toLocaleString()}
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
          {(source.kind === 'url' || source.kind === 'ado') && (
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
              <span>每天自动检查团队配置更新,有变化时提醒(不会静默改你的配置)</span>
            </label>
          )}
          {(source.kind === 'url' || source.kind === 'ado') && (
            <button
              onClick={() => {
                const remoteSource = remoteWorkspaceConfigSource(source);
                if (remoteSource) void fetchFromRemoteSource(remoteSource);
              }}
              disabled={loading}
              className="mt-2 flex h-8 items-center gap-1.5 rounded-md border border-line px-3 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Globe size={12} />}
              重新读取当前来源
            </button>
          )}
        </div>
      )}

      <div className="mt-3 flex max-w-2xl gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="无需登录即可访问的配置 URL（可使用 Git Raw 地址）"
          className="h-9 flex-1 rounded-md border border-line bg-surface-4 px-3 text-sm text-ink outline-none focus:border-primary"
        />
        <button
          onClick={() => url.trim() && void fetchFromUrl(url.trim())}
          disabled={loading || !url.trim()}
          className="flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-white transition hover:bg-primary-hover disabled:opacity-50"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Globe size={14} />}
          拉取
        </button>
        <button
          onClick={() => fileRef.current?.click()}
          className="flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-ink-2 transition hover:bg-fill-hover"
        >
          <FileUp size={14} />
          选择文件
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
        <div className="text-sm font-medium text-ink">从当前 Azure DevOps 仓库读取</div>
        <p className="mt-1 text-xs leading-relaxed text-ink-3">
          复用“工作台”里已配置的 ADO 地址和认证，从指定项目/仓库/ref/path 读取单个
          `rcx.workspace.json` 文件。
        </p>
        <div className="mt-1 text-xs text-ink-3">{adoConnectionLabel}</div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input
            aria-label="ADO 项目"
            value={adoProject}
            onChange={(event) => setAdoProject(event.target.value)}
            placeholder="项目名，如 Road Map"
            className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
          <input
            aria-label="ADO 仓库"
            value={adoRepository}
            onChange={(event) => setAdoRepository(event.target.value)}
            placeholder="仓库名，如 Rocket X"
            className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
          <input
            aria-label="ADO 分支或提交"
            value={adoRef}
            onChange={(event) => setAdoRef(event.target.value)}
            placeholder="refs/heads/main"
            className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
          <input
            aria-label="ADO 文件路径"
            value={adoPath}
            onChange={(event) => setAdoPath(event.target.value)}
            placeholder="/config/rcx.workspace.json"
            className="h-9 rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
        </div>
        {missingAdoFields.length > 0 ? (
          <p className="mt-2 text-xs text-warning">读取前请填写：{missingAdoFields.join('、')}</p>
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
          从 ADO 读取
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
