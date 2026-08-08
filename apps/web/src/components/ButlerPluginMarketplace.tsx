import { Download, Plus, RefreshCw, Store, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PluginMarketplaceEntry,
  PluginSummary,
} from '../agent/protocol/generated/v2';
import { codexBrainAvailability } from '../lib/butlerBrain';
import {
  BUTLER_MARKETPLACE_CATALOG_TIMEOUT_MS,
  BUTLER_MARKETPLACE_LOCAL_TIMEOUT_MS,
  BUTLER_MARKETPLACE_MUTATION_TIMEOUT_MS,
  isRemoteButlerMarketplaceSource,
  withButlerMarketplaceDeadline,
} from '../lib/butlerMarketplace';
import {
  addButlerCodexMarketplace,
  installButlerCodexPlugin,
  listButlerCodexPlugins,
  listButlerInstalledCodexPlugins,
  removeButlerCodexMarketplace,
  uninstallButlerCodexPlugin,
  upgradeButlerCodexMarketplaces,
} from '../stores/butlerCodex';
import { toast } from '../stores/toast';
import { ConfirmDialog } from './Dialog';

interface CatalogPlugin {
  marketplace: PluginMarketplaceEntry;
  plugin: PluginSummary;
}

function pluginTitle(plugin: PluginSummary): string {
  return plugin.interface?.displayName || plugin.name;
}

