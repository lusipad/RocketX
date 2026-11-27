import {
  Blocks,
  Check,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppInfo, PluginDetail, PluginSummary, SkillMetadata } from '../agent/protocol/generated/v2';
import { useI18n, type MessageKey, type TranslateFn } from '../i18n';
import { isTauriRuntime } from '../lib/client';
import { pinyinMatch, usePinyinReady } from '../lib/pinyin';
import { desktopAssetUrl } from '../platform/desktopOpener';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import ButlerConnectorsPanel from './ButlerConnectorsPanel';
import ButlerMcpHubPanel from './ButlerMcpHubPanel';
import ButlerPolicyPanel from './ButlerPolicyPanel';

type SkillScopeFilter = 'all' | SkillMetadata['scope'];
type CatalogTab = 'plugins' | 'skills' | 'apps' | 'mcp' | 'connectors' | 'policy';
type PluginDirectoryTab = 'public' | 'workspace' | 'personal';
type DetailItem =
  | {
    kind: 'plugin';
    marketplaceName: string;
    marketplaceLabel: string;
    plugin: PluginSummary;
    detail?: PluginDetail;
    detailError?: boolean;
  }
  | { kind: 'skill'; skill: SkillMetadata }
  | { kind: 'app'; app: AppInfo };

function assetUrl(value: string | null | undefined): string | undefined {
  const source = value?.trim();
  if (!source) return undefined;
  if (/^(?:https?:|data:|blob:|asset:)/iu.test(source)) return source;
  return isTauriRuntime() ? desktopAssetUrl(source) : undefined;
}

function firstAsset(assets: Record<string, string | undefined> | null): string | undefined {
  return assets ? Object.values(assets).find((value): value is string => Boolean(value?.trim())) : undefined;
}

function pluginAssets(plugin: PluginSummary): { light?: string; dark?: string; brandColor?: string } {
  return {
    light: assetUrl(plugin.interface?.logo)
      ?? assetUrl(plugin.interface?.logoUrl)
      ?? assetUrl(plugin.interface?.composerIcon)
      ?? assetUrl(plugin.interface?.composerIconUrl),
    dark: assetUrl(plugin.interface?.logoDark) ?? assetUrl(plugin.interface?.logoUrlDark),
    brandColor: plugin.interface?.brandColor ?? undefined,
  };
}

function appAssets(app: AppInfo): { light?: string; dark?: string } {
  return {
    light: assetUrl(app.logoUrl) ?? assetUrl(firstAsset(app.iconAssets)),
    dark: assetUrl(app.logoUrlDark) ?? assetUrl(firstAsset(app.iconDarkAssets)),
  };
}

function skillAssets(skill: SkillMetadata): { light?: string; brandColor?: string } {
  return {
    light: assetUrl(skill.interface?.iconLarge) ?? assetUrl(skill.interface?.iconSmall),
    brandColor: skill.interface?.brandColor,
  };
}

function CatalogIcon({
  light,
  dark,
  brandColor,
}: {
  light?: string;
  dark?: string;
  brandColor?: string;
}) {
  return (
    <span
      className="butler-plugin-icon"
      style={brandColor ? { backgroundColor: `color-mix(in srgb, ${brandColor} 14%, transparent)` } : undefined}
    >
      <Blocks size={17} aria-hidden="true" />
      {light ? (
        <img
          className={dark ? 'is-light has-dark' : 'is-light'}
          src={light}
          alt=""
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      ) : null}
      {dark ? (
        <img
          className="is-dark"
          src={dark}
          alt=""
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      ) : null}
    </span>
  );
}

function marketplaceDirectory(
  name: string,
  path: string | null,
  workspaceRoot: string,
): PluginDirectoryTab {
  if (!path || /openai|curated|bundled/iu.test(name)) return 'public';
  const normalizedPath = path.replaceAll('\\', '/').toLocaleLowerCase('en-US');
  const normalizedWorkspace = workspaceRoot.replaceAll('\\', '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US');
  return normalizedWorkspace && normalizedPath.startsWith(`${normalizedWorkspace}/`) ? 'workspace' : 'personal';
}

function scopeLabel(scope: SkillMetadata['scope'], t: TranslateFn): string {
  if (scope === 'repo') return t('butler.plugins.scope.repo');
  if (scope === 'user') return t('butler.plugins.scope.user');
  if (scope === 'admin') return t('butler.plugins.scope.admin');
  return t('butler.plugins.scope.system');
}

