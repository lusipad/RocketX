import { useMemo, useRef, useState } from 'react';
import { FileUp, Globe, Loader2 } from 'lucide-react';
import Dialog from './Dialog';
import { toast } from '../stores/toast';
import { getServerBase, httpFetch, setServerBase } from '../lib/client';
import { ADO_WEB_KEY, adoWebBase, loadWorkbenchConfig } from '../lib/ado';
import { useWorkbench } from '../stores/workbench';
import { useWiTemplates } from '../stores/wiTemplates';
import { loadAiSettings, saveAiSettings, type AiProviderConfig } from '../kernel/ai/config';
import { loadUpdateSource, saveUpdateSource } from '../lib/updateSource';
import { loadHierarchyLayout, saveHierarchyLayout } from '../stores/wiTemplates';
import {
  aiProviderFingerprint,
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

/**
 * 工作区配置导入（issue #67）。
 * 配置文件提供默认值；用户自己改过的字段默认保留本地值（仍可勾选强制覆盖），
 * 其余字段跟随配置。凭据（PAT / AI key）不在配置文件里，也永远不会被这里改动。
 */

export function collectCurrentValues(): WorkspaceCurrentValues {
  const workbench = loadWorkbenchConfig();
  const ai = loadAiSettings();
  return {
    serverUrl: getServerBase(),
    adoBase: workbench?.adoBase ?? '',
    adoMode: workbench?.mode ?? '',
    adoAuth: workbench?.auth ?? '',
    adoWebUrl: adoWebBase() ?? '',
    templatesUrl: useWiTemplates.getState().url,
    aiProviders: Object.fromEntries(
      ai.providers.map((provider) => [provider.id, aiProviderFingerprint(provider)]),
    ),
    updateSource: updateSourceFingerprint(loadUpdateSource()),
    hierarchyLayout: loadHierarchyLayout(),
  };
}

function applySelectedFields(
  config: WorkspaceConfig,
  fields: WorkspaceField[],
  selected: ReadonlySet<string>,
  sourceUrl?: string,
): number {
  const applied: Record<string, string> = {};
  for (const field of fields) {
    if (selected.has(field.key)) applied[field.key] = field.incoming;
  }

  if (selected.has('server.url') && config.rocketChat) {
    setServerBase(config.rocketChat.url);
  }

  const adoTouched = ['ado.base', 'ado.mode', 'ado.auth'].some((key) => selected.has(key));
  if (adoTouched) {
    const existing = loadWorkbenchConfig();
    // 只改选中的字段，PAT / 账号 / 桥接地址等本地内容原样保留
    useWorkbench.getState().setConfig({
      mode: selected.has('ado.mode') && config.ado?.mode ? config.ado.mode : (existing?.mode ?? 'direct'),
      bridge: existing?.bridge,
      adoBase: selected.has('ado.base') && config.ado?.url ? config.ado.url : existing?.adoBase,
      pat: existing?.pat,
      auth: selected.has('ado.auth') && config.ado?.auth ? config.ado.auth : existing?.auth,
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

  if (selected.has('templates.url') && config.workItemTemplates) {
    useWiTemplates.getState().setUrl(config.workItemTemplates.url);
  }

  if (selected.has('update.source') && config.update) {
    saveUpdateSource({ kind: config.update.source, location: config.update.location ?? '' });
  }

  if (selected.has('workItems.hierarchyLayout') && config.workItems?.hierarchyLayout) {
    saveHierarchyLayout(config.workItems.hierarchyLayout);
  }

  const pickedProviders = (config.ai?.providers ?? []).filter((provider) =>
    selected.has(`ai.provider.${provider.id}`),
  );
  if (pickedProviders.length > 0) {
    const settings = loadAiSettings();
    for (const provider of pickedProviders) {
      const existing = settings.providers.find((entry) => entry.id === provider.id);
      const next: AiProviderConfig = {
        id: provider.id,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        model: provider.model,
        name: provider.name || existing?.name || provider.id,
        locality: existing?.locality ?? 'external',
        // 密钥状态不动：配置文件里没有也不可能有 key
        hasSecret: existing?.hasSecret ?? false,
      };
      settings.providers = existing
        ? settings.providers.map((entry) => (entry.id === provider.id ? next : entry))
        : [...settings.providers, next];
    }
    saveAiSettings(settings);
  }

  saveWorkspaceSource(
    mergeAppliedFields(
      loadWorkspaceSource(),
      { url: sourceUrl, name: config.name, importedAt: Date.now() },
      applied,
    ),
  );
  return Object.keys(applied).length;
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
            <span className="rounded bg-fill-2 px-1.5 py-0.5 text-2xs text-ink-3">与本地一致</span>
          ) : field.overridden ? (
            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-2xs text-warning">
              本地已修改，默认保留
            </span>
          ) : (
            <span className="rounded bg-primary-light px-1.5 py-0.5 text-2xs text-primary">
              {field.current ? '将更新' : '将写入'}
            </span>
          )}
        </div>
        {!field.unchanged && (
          <div className="mt-1 space-y-0.5 font-mono text-2xs break-all text-ink-3">
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
  sourceUrl,
  onApplied,
  onClose,
}: {
  config: WorkspaceConfig;
  sourceUrl?: string;
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

  const apply = () => {
    try {
      const count = applySelectedFields(config, fields, selected, sourceUrl);
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
      hint="勾选的字段会写入本地配置；「本地已修改」的字段默认保留你的值。PAT 和 AI 密钥不受影响。"
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
            onClick={apply}
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
  const [url, setUrl] = useState(source?.url ?? '');
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ config: WorkspaceConfig; sourceUrl?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const importText = (text: string, sourceUrl?: string) => {
    try {
      setPreview({ config: parseWorkspaceConfig(text), sourceUrl });
    } catch (err) {
      toast.error(err, '配置无法导入');
    }
  };

  const fetchFromUrl = async (target: string) => {
    setLoading(true);
    try {
      const res = await httpFetch(target);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      importText(await res.text(), target);
    } catch (err) {
      toast.error(err, '拉取配置失败');
    } finally {
      setLoading(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    importText(await file.text());
  };

  return (
    <>
      <h2 className="text-base font-semibold text-ink">工作区配置</h2>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-3">
        从团队共享的 rcx.workspace.json 一次性配好服务器、ADO、AI 和模板地址。
        配置提供默认值：你自己改过的字段会保留本地值，其余跟随配置。
        凭据（PAT、AI 密钥）不在配置文件里，需要单独填写。
      </p>

      {source && (
        <div className="mt-3 max-w-2xl rounded-lg border border-line bg-fill-1 px-3 py-2.5 text-xs text-ink-2">
          <div>
            上次导入：{source.name || '未命名配置'} ·{' '}
            {new Date(source.importedAt).toLocaleString()}
          </div>
          {source.url && <div className="mt-0.5 truncate font-mono text-2xs text-ink-3">{source.url}</div>}
          {source.url && (
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
        </div>
      )}

      <div className="mt-3 flex max-w-2xl gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="配置文件的 URL（也可放在 Git 仓库的 raw 地址）"
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

      {preview && (
        <ImportPreviewDialog
          config={preview.config}
          sourceUrl={preview.sourceUrl}
          onApplied={() => setSource(loadWorkspaceSource())}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
