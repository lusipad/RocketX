import { lazy, Suspense, type ComponentType } from 'react';
import type { RcMessage } from '@rcx/rc-client';
import { Bell, Blocks, Download } from 'lucide-react';
import { getServerBase, httpFetch, isTauri } from '../lib/client';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AppManager, isOfficialApp, setActiveAppManager, type InstalledApp } from './installed';
import { BUNDLED_APPS } from './bundled';
import { PermissionGate } from './permission';
import { CapabilityBus } from './capabilities/bus';
import { registerHostCapabilities } from './capabilities/host';
import { BridgeHost } from './bridge';
import { kernelRegistry } from './registry';
import { AppModule, AppPanel } from './AppFrame';
import type { ExtensionPoint, ReservedContribution } from './types';
import { createSandboxedWorker } from './sandbox/worker';
import { ensureHttpOrigin } from '../lib/http';
import { getAiRuntimeProvider, runtimeFeatures } from '../lib/runtimeMode';
import { kernelStore } from './store';
import { runButlerCommand } from './butler';
import { handoffToCodexTask } from '../lib/codexTaskHandoff';
import { createDefaultKernelHost } from '../lib/kernelHost';
import type { KernelHost } from './host';

export { ensureKernelStoreReady, kernelStore } from './store';
export const permissionGate = new PermissionGate((entry) => kernelStore.audit.append(entry).then(() => {}));
export const capabilityBus = new CapabilityBus(permissionGate);
export const bridgeHost = new BridgeHost(capabilityBus);
export const installedApps = new AppManager(kernelStore);

let initialized = false;
let initializing: Promise<void> | null = null;
let setupComplete = false;
let bridgeEventsStarted = false;
let bridgeEventCleanups: Array<() => void | Promise<void>> = [];
const nativeServiceStarts = new Map<string, Promise<void>>();
const defaultKernelHost = createDefaultKernelHost();
let activeKernelHost: KernelHost = defaultKernelHost;

function lazyComponent(
  loader: () => Promise<{ default: ComponentType<any> }>,
): ComponentType<any> {
  const Component = lazy(loader);
  return function LazyComponent(props: Record<string, unknown>) {
    return (
      <Suspense fallback={null}>
        <Component {...props} />
      </Suspense>
    );
  };
}

const ButlerPage = lazyComponent(() => import('../pages/ButlerPage'));
const ContactsPage = lazyComponent(() => import('../pages/ContactsPage'));
const TodosPage = lazyComponent(() => import('../pages/TodosPage'));
const CalendarPage = lazyComponent(() => import('../pages/CalendarPage'));
const WorkbenchPage = lazyComponent(() => import('../pages/WorkbenchPage'));
const SettingsPage = lazyComponent(() => import('../pages/SettingsPage'));
const DownloadsPage = lazyComponent(() => import('../pages/DownloadsPage'));
const ThreadPanel = lazyComponent(() => import('../components/ThreadPanel'));
const PinPanel = lazyComponent(() => import('../components/PinPanel'));
const StarredPanel = lazyComponent(() => import('../components/StarredPanel'));
const MembersPanel = lazyComponent(() => import('../components/MembersPanel'));
const SearchPanel = lazyComponent(() => import('../components/SearchPanel'));
const RoomInfoPanel = lazyComponent(() => import('../components/RoomInfoPanel'));
const FilesPanel = lazyComponent(() => import('../components/FilesPanel'));
const MentionsPanel = lazyComponent(() => import('../components/MentionsPanel'));
const SummaryPanel = lazyComponent(() => import('../components/SummaryPanel'));
const ButlerPanel = lazyComponent(() => import('../components/ButlerPanel'));
const AgentPanel = lazyComponent(() => import('../components/AgentPanel'));

async function summarizeRoom(rid: string): Promise<void> {
  if (getAiRuntimeProvider() === 'deepseek') {
    runButlerCommand({ rid, params: '请总结当前会话的未读消息，并列出需要我跟进的事项。' });
    return;
  }
  activeKernelHost.navigation.setPanel('ai');
  await activeKernelHost.ai.summarize(rid);
}