function statusLabel(status: ReturnType<typeof useCodexWorkspace.getState>['status'], t: TranslateFn): string {
  if (status === 'connecting') return t('butler.plugins.status.connecting');
  if (status === 'ready') return t('butler.plugins.status.ready');
  if (status === 'running') return t('butler.plugins.status.running');
  if (status === 'waiting-input') return t('butler.plugins.status.waitingInput');
  if (status === 'unavailable') return t('butler.plugins.status.unavailable');
  return t('butler.plugins.status.idle');
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const text = value?.trim();
    if (text) return text;
  }
  return undefined;
}

function skillTitle(skill: SkillMetadata): string {
  return firstNonEmpty(skill.interface?.displayName, skill.name) ?? skill.name;
}

function skillSummary(skill: SkillMetadata, t: TranslateFn): string {
  return firstNonEmpty(skill.interface?.shortDescription, skill.shortDescription, skill.description) ?? t('butler.plugins.noDescription');
}

function pluginTitle(plugin: PluginSummary): string {
  return firstNonEmpty(plugin.interface?.displayName, plugin.name) ?? plugin.name;
}

function pluginSummary(plugin: PluginSummary, t: TranslateFn): string {
  return firstNonEmpty(plugin.interface?.shortDescription, plugin.interface?.longDescription) ?? t('butler.plugins.noDescription');
}

function pluginStateLabel(plugin: PluginSummary, t: TranslateFn): string {
  if (plugin.installed) {
    return plugin.enabled ? t('butler.plugins.state.installedEnabled') : t('butler.plugins.state.installed');
  }
  if (plugin.availability === 'DISABLED_BY_ADMIN') return t('butler.plugins.state.disabledByAdmin');
  if (plugin.installPolicy === 'NOT_AVAILABLE') return t('butler.plugins.state.notAvailable');
  if (plugin.installPolicy === 'INSTALLED_BY_DEFAULT') return t('butler.plugins.state.installedByDefault');
  return t('butler.plugins.state.available');
}

function appSummary(app: AppInfo, t: TranslateFn): string {
  return firstNonEmpty(
    app.description,
    app.pluginDisplayNames.length > 0
      ? t('butler.plugins.fromPlugins', { names: app.pluginDisplayNames.join(t('butler.listSeparator')) })
      : undefined,
  ) ?? t('butler.plugins.noDescription');
}

function appStateLabel(app: AppInfo, t: TranslateFn): string {
  return t('butler.plugins.appState', {
    accessible: app.isAccessible ? t('common.yes') : t('common.no'),
    enabled: app.isEnabled ? t('common.yes') : t('common.no'),
  });
}

function detailLabel(item: DetailItem): string {
  if (item.kind === 'plugin') return pluginTitle(item.plugin);
  if (item.kind === 'skill') return skillTitle(item.skill);
  return item.app.name;
}

function findPluginDetail(marketplaceName: string, pluginId: string): DetailItem | null {
  const plugins = useCodexWorkspace.getState().plugins;
  const marketplace = plugins?.marketplaces.find((entry) => entry.name === marketplaceName);
  const plugin = marketplace?.plugins.find((entry) => entry.id === pluginId);
  if (!marketplace || !plugin) return null;
  return {
    kind: 'plugin',
    marketplaceName,
    marketplaceLabel: firstNonEmpty(marketplace.interface?.displayName, marketplace.name) ?? marketplace.name,
    plugin,
  };
}

function findSkillDetail(path: string): DetailItem | null {
  const skill = useCodexWorkspace.getState().skills.find((entry) => entry.path === path);
  return skill ? { kind: 'skill', skill } : null;
}