function pluginDescription(plugin: PluginSummary): string {
  return plugin.interface?.shortDescription
    || plugin.interface?.longDescription
    || '这个 Plugin 没有提供简介。';
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function ButlerPluginMarketplace({
  onSkillsChanged,
}: {
  onSkillsChanged: () => void;
}) {
  const availability = codexBrainAvailability();
  const [marketplaces, setMarketplaces] = useState<PluginMarketplaceEntry[]>([]);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [source, setSource] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [networkOnline, setNetworkOnline] = useState(browserOnline);
  const [catalogNotice, setCatalogNotice] = useState<string | null>(null);
  const [removingMarketplace, setRemovingMarketplace] =
    useState<PluginMarketplaceEntry | null>(null);
  const refreshRevision = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    if (!availability.available) {
      setLoading(false);
      return;
    }
    const revision = ++refreshRevision.current;
    const online = browserOnline();
    setNetworkOnline(online);
    setLoading(true);
    try {
      if (!online) {
        const result = await withButlerMarketplaceDeadline(
          listButlerInstalledCodexPlugins(),
          '读取已安装 Plugin',
          BUTLER_MARKETPLACE_LOCAL_TIMEOUT_MS,
        );
        if (revision !== refreshRevision.current) return;
        setMarketplaces(result.marketplaces);
        setLoadErrors(result.marketplaceLoadErrors.map((error) => error.message));
        setCatalogNotice('当前离线，仅显示已安装 Plugin 和本地市场；联网后会自动重新加载。');
        return;
      }

      try {
        const result = await withButlerMarketplaceDeadline(
          listButlerCodexPlugins(),
          '读取在线 Skill 市场',
          BUTLER_MARKETPLACE_CATALOG_TIMEOUT_MS,
        );
        if (revision !== refreshRevision.current) return;
        setMarketplaces(result.marketplaces);
        setLoadErrors(result.marketplaceLoadErrors.map((error) => error.message));
        setCatalogNotice(null);
      } catch (catalogError) {
        const result = await withButlerMarketplaceDeadline(
          listButlerInstalledCodexPlugins(),
          '回退读取已安装 Plugin',
          BUTLER_MARKETPLACE_LOCAL_TIMEOUT_MS,
        );
        if (revision !== refreshRevision.current) return;
        setMarketplaces(result.marketplaces);
        setLoadErrors(result.marketplaceLoadErrors.map((error) => error.message));
        setCatalogNotice(
          `在线市场暂时不可用，已回退到本地内容。${errorMessage(catalogError)}`,
        );
      }
    } catch (error) {
      if (revision !== refreshRevision.current) return;
      setLoadErrors([errorMessage(error)]);
      setCatalogNotice(online ? null : '当前离线，本地 Plugin 也暂时无法读取。');
    } finally {
      if (revision === refreshRevision.current) setLoading(false);
    }
  }, [availability.available]);

  useEffect(() => {
    void refresh();
    const handleNetworkChange = () => void refresh();
    window.addEventListener('online', handleNetworkChange);
    window.addEventListener('offline', handleNetworkChange);
    return () => {
      refreshRevision.current += 1;
      window.removeEventListener('online', handleNetworkChange);
      window.removeEventListener('offline', handleNetworkChange);
    };
  }, [refresh]);

  const plugins = useMemo<CatalogPlugin[]>(
    () => marketplaces.flatMap((marketplace) =>
      marketplace.plugins.map((plugin) => ({ marketplace, plugin }))),
    [marketplaces],
  );

  if (!availability.available) {
    return (
      <section aria-label="Skill 市场">
        <h2 className="flex items-center gap-1.5 text-base font-semibold text-ink">
          <Store size={14} aria-hidden="true" />
          Skill 市场
        </h2>
        <p className="mt-2 rounded-lg border border-dashed border-line px-4 py-4 text-xs leading-5 text-ink-3">
          {availability.reason}
        </p>
      </section>
    );
  }

  const addMarketplace = async (): Promise<void> => {
    if (!source.trim()) return;
    if (!networkOnline && isRemoteButlerMarketplaceSource(source)) {
      toast.error(new Error('当前离线；本地市场路径仍可添加，Git 或网络地址请联网后重试。'));
      return;
    }
    setBusy('marketplace:add');
    try {
      const result = await withButlerMarketplaceDeadline(
        addButlerCodexMarketplace(source),
        '添加 Skill 市场',
        BUTLER_MARKETPLACE_MUTATION_TIMEOUT_MS,
      );
      setSource('');
      await refresh();
      toast.success(result.alreadyAdded
        ? `市场「${result.marketplaceName}」已经存在`
        : `已添加市场「${result.marketplaceName}」`);
    } catch (error) {
      toast.error(error, '添加 Skill 市场失败');
    } finally {
      setBusy(null);
    }
  };

  const upgradeMarketplaces = async (): Promise<void> => {
    if (!networkOnline) {
      toast.error(new Error('当前离线，无法更新远程 Skill 市场。'));
      return;
    }
    setBusy('marketplace:upgrade');
    try {
      const result = await withButlerMarketplaceDeadline(
        upgradeButlerCodexMarketplaces(),
        '更新 Skill 市场',
        BUTLER_MARKETPLACE_MUTATION_TIMEOUT_MS,
      );
      await refresh();
      if (result.errors.length > 0) {
        throw new Error(result.errors.map((error) =>
          `${error.marketplaceName}：${error.message}`).join('\n'));
      }
      toast.success(
        result.selectedMarketplaces.length > 0
          ? `已更新 ${result.selectedMarketplaces.length} 个市场`
          : '当前没有需要更新的市场',
      );
    } catch (error) {
      toast.error(error, '更新 Skill 市场失败');
    } finally {
      setBusy(null);
    }
  };

  const removeMarketplace = async (
    marketplace: PluginMarketplaceEntry,
  ): Promise<void> => {
    setBusy(`marketplace:remove:${marketplace.name}`);
    try {
      const result = await withButlerMarketplaceDeadline(
        removeButlerCodexMarketplace(marketplace.name),
        '移除 Skill 市场',
        BUTLER_MARKETPLACE_MUTATION_TIMEOUT_MS,
      );
      await refresh();
      onSkillsChanged();
      toast.success(`已移除市场「${result.marketplaceName}」`);
    } catch (error) {
      toast.error(error, '移除 Skill 市场失败');
    } finally {
      setBusy(null);
    }
  };

  const install = async ({ marketplace, plugin }: CatalogPlugin): Promise<void> => {
    if (!networkOnline && !marketplace.path) {
      toast.error(new Error('当前离线，这个 Plugin 没有可用的本地市场副本。'));
      return;
    }
    setBusy(plugin.id);
    try {
      const result = await withButlerMarketplaceDeadline(
        installButlerCodexPlugin({
          marketplaceName: marketplace.name,
          marketplacePath: marketplace.path,
          pluginName: plugin.name,
        }),
        '安装 Plugin',
        BUTLER_MARKETPLACE_MUTATION_TIMEOUT_MS,
      );
      await refresh();
      onSkillsChanged();
      const appNames = result.appsNeedingAuth.map((app) => app.name);
      toast.success(appNames.length > 0
        ? `已安装「${pluginTitle(plugin)}」，还需连接：${appNames.join('、')}`
        : `已安装「${pluginTitle(plugin)}」`);
    } catch (error) {
      toast.error(error, '安装 Plugin 失败');
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (plugin: PluginSummary): Promise<void> => {
    setBusy(plugin.id);
    try {
      await withButlerMarketplaceDeadline(
        uninstallButlerCodexPlugin(plugin.id),
        '卸载 Plugin',
        BUTLER_MARKETPLACE_MUTATION_TIMEOUT_MS,
      );
      await refresh();
      onSkillsChanged();
      toast.success(`已卸载「${pluginTitle(plugin)}」`);
    } catch (error) {
      toast.error(error, '卸载 Plugin 失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Skill 市场">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-base font-semibold text-ink">
            <Store size={14} aria-hidden="true" />
            Skill 市场
          </h2>
          <p className="mt-1 text-xs leading-5 text-ink-3">
            市场和安装由 Codex 管理；安装后，其 Skills 会自动出现在 $ 菜单。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void upgradeMarketplaces()}
          disabled={busy !== null || loading || !networkOnline}
          title={networkOnline ? '从 Codex 更新市场' : '当前离线，联网后才能更新市场'}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line px-2.5 text-xs text-ink-2 hover:bg-fill-hover disabled:opacity-50"
        >
          <RefreshCw size={12} aria-hidden="true" className={loading ? 'animate-spin' : ''} />
          更新市场
        </button>
      </div>

      <div className="mt-3 flex gap-2">
        <input
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder="Git URL 或本地市场路径"
          aria-label="Skill 市场地址"
          className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-3 text-xs text-ink outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={() => void addMarketplace()}
          disabled={
            !source.trim()
            || busy !== null
            || (!networkOnline && isRemoteButlerMarketplaceSource(source))
          }
          title={!networkOnline && isRemoteButlerMarketplaceSource(source)
            ? '当前离线，只能添加本地市场路径'
            : undefined}
          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-md bg-primary px-3 text-xs text-white hover:bg-primary-hover disabled:opacity-50"
        >
          <Plus size={12} aria-hidden="true" />
          添加
        </button>
      </div>

      {catalogNotice ? (
        <div
          role="status"
          className="mt-3 flex items-start justify-between gap-3 rounded-md bg-warning/10 px-3 py-2 text-xs leading-5 text-warning"
        >
          <span>{catalogNotice}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || busy !== null}
            className="shrink-0 rounded px-2 py-0.5 text-xs font-medium hover:bg-warning/10 disabled:opacity-50"
          >
            重试
          </button>
        </div>
      ) : null}

      {marketplaces.length > 0 ? (
        <div className="mt-3 rounded-lg border border-line/80 bg-fill-1/35 px-3 py-2.5">
          <div className="text-xs font-medium text-ink-2">已配置市场</div>
          <ul className="mt-2 space-y-2">
            {marketplaces.map((marketplace) => (
              <li
                key={marketplace.name}
                className="flex min-w-0 items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-ink">
                    {marketplace.interface?.displayName || marketplace.name}
                  </div>
                  <div
                    className="truncate text-[11px] text-ink-3"
                    title={marketplace.path || marketplace.name}
                  >
                    {marketplace.path || `${marketplace.name} · Codex 提供`}
                  </div>
                </div>
                {marketplace.path ? (
                  <button
                    type="button"
                    onClick={() => setRemovingMarketplace(marketplace)}
                    disabled={busy !== null}
                    aria-label={`移除市场 ${marketplace.interface?.displayName || marketplace.name}`}
                    className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-[11px] text-ink-3 hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={11} aria-hidden="true" />
                    移除
                  </button>
                ) : (
                  <span className="shrink-0 rounded-full bg-fill-2 px-2 py-0.5 text-[10px] text-ink-3">
                    Codex 管理
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {loadErrors.length > 0 ? (
        <div
          role="alert"
          className="mt-3 flex items-start justify-between gap-3 rounded-md bg-danger/10 px-3 py-2 text-xs leading-5 text-danger"
        >
          <span>{loadErrors.join('；')}</span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || busy !== null}
            className="shrink-0 rounded px-2 py-0.5 text-xs font-medium hover:bg-danger/10 disabled:opacity-50"
          >
            重试
          </button>
        </div>
      ) : null}

      {loading && plugins.length === 0 ? (
        <p className="mt-3 text-xs text-ink-3">正在读取 Codex 市场…</p>
      ) : plugins.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-line px-4 py-5 text-center text-xs leading-5 text-ink-3">
          {catalogNotice
            ? '当前没有已安装或本地可用的 Plugin。'
            : '还没有可用 Plugin。可以添加一个 Codex Marketplace，或更新已有市场。'}
        </p>
      ) : (
        <ul className="mt-3 grid gap-3 md:grid-cols-2">
          {plugins.map(({ marketplace, plugin }) => {
            const canInstall = plugin.availability === 'AVAILABLE'
              && plugin.installPolicy !== 'NOT_AVAILABLE';
            const locked = plugin.installPolicy === 'INSTALLED_BY_DEFAULT';
            const offlineInstallBlocked = !networkOnline && !marketplace.path;
            return (
              <li key={`${marketplace.name}:${plugin.id}`} className="rounded-lg border border-line/80 bg-fill-1/40 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="text-sm font-medium text-ink">{pluginTitle(plugin)}</strong>
                      <span className="rounded-full bg-fill-2 px-2 py-0.5 text-[10px] text-ink-3">
                        {marketplace.interface?.displayName || marketplace.name}
                      </span>
                      {plugin.installed ? (
                        <span className="rounded-full bg-primary-light px-2 py-0.5 text-[10px] text-primary">
                          已安装
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-2 text-xs leading-5 text-ink-2">{pluginDescription(plugin)}</p>
                  </div>
                  {plugin.installed ? (
                    <button
                      type="button"
                      onClick={() => void uninstall(plugin)}
                      disabled={busy !== null || locked}
                      aria-label={`卸载 ${pluginTitle(plugin)}`}
                      title={locked ? '由 Codex 默认安装，不能从这里卸载' : '卸载'}
                      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-ink-3 hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                    >
                      <Trash2 size={12} aria-hidden="true" />
                      卸载
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void install({ marketplace, plugin })}
                      disabled={busy !== null || !canInstall || offlineInstallBlocked}
                      title={offlineInstallBlocked
                        ? '当前离线，这个 Plugin 没有本地市场副本'
                        : undefined}
                      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-xs text-white hover:bg-primary-hover disabled:opacity-40"
                    >
                      <Download size={12} aria-hidden="true" />
                      安装
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {removingMarketplace ? (
        <ConfirmDialog
          title="移除 Skill 市场"
          message={`确定移除“${removingMarketplace.interface?.displayName || removingMarketplace.name}”吗？Codex 会删除这个市场配置；如其中 Plugin 受到影响，可重新添加市场并安装。`}
          confirmLabel="移除"
          onConfirm={() => void removeMarketplace(removingMarketplace)}
          onClose={() => setRemovingMarketplace(null)}
        />
      ) : null}
    </section>
  );
}