async function endSharedAgentSession(tmid: string): Promise<void> {
  await activeKernelHost.agent.endSession(tmid);
}

async function runSharedAgentBridge(): Promise<void> {
  await activeKernelHost.agent.startBridge();
}

function scopedAppId(appId: string): string {
  const userId = activeKernelHost.identity.userId() ?? 'guest';
  return `${userId}@${getServerBase() || 'same-origin'}:${appId}`;
}

function stringParam(params: unknown, key: string, fallback = ''): string {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : fallback;
}

function plainMessage(message: RcMessage): RcMessage {
  return structuredClone(message);
}

function desktopPlatform(): 'windows' | 'macos' | 'linux' {
  const value = navigator.userAgent.toLowerCase();
  if (value.includes('windows')) return 'windows';
  if (value.includes('mac')) return 'macos';
  return 'linux';
}

async function startNativeService(app: InstalledApp): Promise<void> {
  const service = app.manifest.service;
  if (!service) return;
  if (service.platforms && !service.platforms.includes(desktopPlatform())) return;
  if (!isTauri) throw new Error('native service 仅支持桌面客户端');
  if (!isOfficialApp(app) || app.source.kind !== 'bundled') {
    throw new Error('native service 只允许签名发布的内置应用启动');
  }
  await invoke('native_service_start', {
    appId: app.manifest.id,
    command: service.command,
    args: service.args,
    envNames: [
      ...(app.manifest.config?.env ?? []),
      ...(app.manifest.config?.secrets ?? []),
    ],
  });
}