export default function ButlerPluginsPage() {
  const { t, tp, locale } = useI18n();
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const status = useCodexWorkspace((state) => state.status);
  const error = useCodexWorkspace((state) => state.error);
  const skills = useCodexWorkspace((state) => state.skills);
  const apps = useCodexWorkspace((state) => state.apps);
  const plugins = useCodexWorkspace((state) => state.plugins);
  const catalogErrors = useCodexWorkspace((state) => state.catalogErrors);
  const connect = useCodexWorkspace((state) => state.connect);
  const refreshCatalog = useCodexWorkspace((state) => state.refreshCatalog);
  const installPlugin = useCodexWorkspace((state) => state.installPlugin);
  const uninstallPlugin = useCodexWorkspace((state) => state.uninstallPlugin);
  const readPlugin = useCodexWorkspace((state) => state.readPlugin);
  const setSkillEnabled = useCodexWorkspace((state) => state.setSkillEnabled);

  const [activeTab, setActiveTab] = useState<CatalogTab>('plugins');
  const [directoryTab, setDirectoryTab] = useState<PluginDirectoryTab>('public');
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SkillScopeFilter>('all');
  const [selectedItem, setSelectedItem] = useState<DetailItem | null>(null);
  const [busyKey, setBusyKey] = useState('');
  const [detailLoadingKey, setDetailLoadingKey] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const pinyinReady = usePinyinReady();

  const refresh = useCallback(async (): Promise<void> => {
    if (!workspaceRoot.trim()) {
      toast.error(t('butler.plugins.selectWorkspaceToast'));
      return;
    }
    setRefreshing(true);
    try {
      if (status === 'idle' || status === 'unavailable' || !plugins) {
        await connect();
      } else {
        await refreshCatalog();
      }
    } catch (reason) {
      toast.error(reason, t('butler.plugins.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  }, [connect, plugins, refreshCatalog, status, t, workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot.trim() || status !== 'idle' || plugins) return;
    void refresh();
  }, [plugins, refresh, status, workspaceRoot]);

  useEffect(() => {
    setSelectedItem(null);
  }, [activeTab]);

  useEffect(() => {
    if (!selectedItem) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setSelectedItem(null);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [selectedItem]);

  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  const allPluginGroups = useMemo(() => {
    const marketplaces = plugins?.marketplaces ?? [];
    return marketplaces.flatMap((marketplace) => {
      const marketplaceLabel = firstNonEmpty(marketplace.interface?.displayName, marketplace.name) ?? marketplace.name;
      const items = marketplace.plugins.filter((plugin) => {
        if (!normalizedQuery) return true;
        return pinyinMatch(normalizedQuery, ...[
          pluginTitle(plugin),
          plugin.name,
          pluginSummary(plugin, t),
          plugin.interface?.developerName,
          ...plugin.keywords,
        ]);
      });
      return items.length > 0 ? [{
        id: marketplace.name,
        label: marketplaceLabel,
        directory: marketplaceDirectory(marketplace.name, marketplace.path, workspaceRoot),
        items,
      }] : [];
    });
  }, [normalizedQuery, plugins, t, workspaceRoot, pinyinReady]);
  const installedPlugins = useMemo(() => allPluginGroups.flatMap((group) => group.items
    .filter((plugin) => plugin.installed)
    .map((plugin) => ({ marketplaceName: group.id, marketplaceLabel: group.label, plugin }))), [allPluginGroups]);
  const pluginGroups = useMemo(() => allPluginGroups
    .filter((group) => group.directory === directoryTab)
    .map((group) => ({ ...group, items: group.items.filter((plugin) => !plugin.installed) }))
    .filter((group) => group.items.length > 0), [allPluginGroups, directoryTab]);
  const visibleSkills = useMemo(() => skills.filter((skill) => {
    if (scope !== 'all' && skill.scope !== scope) return false;
    if (!normalizedQuery) return true;
    return pinyinMatch(normalizedQuery, skillTitle(skill), skill.name, skillSummary(skill, t));
  }), [normalizedQuery, scope, skills, t, pinyinReady]);
  const skillGroups = useMemo(() => {
    const order: SkillMetadata['scope'][] = ['repo', 'user', 'admin', 'system'];
    return order.flatMap((groupScope) => {
      const items = visibleSkills.filter((skill) => skill.scope === groupScope);
      return items.length > 0 ? [{ id: groupScope, label: scopeLabel(groupScope, t), items }] : [];
    });
  }, [t, visibleSkills]);
  const visibleApps = useMemo(() => apps.filter((app) => {
    if (!normalizedQuery) return true;
    return pinyinMatch(normalizedQuery, ...[
      app.name,
      app.description,
      app.installUrl,
      ...app.pluginDisplayNames,
    ]);
  }), [apps, normalizedQuery, pinyinReady]);

  const loading = status === 'connecting' || refreshing;
  const hasCatalog = plugins !== null;
  const activeCatalogError = activeTab === 'plugins'
    ? catalogErrors.plugins
    : activeTab === 'apps'
      ? catalogErrors.apps
      : undefined;
  const emptyTitle = activeTab === 'plugins'
    ? t(plugins?.marketplaces.some((entry) => entry.plugins.length > 0) ? 'butler.plugins.emptyNoMatchingPlugins' : 'butler.plugins.emptyNoPlugins')
    : activeTab === 'skills'
      ? t(skills.length > 0 ? 'butler.plugins.emptyNoMatchingSkills' : 'butler.plugins.emptyNoSkills')
      : t(apps.length > 0 ? 'butler.plugins.emptyNoMatchingApps' : 'butler.plugins.emptyNoApps');
  const emptyDescription = activeTab === 'plugins'
    ? t('butler.plugins.emptyPluginsDesc')
    : activeTab === 'skills'
      ? t('butler.plugins.emptySkillsDesc')
      : t('butler.plugins.emptyAppsDesc');

  const toggleSkill = async (skill: SkillMetadata): Promise<void> => {
    const nextBusyKey = `skill:${skill.path}`;
    setBusyKey(nextBusyKey);
    try {
      await setSkillEnabled(skill.path, !skill.enabled);
      const updated = findSkillDetail(skill.path);
      setSelectedItem((current) => current?.kind === 'skill' && current.skill.path === skill.path ? updated : current);
    } catch (reason) {
      toast.error(reason, t('butler.plugins.updateSkillFailed'));
    } finally {
      setBusyKey('');
    }
  };

  const togglePlugin = async (marketplaceName: string, plugin: PluginSummary): Promise<void> => {
    const nextBusyKey = `plugin:${plugin.id}`;
    setBusyKey(nextBusyKey);
    try {
      if (plugin.installed) {
        await uninstallPlugin(plugin.id);
      } else {
        await installPlugin(marketplaceName, plugin.name);
      }
      const updated = findPluginDetail(marketplaceName, plugin.id);
      setSelectedItem((current) => current?.kind === 'plugin' && current.plugin.id === plugin.id && updated
        ? { ...updated, detail: current.detail }
        : current);
    } catch (reason) {
      toast.error(reason, t(plugin.installed ? 'butler.plugins.uninstallFailed' : 'butler.plugins.installFailed'));
    } finally {
      setBusyKey('');
    }
  };

  const openPluginDetail = async (
    marketplaceName: string,
    marketplaceLabel: string,
    plugin: PluginSummary,
  ): Promise<void> => {
    const key = `plugin-detail:${plugin.id}`;
    setSelectedItem({ kind: 'plugin', marketplaceName, marketplaceLabel, plugin, detailError: false });
    setDetailLoadingKey(key);
    try {
      const detail = await readPlugin(marketplaceName, plugin.name);
      setSelectedItem((current) => current?.kind === 'plugin' && current.plugin.id === plugin.id
        ? { ...current, detail, detailError: false }
        : current);
    } catch {
      setSelectedItem((current) => current?.kind === 'plugin' && current.plugin.id === plugin.id
        ? { ...current, detailError: true }
        : current);
    } finally {
      setDetailLoadingKey((current) => current === key ? '' : current);
    }
  };

  const renderPlugin = (
    marketplaceName: string,
    marketplaceLabel: string,
    plugin: PluginSummary,
  ) => {
    const title = pluginTitle(plugin);
    const changing = busyKey === `plugin:${plugin.id}`;
    const installable = !plugin.installed
      && plugin.availability === 'AVAILABLE'
      && plugin.installPolicy !== 'NOT_AVAILABLE';
    return (
      <article key={plugin.id} className="butler-plugin-item">
        <button
          type="button"
          onClick={() => void openPluginDetail(marketplaceName, marketplaceLabel, plugin)}
          aria-label={t('butler.plugins.viewPluginAria', { title })}
        >
          <CatalogIcon {...pluginAssets(plugin)} />
          <span>
            <strong>{title}</strong>
            <small>{`${pluginSummary(plugin, t)} · ${pluginStateLabel(plugin, t)}`}</small>
          </span>
        </button>
        <button
          type="button"
          aria-label={t(plugin.installed ? 'butler.plugins.uninstallPluginAria' : 'butler.plugins.installPluginAria', { name: plugin.name })}
          disabled={changing || (!plugin.installed && !installable)}
          onClick={() => void togglePlugin(marketplaceName, plugin)}
          className="butler-plugin-install"
        >
          {changing
            ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            : plugin.installed
              ? <X size={15} aria-hidden="true" />
              : <Plus size={15} aria-hidden="true" />}
        </button>
      </article>
    );
  };

  return (
    <section aria-label={t('butler.plugins.pageAria')} className="butler-codex-page">
      <div className="butler-plugin-directory">
        <header className="butler-plugin-toolbar">
          <div role="tablist" aria-label={t('butler.plugins.extensionTypesAria')}>
            {([
              ['plugins', 'butler.plugins.tabPlugins'],
              ['skills', 'butler.plugins.tabSkills'],
              ['apps', 'butler.plugins.tabApps'],
              ['mcp', 'butler.plugins.tabMcp'],
              ['connectors', 'butler.plugins.tabConnectors'],
              ['policy', 'butler.plugins.tabPolicy'],
            ] as const satisfies ReadonlyArray<readonly [CatalogTab, MessageKey]>).map(([value, labelKey]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={activeTab === value}
                onClick={() => setActiveTab(value)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
          <div>
            <button type="button" onClick={() => void refresh()} disabled={loading} aria-label={t('butler.plugins.refreshAria')}>
              <RefreshCw size={14} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
              {t('common.refresh')}
            </button>
          </div>
        </header>

        <div className="butler-plugin-heading">
          <h1>{t('butler.plugins.heading')}</h1>
          <p>{workspaceRoot.trim() ? statusLabel(status, t) : t('butler.plugins.noWorkspaceSelected')}</p>
          {error ? <p>{error}</p> : null}
        </div>

        <div className="butler-plugin-filters">
          {activeTab === 'plugins' ? (
            <div role="tablist" aria-label={t('butler.plugins.directoryTabsAria')}>
              {([
                ['public', 'butler.plugins.dirPublic'],
                ['workspace', 'butler.plugins.dirWorkspace'],
                ['personal', 'butler.plugins.dirPersonal'],
              ] as const satisfies ReadonlyArray<readonly [PluginDirectoryTab, MessageKey]>).map(([value, labelKey]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={directoryTab === value}
                  onClick={() => setDirectoryTab(value)}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          ) : activeTab === 'skills' ? (
            <div role="tablist" aria-label={t('butler.plugins.skillSourcesAria')}>
              {([
                ['all', 'butler.plugins.filterAll'],
                ['repo', 'butler.plugins.filterRepo'],
                ['user', 'butler.plugins.filterUser'],
                ['admin', 'butler.plugins.filterAdmin'],
                ['system', 'butler.plugins.filterSystem'],
              ] as const satisfies ReadonlyArray<readonly [SkillScopeFilter, MessageKey]>).map(([value, labelKey]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={scope === value}
                  onClick={() => setScope(value)}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          ) : <div />}
          {(activeTab === 'plugins' || activeTab === 'skills' || activeTab === 'apps') ? (
            <label>
              <Search size={14} aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={t('butler.plugins.searchAria')}
                placeholder={t(activeTab === 'plugins' ? 'butler.plugins.searchPluginsPlaceholder' : activeTab === 'skills' ? 'butler.plugins.searchSkillsPlaceholder' : 'butler.plugins.searchAppsPlaceholder')}
              />
            </label>
          ) : null}
        </div>

        <div className="butler-plugin-content">
          {activeTab === 'mcp' ? (
            <ButlerMcpHubPanel workspaceRoot={workspaceRoot} />
          ) : activeTab === 'connectors' ? (
            <ButlerConnectorsPanel workspaceRoot={workspaceRoot} />
          ) : activeTab === 'policy' ? (
            <ButlerPolicyPanel workspaceRoot={workspaceRoot} />
          ) : !workspaceRoot.trim() ? (
            <div className="butler-codex-empty-list">
              <Blocks size={26} aria-hidden="true" />
              <h2>{t('butler.plugins.noWorkspaceTitle')}</h2>
              <p>{t('butler.plugins.noWorkspaceDesc')}</p>
            </div>
          ) : loading && !hasCatalog ? (
            <div className="butler-codex-loading">
              <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              {t('butler.plugins.loadingCatalog')}
            </div>
          ) : error && !hasCatalog ? (
            <div className="butler-codex-error">
              <h2>{t('butler.plugins.loadCatalogErrorTitle')}</h2>
              <p>{error}</p>
            </div>
          ) : activeCatalogError ? (
            <div className="butler-codex-error">
              <h2>{t(activeTab === 'apps' ? 'butler.plugins.appsCatalogUnavailable' : 'butler.plugins.pluginsCatalogUnavailable')}</h2>
              <p>{activeCatalogError}</p>
              <p>{t('butler.plugins.catalogErrorFallbackHint')}</p>
            </div>
          ) : activeTab === 'plugins' ? (
            pluginGroups.length === 0 && installedPlugins.length === 0 ? (
              <div className="butler-codex-empty-list">
                <Blocks size={26} aria-hidden="true" />
                <h2>{emptyTitle}</h2>
                <p>{emptyDescription}</p>
              </div>
            ) : (
              <>
                {installedPlugins.length > 0 ? (
                  <section className="butler-plugin-group" aria-labelledby="plugin-group-installed">
                    <h2 id="plugin-group-installed">{t('butler.plugins.installedGroupHeading')}</h2>
                    <div>
                      {installedPlugins.map(({ marketplaceName, marketplaceLabel, plugin }) => (
                        renderPlugin(marketplaceName, marketplaceLabel, plugin)
                      ))}
                    </div>
                  </section>
                ) : null}
                {pluginGroups.map((group) => (
                  <section key={group.id} className="butler-plugin-group" aria-labelledby={`plugin-group-${group.id}`}>
                    <h2 id={`plugin-group-${group.id}`}>{group.label}</h2>
                    <div>{group.items.map((plugin) => renderPlugin(group.id, group.label, plugin))}</div>
                  </section>
                ))}
              </>
            )
          ) : activeTab === 'skills' ? (
            skillGroups.length === 0 ? (
              <div className="butler-codex-empty-list">
                <Blocks size={26} aria-hidden="true" />
                <h2>{emptyTitle}</h2>
                <p>{emptyDescription}</p>
              </div>
            ) : skillGroups.map((group) => (
              <section key={group.id} className="butler-plugin-group" aria-labelledby={`plugin-group-${group.id}`}>
                <h2 id={`plugin-group-${group.id}`}>{group.label}</h2>
                <div>
                  {group.items.map((skill) => {
                    const title = skillTitle(skill);
                    const changing = busyKey === `skill:${skill.path}`;
                    return (
                      <article key={skill.path} className="butler-plugin-item">
                        <button type="button" onClick={() => setSelectedItem({ kind: 'skill', skill })} aria-label={t('butler.plugins.viewSkillAria', { title })}>
                          <CatalogIcon {...skillAssets(skill)} />
                          <span>
                            <strong>{title}</strong>
                            <small>{skillSummary(skill, t)}</small>
                          </span>
                        </button>
                        <button
                          type="button"
                          role="switch"
                          aria-label={t(skill.enabled ? 'butler.plugins.disableSkillAria' : 'butler.plugins.enableSkillAria', { name: skill.name })}
                          aria-checked={skill.enabled}
                          disabled={changing}
                          onClick={() => void toggleSkill(skill)}
                          className="butler-plugin-install"
                        >
                          {changing
                            ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                            : skill.enabled
                              ? <Check size={15} aria-hidden="true" />
                              : <Plus size={15} aria-hidden="true" />}
                        </button>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))
          ) : visibleApps.length === 0 ? (
            <div className="butler-codex-empty-list">
              <Blocks size={26} aria-hidden="true" />
              <h2>{emptyTitle}</h2>
              <p>{emptyDescription}</p>
            </div>
          ) : (
            <section className="butler-plugin-group" aria-labelledby="plugin-group-apps">
              <h2 id="plugin-group-apps">{t('butler.plugins.tabApps')}</h2>
              <div>
                {visibleApps.map((app) => (
                  <article key={app.id} className="butler-plugin-item">
                    <button type="button" onClick={() => setSelectedItem({ kind: 'app', app })} aria-label={t('butler.plugins.viewAppAria', { name: app.name })}>
                      <CatalogIcon {...appAssets(app)} />
                      <span>
                        <strong>{app.name}</strong>
                        <small>{`${appSummary(app, t)} · ${appStateLabel(app, t)}`}</small>
                        {app.installUrl ? <small>{app.installUrl}</small> : null}
                      </span>
                    </button>
                    {app.installUrl ? (
                      <a
                        href={app.installUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={t('butler.plugins.openInstallUrlAria', { name: app.name })}
                        className="butler-plugin-install"
                      >
                        <ExternalLink size={15} aria-hidden="true" />
                      </a>
                    ) : (
                      <button type="button" disabled className="butler-plugin-install" aria-label={t('butler.plugins.noInstallUrlAria', { name: app.name })}>
                        <Check size={15} aria-hidden="true" />
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {selectedItem ? (
        <div className="butler-plugin-detail-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedItem(null);
        }}>
          <section role="dialog" aria-modal="true" aria-label={t('butler.plugins.detailDialogAria', { label: detailLabel(selectedItem) })} className="butler-plugin-detail">
            <header>
              {selectedItem.kind === 'plugin'
                ? <CatalogIcon {...pluginAssets(selectedItem.plugin)} />
                : selectedItem.kind === 'skill'
                  ? <CatalogIcon {...skillAssets(selectedItem.skill)} />
                  : <CatalogIcon {...appAssets(selectedItem.app)} />}
              <div>
                <h2>{detailLabel(selectedItem)}</h2>
                <p>
                  {selectedItem.kind === 'plugin'
                    ? `${selectedItem.plugin.name} · ${selectedItem.marketplaceLabel}`
                    : selectedItem.kind === 'skill'
                      ? `${selectedItem.skill.name} · ${scopeLabel(selectedItem.skill.scope, t)}`
                      : `${appStateLabel(selectedItem.app, t)}${selectedItem.app.installUrl ? t('butler.plugins.hasInstallUrlSuffix') : ''}`}
                </p>
              </div>
              <button type="button" onClick={() => setSelectedItem(null)} aria-label={t('butler.plugins.closeDetailAria')}>
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <div>
              {selectedItem.kind === 'plugin' ? (
                <>
                  <h3>{t('butler.plugins.sectionDescription')}</h3>
                  <p>{firstNonEmpty(selectedItem.detail?.description) || pluginSummary(selectedItem.plugin, t)}</p>
                  {detailLoadingKey === `plugin-detail:${selectedItem.plugin.id}` ? (
                    <p className="butler-codex-loading">
                      <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      {t('butler.plugins.loadingPluginDetail')}
                    </p>
                  ) : null}
                  {selectedItem.detailError ? (
                    <div className="butler-plugin-detail-warning" role="status">
                      <span>{t('butler.plugins.detailErrorHint')}</span>
                      <button
                        type="button"
                        onClick={() => void openPluginDetail(
                          selectedItem.marketplaceName,
                          selectedItem.marketplaceLabel,
                          selectedItem.plugin,
                        )}
                      >
                        {t('common.retry')}
                      </button>
                    </div>
                  ) : null}
                  <h3>{t('butler.plugins.sectionStatus')}</h3>
                  <p>{pluginStateLabel(selectedItem.plugin, t)}</p>
                  <h3>{t('butler.plugins.sectionCapabilities')}</h3>
                  {(selectedItem.plugin.interface?.capabilities ?? []).length > 0 ? (
                    <ul>
                      {(selectedItem.plugin.interface?.capabilities ?? []).map((capability) => (
                        <li key={`${selectedItem.plugin.id}:${capability}`}>
                          <code>{capability}</code>
                        </li>
                      ))}
                    </ul>
                  ) : <p>{t('butler.plugins.noCapabilities')}</p>}
                  {selectedItem.detail ? (
                    <>
                      <h3>{t('butler.plugins.sectionContents')}</h3>
                      <ul>
                        <li>{tp(selectedItem.detail.skills.length, 'butler.plugins.countSkillsOne', 'butler.plugins.countSkillsOther')}</li>
                        <li>{tp(selectedItem.detail.apps.length, 'butler.plugins.countAppsOne', 'butler.plugins.countAppsOther')}</li>
                        <li>{tp(selectedItem.detail.hooks.length, 'butler.plugins.countHooksOne', 'butler.plugins.countHooksOther')}</li>
                        <li>{tp(selectedItem.detail.mcpServers.length, 'butler.plugins.countMcpOne', 'butler.plugins.countMcpOther')}</li>
                      </ul>
                      {selectedItem.detail.skills.length > 0 ? (
                        <>
                          <h3>{t('butler.plugins.tabSkills')}</h3>
                          <ul>
                            {selectedItem.detail.skills.map((skill) => (
                              <li key={`${selectedItem.plugin.id}:${skill.name}`}>
                                <strong>{firstNonEmpty(skill.interface?.displayName, skill.name) || skill.name}</strong>
                                <p>{firstNonEmpty(skill.shortDescription, skill.description) || t('butler.plugins.noDescription')}</p>
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </>
              ) : selectedItem.kind === 'skill' ? (
                <>
                  <h3>{t('butler.plugins.sectionDescription')}</h3>
                  <p>{firstNonEmpty(selectedItem.skill.description) || skillSummary(selectedItem.skill, t)}</p>
                  {firstNonEmpty(selectedItem.skill.interface?.defaultPrompt) ? (
                    <>
                      <h3>{t('butler.plugins.sectionDefaultPrompt')}</h3>
                      <pre>{selectedItem.skill.interface?.defaultPrompt}</pre>
                    </>
                  ) : null}
                  <h3>{t('butler.plugins.sectionRequiredTools')}</h3>
                  {(selectedItem.skill.dependencies?.tools ?? []).length > 0 ? (
                    <ul>
                      {(selectedItem.skill.dependencies?.tools ?? []).map((tool, index) => (
                        <li key={`${selectedItem.skill.path}:${tool.type}:${tool.value}:${index}`}>
                          <code>{tool.value}</code>
                          <span>{tool.type}</span>
                          {tool.description ? <p>{tool.description}</p> : null}
                        </li>
                      ))}
                    </ul>
                  ) : <p>{t('butler.plugins.noExtraTools')}</p>}
                </>
              ) : (
                <>
                  <h3>{t('butler.plugins.sectionDescription')}</h3>
                  <p>{appSummary(selectedItem.app, t)}</p>
                  <h3>{t('butler.plugins.sectionStatus')}</h3>
                  <p>{appStateLabel(selectedItem.app, t)}</p>
                  <h3>{t('butler.plugins.sectionInstallUrl')}</h3>
                  {selectedItem.app.installUrl ? (
                    <p><a href={selectedItem.app.installUrl} target="_blank" rel="noreferrer">{selectedItem.app.installUrl}</a></p>
                  ) : <p>{t('butler.plugins.noInstallUrl')}</p>}
                  <h3>{t('butler.plugins.sectionRelatedPlugins')}</h3>
                  {selectedItem.app.pluginDisplayNames.length > 0 ? (
                    <ul>
                      {selectedItem.app.pluginDisplayNames.map((name) => (
                        <li key={`${selectedItem.app.id}:${name}`}>{name}</li>
                      ))}
                    </ul>
                  ) : <p>{t('butler.plugins.noRelatedPlugins')}</p>}
                </>
              )}
            </div>
            <footer>
              {selectedItem.kind === 'plugin' ? (
                <button
                  type="button"
                  onClick={() => void togglePlugin(selectedItem.marketplaceName, selectedItem.plugin)}
                  disabled={busyKey === `plugin:${selectedItem.plugin.id}`
                    || (!selectedItem.plugin.installed
                      && (selectedItem.plugin.availability !== 'AVAILABLE'
                        || selectedItem.plugin.installPolicy === 'NOT_AVAILABLE'))}
                >
                  {t(selectedItem.plugin.installed ? 'butler.plugins.uninstallAction' : 'butler.plugins.installAction')}
                </button>
              ) : selectedItem.kind === 'skill' ? (
                <button
                  type="button"
                  onClick={() => void toggleSkill(selectedItem.skill)}
                  disabled={busyKey === `skill:${selectedItem.skill.path}`}
                >
                  {t(selectedItem.skill.enabled ? 'butler.plugins.disableAction' : 'butler.plugins.enableAction')}
                </button>
              ) : selectedItem.app.installUrl ? (
                <a href={selectedItem.app.installUrl} target="_blank" rel="noreferrer">
                  {t('butler.plugins.openInstallUrl')}
                </a>
              ) : (
                <button type="button" disabled>{t('butler.plugins.noInstallUrlButton')}</button>
              )}
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
