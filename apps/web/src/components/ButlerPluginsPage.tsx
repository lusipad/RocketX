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
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';

type SkillScopeFilter = 'all' | SkillMetadata['scope'];
type CatalogTab = 'plugins' | 'skills' | 'apps';
type DetailItem =
  | { kind: 'plugin'; marketplaceName: string; marketplaceLabel: string; plugin: PluginSummary; detail?: PluginDetail }
  | { kind: 'skill'; skill: SkillMetadata }
  | { kind: 'app'; app: AppInfo };

function scopeLabel(scope: SkillMetadata['scope']): string {
  if (scope === 'repo') return '当前工作区';
  if (scope === 'user') return '我的 Skill';
  if (scope === 'admin') return '组织提供';
  return '系统提供';
}

function statusLabel(status: ReturnType<typeof useCodexWorkspace.getState>['status']): string {
  if (status === 'connecting') return '正在连接 Codex Runtime';
  if (status === 'ready') return '目录已就绪';
  if (status === 'running') return 'Codex 正在运行任务';
  if (status === 'waiting-input') return 'Codex 正在等待输入';
  if (status === 'unavailable') return 'Codex Runtime 不可用';
  return '尚未连接 Codex Runtime';
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

function skillSummary(skill: SkillMetadata): string {
  return firstNonEmpty(skill.interface?.shortDescription, skill.shortDescription, skill.description) ?? '未提供说明';
}

function pluginTitle(plugin: PluginSummary): string {
  return firstNonEmpty(plugin.interface?.displayName, plugin.name) ?? plugin.name;
}

function pluginSummary(plugin: PluginSummary): string {
  return firstNonEmpty(plugin.interface?.shortDescription, plugin.interface?.longDescription) ?? '未提供说明';
}

function pluginStateLabel(plugin: PluginSummary): string {
  if (plugin.installed) {
    return plugin.enabled ? '已安装并启用' : '已安装';
  }
  if (plugin.availability === 'DISABLED_BY_ADMIN') return '管理员已禁用';
  if (plugin.installPolicy === 'NOT_AVAILABLE') return '当前不可安装';
  if (plugin.installPolicy === 'INSTALLED_BY_DEFAULT') return '默认提供';
  return '可安装';
}

function appSummary(app: AppInfo): string {
  return firstNonEmpty(
    app.description,
    app.pluginDisplayNames.length > 0 ? `来自 ${app.pluginDisplayNames.join('、')}` : undefined,
  ) ?? '未提供说明';
}

function appStateLabel(app: AppInfo): string {
  return `可访问：${app.isAccessible ? '是' : '否'} · 已启用：${app.isEnabled ? '是' : '否'}`;
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
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<SkillScopeFilter>('all');
  const [selectedItem, setSelectedItem] = useState<DetailItem | null>(null);
  const [busyKey, setBusyKey] = useState('');
  const [detailLoadingKey, setDetailLoadingKey] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!workspaceRoot.trim()) {
      toast.error('请先选择 Codex 工作区');
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
      toast.error(reason, '刷新目录失败');
    } finally {
      setRefreshing(false);
    }
  }, [connect, plugins, refreshCatalog, status, workspaceRoot]);

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

  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  const pluginGroups = useMemo(() => {
    const marketplaces = plugins?.marketplaces ?? [];
    return marketplaces.flatMap((marketplace) => {
      const marketplaceLabel = firstNonEmpty(marketplace.interface?.displayName, marketplace.name) ?? marketplace.name;
      const items = marketplace.plugins.filter((plugin) => {
        if (!normalizedQuery) return true;
        return [
          pluginTitle(plugin),
          plugin.name,
          pluginSummary(plugin),
          plugin.interface?.developerName,
          ...plugin.keywords,
        ]
          .filter(Boolean)
          .join('\n')
          .toLocaleLowerCase('zh-CN')
          .includes(normalizedQuery);
      });
      return items.length > 0 ? [{
        id: marketplace.name,
        label: marketplaceLabel,
        items,
      }] : [];
    });
  }, [normalizedQuery, plugins]);
  const visibleSkills = useMemo(() => skills.filter((skill) => {
    if (scope !== 'all' && skill.scope !== scope) return false;
    if (!normalizedQuery) return true;
    return `${skillTitle(skill)}\n${skill.name}\n${skillSummary(skill)}`
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery);
  }), [normalizedQuery, scope, skills]);
  const skillGroups = useMemo(() => {
    const order: SkillMetadata['scope'][] = ['repo', 'user', 'admin', 'system'];
    return order.flatMap((groupScope) => {
      const items = visibleSkills.filter((skill) => skill.scope === groupScope);
      return items.length > 0 ? [{ id: groupScope, label: scopeLabel(groupScope), items }] : [];
    });
  }, [visibleSkills]);
  const visibleApps = useMemo(() => apps.filter((app) => {
    if (!normalizedQuery) return true;
    return [
      app.name,
      app.description,
      app.installUrl,
      ...app.pluginDisplayNames,
    ]
      .filter(Boolean)
      .join('\n')
      .toLocaleLowerCase('zh-CN')
      .includes(normalizedQuery);
  }), [apps, normalizedQuery]);

  const loading = status === 'connecting' || refreshing;
  const hasCatalog = plugins !== null;
  const activeCatalogError = activeTab === 'plugins'
    ? catalogErrors.plugins
    : activeTab === 'apps'
      ? catalogErrors.apps
      : undefined;
  const emptyTitle = activeTab === 'plugins'
    ? (plugins?.marketplaces.some((entry) => entry.plugins.length > 0) ? '没有匹配的插件' : '还没有可用插件')
    : activeTab === 'skills'
      ? (skills.length > 0 ? '没有匹配的 Skill' : '还没有可用 Skill')
      : (apps.length > 0 ? '没有匹配的 App' : '还没有可用 App');
  const emptyDescription = activeTab === 'plugins'
    ? '换个关键词试试，或刷新插件目录。'
    : activeTab === 'skills'
      ? '换个关键词或来源试试。'
      : '换个关键词试试，或检查 Runtime 是否返回 App 目录。';

  const toggleSkill = async (skill: SkillMetadata): Promise<void> => {
    const nextBusyKey = `skill:${skill.path}`;
    setBusyKey(nextBusyKey);
    try {
      await setSkillEnabled(skill.path, !skill.enabled);
      const updated = findSkillDetail(skill.path);
      setSelectedItem((current) => current?.kind === 'skill' && current.skill.path === skill.path ? updated : current);
    } catch (reason) {
      toast.error(reason, '更新 Skill 失败');
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
      toast.error(reason, plugin.installed ? '卸载插件失败' : '安装插件失败');
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
    setSelectedItem({ kind: 'plugin', marketplaceName, marketplaceLabel, plugin });
    setDetailLoadingKey(key);
    try {
      const detail = await readPlugin(marketplaceName, plugin.name);
      setSelectedItem((current) => current?.kind === 'plugin' && current.plugin.id === plugin.id
        ? { ...current, detail }
        : current);
    } catch (reason) {
      toast.error(reason, '读取插件详情失败');
    } finally {
      setDetailLoadingKey((current) => current === key ? '' : current);
    }
  };

  return (
    <section aria-label="插件" className="butler-codex-page">
      <div className="butler-plugin-directory">
        <header className="butler-plugin-toolbar">
          <div role="tablist" aria-label="扩展类型">
            {([
              ['plugins', '插件'],
              ['skills', 'Skills'],
              ['apps', 'Apps'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={activeTab === value}
                onClick={() => setActiveTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div>
            <button type="button" onClick={() => void refresh()} disabled={loading} aria-label="刷新插件">
              <RefreshCw size={14} className={loading ? 'animate-spin motion-reduce:animate-none' : ''} aria-hidden="true" />
              刷新
            </button>
          </div>
        </header>

        <div className="butler-plugin-heading">
          <h1>扩展 Codex</h1>
          <p>{workspaceRoot.trim() ? statusLabel(status) : '尚未选择 Codex 工作区'}</p>
          {error ? <p>{error}</p> : null}
        </div>

        <div className="butler-plugin-filters">
          {activeTab === 'skills' ? (
            <div role="tablist" aria-label="Skill 来源">
              {([
                ['all', '全部'],
                ['repo', '当前工作区'],
                ['user', '我的'],
                ['admin', '组织'],
                ['system', '系统'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={scope === value}
                  onClick={() => setScope(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : <div />}
          <label>
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="搜索插件"
              placeholder={activeTab === 'plugins' ? '搜索插件' : activeTab === 'skills' ? '搜索 Skill' : '搜索 App'}
            />
          </label>
        </div>

        <div className="butler-plugin-content">
          {!workspaceRoot.trim() ? (
            <div className="butler-codex-empty-list">
              <Blocks size={26} aria-hidden="true" />
              <h2>还没有选择工作区</h2>
              <p>选择 Codex 工作区后，这里会显示真实的插件、Skills 和 Apps 目录。</p>
            </div>
          ) : loading && !hasCatalog ? (
            <div className="butler-codex-loading">
              <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              正在读取 Codex 目录…
            </div>
          ) : error && !hasCatalog ? (
            <div className="butler-codex-error">
              <h2>暂时无法读取目录</h2>
              <p>{error}</p>
            </div>
          ) : activeCatalogError ? (
            <div className="butler-codex-error">
              <h2>{activeTab === 'apps' ? 'Apps 目录暂不可用' : '插件目录暂不可用'}</h2>
              <p>{activeCatalogError}</p>
              <p>对话、Skills 和已安排任务仍可正常使用；可稍后刷新重试。</p>
            </div>
          ) : activeTab === 'plugins' ? (
            pluginGroups.length === 0 ? (
              <div className="butler-codex-empty-list">
                <Blocks size={26} aria-hidden="true" />
                <h2>{emptyTitle}</h2>
                <p>{emptyDescription}</p>
              </div>
            ) : pluginGroups.map((group) => (
              <section key={group.id} className="butler-plugin-group" aria-labelledby={`plugin-group-${group.id}`}>
                <h2 id={`plugin-group-${group.id}`}>{group.label}</h2>
                <div>
                  {group.items.map((plugin) => {
                    const title = pluginTitle(plugin);
                    const changing = busyKey === `plugin:${plugin.id}`;
                    const installable = !plugin.installed
                      && plugin.availability === 'AVAILABLE'
                      && plugin.installPolicy !== 'NOT_AVAILABLE';
                    return (
                      <article key={plugin.id} className="butler-plugin-item">
                        <button
                          type="button"
                          onClick={() => void openPluginDetail(group.id, group.label, plugin)}
                          aria-label={`查看插件 ${title}`}
                        >
                          <span className="butler-plugin-icon"><Blocks size={17} aria-hidden="true" /></span>
                          <span>
                            <strong>{title}</strong>
                            <small>{`${pluginSummary(plugin)} · ${pluginStateLabel(plugin)}`}</small>
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label={plugin.installed ? `卸载插件 ${plugin.name}` : `安装插件 ${plugin.name}`}
                          disabled={changing || (!plugin.installed && !installable)}
                          onClick={() => void togglePlugin(group.id, plugin)}
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
                  })}
                </div>
              </section>
            ))
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
                        <button type="button" onClick={() => setSelectedItem({ kind: 'skill', skill })} aria-label={`查看 Skill ${title}`}>
                          <span className="butler-plugin-icon"><Blocks size={17} aria-hidden="true" /></span>
                          <span>
                            <strong>{title}</strong>
                            <small>{skillSummary(skill)}</small>
                          </span>
                        </button>
                        <button
                          type="button"
                          role="switch"
                          aria-label={`${skill.enabled ? '停用' : '启用'} Skill ${skill.name}`}
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
              <h2 id="plugin-group-apps">Apps</h2>
              <div>
                {visibleApps.map((app) => (
                  <article key={app.id} className="butler-plugin-item">
                    <button type="button" onClick={() => setSelectedItem({ kind: 'app', app })} aria-label={`查看 App ${app.name}`}>
                      <span className="butler-plugin-icon"><Blocks size={17} aria-hidden="true" /></span>
                      <span>
                        <strong>{app.name}</strong>
                        <small>{`${appSummary(app)} · ${appStateLabel(app)}`}</small>
                        {app.installUrl ? <small>{app.installUrl}</small> : null}
                      </span>
                    </button>
                    {app.installUrl ? (
                      <a
                        href={app.installUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`打开 ${app.name} 安装地址`}
                        className="butler-plugin-install"
                      >
                        <ExternalLink size={15} aria-hidden="true" />
                      </a>
                    ) : (
                      <button type="button" disabled className="butler-plugin-install" aria-label={`${app.name} 暂无安装地址`}>
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
          <section role="dialog" aria-modal="true" aria-label={`插件详情 ${detailLabel(selectedItem)}`} className="butler-plugin-detail">
            <header>
              <span className="butler-plugin-icon"><Blocks size={18} aria-hidden="true" /></span>
              <div>
                <h2>{detailLabel(selectedItem)}</h2>
                <p>
                  {selectedItem.kind === 'plugin'
                    ? `${selectedItem.plugin.name} · ${selectedItem.marketplaceLabel}`
                    : selectedItem.kind === 'skill'
                      ? `${selectedItem.skill.name} · ${scopeLabel(selectedItem.skill.scope)}`
                      : `${appStateLabel(selectedItem.app)}${selectedItem.app.installUrl ? ' · 含安装地址' : ''}`}
                </p>
              </div>
              <button type="button" onClick={() => setSelectedItem(null)} aria-label="关闭插件详情">
                <X size={16} aria-hidden="true" />
              </button>
            </header>
            <div>
              {selectedItem.kind === 'plugin' ? (
                <>
                  <h3>适用说明</h3>
                  <p>{firstNonEmpty(selectedItem.detail?.description) || pluginSummary(selectedItem.plugin)}</p>
                  {detailLoadingKey === `plugin-detail:${selectedItem.plugin.id}` ? (
                    <p className="butler-codex-loading">
                      <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      正在读取插件详情…
                    </p>
                  ) : null}
                  <h3>状态</h3>
                  <p>{pluginStateLabel(selectedItem.plugin)}</p>
                  <h3>能力</h3>
                  {(selectedItem.plugin.interface?.capabilities ?? []).length > 0 ? (
                    <ul>
                      {(selectedItem.plugin.interface?.capabilities ?? []).map((capability) => (
                        <li key={`${selectedItem.plugin.id}:${capability}`}>
                          <code>{capability}</code>
                        </li>
                      ))}
                    </ul>
                  ) : <p>未声明能力。</p>}
                  {selectedItem.detail ? (
                    <>
                      <h3>包含内容</h3>
                      <ul>
                        <li>{selectedItem.detail.skills.length} 个 Skills</li>
                        <li>{selectedItem.detail.apps.length} 个 Apps</li>
                        <li>{selectedItem.detail.hooks.length} 个 Hooks</li>
                        <li>{selectedItem.detail.mcpServers.length} 个 MCP Servers</li>
                      </ul>
                      {selectedItem.detail.skills.length > 0 ? (
                        <>
                          <h3>Skills</h3>
                          <ul>
                            {selectedItem.detail.skills.map((skill) => (
                              <li key={`${selectedItem.plugin.id}:${skill.name}`}>
                                <strong>{firstNonEmpty(skill.interface?.displayName, skill.name) || skill.name}</strong>
                                <p>{firstNonEmpty(skill.shortDescription, skill.description) || '未提供说明'}</p>
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
                  <h3>适用说明</h3>
                  <p>{firstNonEmpty(selectedItem.skill.description) || skillSummary(selectedItem.skill)}</p>
                  {firstNonEmpty(selectedItem.skill.interface?.defaultPrompt) ? (
                    <>
                      <h3>默认提示</h3>
                      <pre>{selectedItem.skill.interface?.defaultPrompt}</pre>
                    </>
                  ) : null}
                  <h3>所需工具</h3>
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
                  ) : <p>未声明额外工具依赖。</p>}
                </>
              ) : (
                <>
                  <h3>适用说明</h3>
                  <p>{appSummary(selectedItem.app)}</p>
                  <h3>状态</h3>
                  <p>{appStateLabel(selectedItem.app)}</p>
                  <h3>安装地址</h3>
                  {selectedItem.app.installUrl ? (
                    <p><a href={selectedItem.app.installUrl} target="_blank" rel="noreferrer">{selectedItem.app.installUrl}</a></p>
                  ) : <p>当前没有提供 installUrl。</p>}
                  <h3>关联插件</h3>
                  {selectedItem.app.pluginDisplayNames.length > 0 ? (
                    <ul>
                      {selectedItem.app.pluginDisplayNames.map((name) => (
                        <li key={`${selectedItem.app.id}:${name}`}>{name}</li>
                      ))}
                    </ul>
                  ) : <p>未声明关联插件。</p>}
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
                  {selectedItem.plugin.installed ? '卸载' : '安装'}
                </button>
              ) : selectedItem.kind === 'skill' ? (
                <button
                  type="button"
                  onClick={() => void toggleSkill(selectedItem.skill)}
                  disabled={busyKey === `skill:${selectedItem.skill.path}`}
                >
                  {selectedItem.skill.enabled ? '停用' : '启用'}
                </button>
              ) : selectedItem.app.installUrl ? (
                <a href={selectedItem.app.installUrl} target="_blank" rel="noreferrer">
                  打开安装地址
                </a>
              ) : (
                <button type="button" disabled>暂无安装地址</button>
              )}
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