function registerCapabilities(host: KernelHost): void {
  registerHostCapabilities(capabilityBus, host, { serverBase: getServerBase });
  capabilityBus.register('app.info', 'app:info', (_params, context) => {
    const app = installedApps.get(context.appId);
    if (!app) throw new Error('应用未安装');
    return {
      id: app.manifest.id,
      version: app.manifest.version,
      name: app.manifest.name,
      publisher: app.manifest.publisher,
      runtime: app.manifest.runtime,
      permissions: [...app.granted],
    };
  });
  capabilityBus.register('files.pick', 'files:read', async () => {
    if (!isTauri) throw new Error('文件选择仅支持桌面客户端');
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      title: '选择文件',
      multiple: false,
      directory: false,
    });
    return typeof selected === 'string' ? { path: selected } : { cancelled: true };
  });
  capabilityBus.register('native.call', 'native:service', async (params, context) => {
    const app = installedApps.get(context.appId);
    if (!app?.manifest.service || !isOfficialApp(app) || app.source.kind !== 'bundled') {
      throw new Error('当前应用没有可调用的签名 native service');
    }
    if (app.manifest.service.platforms && !app.manifest.service.platforms.includes(desktopPlatform())) {
      throw new Error(`native service 暂不支持 ${desktopPlatform()}`);
    }
    const object = params as { method?: unknown; params?: unknown } | undefined;
    if (typeof object?.method !== 'string' || !object.method) throw new Error('native.call 缺少 method');
    const start = nativeServiceStarts.get(context.appId) ?? startNativeService(app);
    nativeServiceStarts.set(context.appId, start);
    await start;
    return invoke('native_service_call', {
      appId: context.appId,
      method: object.method,
      params: object.params ?? {},
    });
  });
  capabilityBus.register('app.config.get', 'config:read', async (params, context) => {
    const name = stringParam(params, 'name');
    if (!name || !context.manifest.config?.env?.includes(name)) {
      throw new Error('只能读取应用声明的普通环境变量');
    }
    if (!isTauri) throw new Error('应用环境变量仅支持桌面客户端');
    const values = await invoke<Record<string, string>>('app_env_get', { names: [name] });
    return { name, value: values[name] ?? null };
  });
  capabilityBus.register('storage.get', 'storage:local', (params, context) =>
    kernelStore.appData.get(scopedAppId(context.appId), stringParam(params, 'key')),
  );
  capabilityBus.register('storage.set', 'storage:local', async (params, context) => {
    const object = params as { key?: unknown; value?: unknown } | undefined;
    if (typeof object?.key !== 'string' || !object.key) throw new Error('storage.set 缺少 key');
    await kernelStore.appData.set(scopedAppId(context.appId), object.key, object.value);
    return { ok: true };
  });
  capabilityBus.register('storage.delete', 'storage:local', async (params, context) => {
    await kernelStore.appData.delete(scopedAppId(context.appId), stringParam(params, 'key'));
    return { ok: true };
  });
  capabilityBus.register('storage.list', 'storage:local', (_params, context) =>
    kernelStore.appData.list(scopedAppId(context.appId)),
  );
  capabilityBus.register('ui.notify', 'ui:notify', (params) => {
    const object = params as { kind?: unknown; props?: unknown } | undefined;
    const props = object?.props as { message?: unknown; level?: unknown } | undefined;
    if (object?.kind !== 'notify' || typeof props?.message !== 'string') {
      throw new Error('M6 的 rcx/requestUI 只支持 notify');
    }
    const message = props.message.slice(0, 500);
    if (props.level === 'error') activeKernelHost.notifications.error(message);
    else if (props.level === 'success') activeKernelHost.notifications.success(message);
    else activeKernelHost.notifications.info(message);
    return { ok: true };
  });
  capabilityBus.register('net.fetch', 'net:fetch', async (params, context) => {
    const object = params as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown } | undefined;
    if (typeof object?.url !== 'string') throw new Error('net.fetch 缺少 url');
    const url = new URL(object.url);
    if (!context.manifest.netAllow?.includes(url.origin)) throw new Error(`netAllow 未允许 ${url.origin}`);
    const method = typeof object.method === 'string' ? object.method.toUpperCase() : 'GET';
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error(`不支持 method: ${method}`);
    const headers = new Headers();
    if (object.headers && typeof object.headers === 'object') {
      for (const [key, value] of Object.entries(object.headers as Record<string, unknown>)) {
        if (typeof value === 'string' && !/^(authorization|cookie|proxy-authorization)$/i.test(key)) {
          headers.set(key, value);
        }
      }
    }
    const body = typeof object.body === 'string' ? object.body : undefined;
    if (body && body.length > 1024 * 1024) throw new Error('net.fetch 请求体上限为 1 MB');
    await ensureHttpOrigin(url);
    const response = await httpFetch(
      url,
      { method, headers, body, redirect: 'manual', maxRedirections: 0 } as RequestInit,
    );
    if (response.status >= 300 && response.status < 400) throw new Error('net.fetch 不跟随重定向');
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('net.fetch 响应体上限为 1 MB');
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
    };
  });
}

function contributionId(appId: string, raw: Record<string, unknown>, fallback: string): string {
  const value = typeof raw.id === 'string' ? raw.id : typeof raw.name === 'string' ? raw.name : fallback;
  return `app:${appId}:${value}`;
}

function openAppSurface(appId: string): void {
  const module = kernelRegistry
    .get('nav.module')
    .find((candidate) => kernelRegistry.ownerOf('nav.module', candidate) === appId);
  if (module) {
    activeKernelHost.navigation.setModule(module.id);
    return;
  }
  const panel = kernelRegistry
    .get('panel.right')
    .find((candidate) => kernelRegistry.ownerOf('panel.right', candidate) === appId);
  if (panel && panel.id.startsWith('app:')) {
    activeKernelHost.navigation.setPanel(panel.id);
  }
}

function emitAfterOpen(appId: string, event: string, payload: unknown): void {
  openAppSurface(appId);
  bridgeHost.emit(appId, event, payload);
}

function activateApp(app: InstalledApp): () => void | Promise<void> {
  permissionGate.setGrant({ appId: app.manifest.id, granted: app.granted });
  const cleanups: Array<() => void | Promise<void>> = [];
  if (app.manifest.service && app.granted.includes('native:service')) {
    const start = startNativeService(app);
    nativeServiceStarts.set(app.manifest.id, start);
    void start.catch((error) => activeKernelHost.notifications.error(error, `${app.manifest.name} 后台服务启动失败`));
    cleanups.push(async () => {
      nativeServiceStarts.delete(app.manifest.id);
      await start.catch(() => {});
      if (isTauri) await invoke('native_service_stop', { appId: app.manifest.id }).catch(() => {});
    });
  }
  if (app.manifest.runtime === 'worker') {
    const worker = createSandboxedWorker(app.entryContent, app.manifest.id);
    cleanups.push(bridgeHost.registerWorker(app.manifest.id, app.manifest, worker));
    cleanups.push(() => worker.terminate());
  }
  const contributions = app.manifest.contributes ?? {};
  for (const [point, rawItems] of Object.entries(contributions)) {
    for (const [index, item] of (rawItems ?? []).entries()) {
      const raw = item as Record<string, unknown>;
      const id = contributionId(app.manifest.id, raw, String(index));
      if (point === 'nav.module') {
        cleanups.push(
          kernelRegistry.register(app.manifest.id, point, {
            id,
            label: typeof raw.label === 'string' ? raw.label : app.manifest.name,
            iconUrl: typeof raw.icon === 'string' ? raw.icon : app.manifest.icon,
            icon: Blocks,
            render: () => <AppModule appId={app.manifest.id} />,
          }),
        );
      } else if (point === 'panel.right') {
        cleanups.push(
          kernelRegistry.register(app.manifest.id, point, {
            id,
            render: () => <AppPanel appId={app.manifest.id} />,
          }),
        );
      } else if (point === 'message.action') {
        cleanups.push(
          kernelRegistry.register(app.manifest.id, point, {
            id,
            label: typeof raw.label === 'string' ? raw.label : `用 ${app.manifest.name} 打开`,
            icon: Blocks,
            run: ({ message }) => {
              emitAfterOpen(app.manifest.id, 'message.action', {
                contributionId: id,
                message: plainMessage(message),
              });
            },
          }),
        );
      } else if (point === 'message.renderer') {
        const messageType = typeof raw.messageType === 'string' ? raw.messageType : undefined;
        const attachmentType = typeof raw.attachmentType === 'string' ? raw.attachmentType : undefined;
        if (!messageType && !attachmentType) continue;
        cleanups.push(
          kernelRegistry.register(app.manifest.id, point, {
            id,
            match: ({ message, attachment }) =>
              (!!messageType && message.t === messageType) ||
              (!!attachmentType && (attachment as Record<string, unknown> | undefined)?.type === attachmentType),
            render: () => (
              <button
                onClick={() => {
                  const module = kernelRegistry
                    .get('nav.module')
                    .find((candidate) => kernelRegistry.ownerOf('nav.module', candidate) === app.manifest.id);
                  if (module) activeKernelHost.navigation.setModule(module.id);
                }}
                className="my-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-left text-xs text-primary"
              >
                在 {app.manifest.name} 中打开
              </button>
            ),
          }),
        );
      } else if (point === 'composer.command' && typeof raw.name === 'string') {
        cleanups.push(
          kernelRegistry.register(app.manifest.id, point, {
            id,
            name: raw.name.replace(/^\//, '').toLowerCase(),
            description:
              typeof raw.description === 'string'
                ? raw.description
                : typeof raw.desc === 'string'
                  ? raw.desc
                  : app.manifest.name,
            params: typeof raw.params === 'string' ? raw.params : undefined,
            run: (context) =>
              emitAfterOpen(app.manifest.id, 'composer.command', { contributionId: id, ...context }),
          }),
        );
      } else if (point === 'composer.trigger' && typeof raw.prefix === 'string') {
        cleanups.push(
          kernelRegistry.register(app.manifest.id, point, {
            id,
            prefix: raw.prefix,
            run: (context) =>
              emitAfterOpen(app.manifest.id, 'composer.trigger', { contributionId: id, ...context }),
          }),
        );
      } else if (point === 'entity.link' && typeof raw.pattern === 'string') {
        let prefix: URL;
        try {
          prefix = new URL(raw.pattern);
        } catch {
          continue;
        }
        cleanups.push(
          kernelRegistry.register(app.manifest.id, point, {
            id,
            match: (url) => {
              try {
                const candidate = new URL(url);
                return candidate.origin === prefix.origin && candidate.pathname.startsWith(prefix.pathname);
              } catch {
                return false;
              }
            },
            render: (url, key) => (
              <a key={key} href={url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                {typeof raw.label === 'string' ? raw.label : app.manifest.name}
              </a>
            ),
          }),
        );
      } else if (
        ['composer.action', 'home.widget', 'room.tab', 'settings.page', 'background.task'].includes(point)
      ) {
        cleanups.push(
          kernelRegistry.register(
            app.manifest.id,
            point as ExtensionPoint,
            { ...raw, id } as ReservedContribution,
          ),
        );
      }
    }
  }
  return async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    bridgeHost.clearApp(app.manifest.id);
    permissionGate.revokeApp(app.manifest.id);
    const module = activeKernelHost.navigation.currentModule();
    if (module.startsWith(`app:${app.manifest.id}:`)) activeKernelHost.navigation.setModule('messages');
    const panel = activeKernelHost.navigation.currentPanel();
    if (panel?.startsWith(`app:${app.manifest.id}:`)) activeKernelHost.navigation.setPanel(null);
  };
}

function WorkbenchModule() {
  const connected = activeKernelHost.workbench.useConnected();
  return connected ? <WorkbenchPage /> : <SettingsPage initialSection="workbench" />;
}

function registerBuiltins(): void {
  const features = runtimeFeatures();
  const aiRuntimeProvider = getAiRuntimeProvider();
  const modules = [
    ['workbench', '工作台', WorkbenchModule, undefined],
    ['butler-view', '管家', ButlerPage, Bell],
    ['todos', '待办', TodosPage, undefined],
    ['calendar', '日历', CalendarPage, undefined],
    ['contacts', '通讯录', ContactsPage, undefined],
  ] as const;
  for (const [id, label, render, icon] of modules) {
    if (id === 'butler-view' && !features.butler) continue;
    kernelRegistry.register('core', 'nav.module', { id, label, render, ...(icon ? { icon } : {}) });
    if (id === 'calendar' && isTauri) {
      kernelRegistry.register('core', 'nav.module', {
        id: 'downloads',
        label: '下载',
        render: DownloadsPage,
        icon: Download,
      });
    }
  }
  const panels = [
    ['thread', ThreadPanel],
    ['pins', PinPanel],
    ['starred', StarredPanel],
    ['members', MembersPanel],
    ['search', SearchPanel],
    ['info', RoomInfoPanel],
    ['files', FilesPanel],
    ['mentions', MentionsPanel],
    ['ai', SummaryPanel],
    ['butler', ButlerPanel],
    ['agent', AgentPanel],
  ] as const;
  for (const [id, render] of panels) {
    if (
      (id === 'ai' && (!features.ai || aiRuntimeProvider !== 'codex'))
      || (id === 'butler' && !features.butler)
      || (id === 'agent' && !features.sharedAgent)
    ) continue;
    kernelRegistry.register('core', 'panel.right', { id, render });
  }
  if (features.ai) {
    kernelRegistry.register('core', 'composer.command', {
      id: 'summary',
      name: 'summary',
      description: '用 AI 管家总结当前会话未读消息',
      run: ({ rid }) => {
        void summarizeRoom(rid);
      },
    });
    kernelRegistry.register('core', 'composer.command', {
      id: 'butler',
      name: 'ai',
      description: '打开 AI 管家，可直接跟上问题',
      params: '问题（可选）',
      run: runButlerCommand,
    });
    if (aiRuntimeProvider === 'codex') kernelRegistry.register('core', 'composer.trigger', {
      id: 'codex',
      prefix: '$codex',
      run: async (context) => {
        // M8 话题即会话：指令必须先成为普通 Rocket.Chat 消息，宿主再从消息流触发 Agent。
        if (context.tmid) return false;
        try {
          const prompt = context.text.replace(/^\$codex(?:\s+|$)/i, '').trim();
          if (!prompt) throw new Error('$codex 后面需要写任务');
          await handoffToCodexTask(prompt, '来自聊天的 Codex 任务');
        } catch (error) {
          activeKernelHost.notifications.error(error, 'Codex 任务创建失败');
        }
      },
    });
  }
  if (features.sharedAgent) {
    kernelRegistry.register('core', 'composer.command', {
      id: 'agent-exit',
      name: 'exit',
      description: '结束当前话题的共享 Agent 会话',
      run: async ({ tmid }) => {
        if (!tmid) throw new Error('/exit 只能在话题中结束共享 Agent 会话');
        await endSharedAgentSession(tmid);
      },
    });
  }
}

async function registerBridgeEvents(host: KernelHost): Promise<void> {
  if (bridgeEventsStarted) return;
  bridgeEventsStarted = true;
  const cleanups: Array<() => void | Promise<void>> = [];
  if (runtimeFeatures().sharedAgent) {
    await runSharedAgentBridge();
  }
  if (isTauri) {
    const unlisten = await listen<{ appId: string; event: string; payload: unknown }>(
      'rocketx://native-service-event',
      ({ payload }) => bridgeHost.emit(payload.appId, 'native.event', {
        event: payload.event,
        payload: payload.payload,
      }),
    );
    cleanups.push(unlisten);
  }
  cleanups.push(host.events.subscribeChat((state, previous) => {
    if (state.activeRid !== previous.activeRid) {
      bridgeHost.emitAll('room.changed', { rid: state.activeRid });
    }
    const rid = state.activeRid;
    if (!rid || state.messages[rid] === previous.messages[rid]) return;
    const latest = state.messages[rid]?.at(-1);
    const previousLatest = previous.messages[rid]?.at(-1);
    if (latest && latest._id !== previousLatest?._id) {
      bridgeHost.emitAll('message.received', plainMessage(latest));
    }
  }));
  const root = document.documentElement;
  const observer = new MutationObserver(() => {
    bridgeHost.emitAll('theme.changed', { theme: root.dataset.theme ?? 'light' });
  });
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  cleanups.push(() => observer.disconnect());
  bridgeEventCleanups = cleanups;
}

export async function initializeKernel(
  host: KernelHost = defaultKernelHost,
  signal?: AbortSignal,
): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;
  initializing = (async () => {
    if (signal?.aborted) throw new Error('扩展内核启动已取消');
    activeKernelHost = host;
    setActiveAppManager(installedApps);
    if (!setupComplete) {
      registerCapabilities(host);
      registerBuiltins();
      activeKernelHost.navigation.installModuleValidator(
        (module) =>
          module === 'messages' ||
          module === 'settings' ||
          kernelRegistry.get('nav.module').some((candidate) => candidate.id === module),
      );
      await registerBridgeEvents(host);
      installedApps.setActivator(activateApp);
      bridgeHost.start();
      if (runtimeFeatures().routines) activeKernelHost.background.startRoutines();
      setupComplete = true;
    }
    await installedApps.hydrate(BUNDLED_APPS);
    if (signal?.aborted) {
      throw new Error('扩展内核启动已取消');
    }
    initialized = true;
  })()
    .catch(async (error) => {
      initialized = false;
      await teardownKernel().catch(() => undefined);
      throw error;
    })
    .finally(() => {
      initializing = null;
    });
  return initializing;
}

async function teardownKernel(): Promise<void> {
  await installedApps.deactivateAll();
  await Promise.resolve(activeKernelHost.agent.stopBridge()).catch(() => undefined);
  await Promise.all(bridgeEventCleanups.map((cleanup) => Promise.resolve(cleanup()).catch(() => undefined)));
  bridgeEventCleanups = [];
  bridgeHost.stop();
  capabilityBus.clear();
  kernelRegistry.clear();
  bridgeEventsStarted = false;
  setupComplete = false;
  initialized = false;
  activeKernelHost = defaultKernelHost;
}

export async function shutdownKernel(): Promise<void> {
  await initializing?.catch(() => undefined);
  await teardownKernel();
}
