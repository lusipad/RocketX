import { lazy, Suspense, type ComponentType } from 'react';
import type { RcMessage } from '@rcx/rc-client';
import { Bell, Blocks, Download } from 'lucide-react';
import { getServerBase } from '../lib/serverEndpoint';
import { httpFetch, isTauri } from '../lib/http';
import { registerUserRuntimeShutdownHook } from '../lib/runtimeLifecycle';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AppManager, isOfficialApp, setActiveAppManager, type InstalledApp } from './installed';
import { BUNDLED_APPS } from './bundled';
import { PermissionGate } from './permission';
import { CapabilityBus } from './capabilities/bus';
import { registerHostCapabilities } from './capabilities/host';
import { BridgeHost } from './bridge';
import { diffChatMessages } from './chatEvents';
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
import { t, useT } from '../i18n';

export { ensureKernelStoreReady, kernelStore } from './store';
export const permissionGate = new PermissionGate((entry) => kernelStore.audit.append(entry).then(() => {}));
export const capabilityBus = new CapabilityBus(permissionGate);
export const bridgeHost = new BridgeHost(capabilityBus);
export const installedApps = new AppManager(kernelStore);

let initialized = false;
let initializing: Promise<void> | null = null;
let setupComplete = false;
let coreBuiltinsRegistered = false;
let aiBuiltinsRegistered = false;
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
const KanbanPanel = lazyComponent(() => import('../components/KanbanPanel'));
const OncallPanel = lazyComponent(() => import('../components/OncallPanel'));
const SummaryPanel = lazyComponent(() => import('../components/SummaryPanel'));
const ButlerPanel = lazyComponent(() => import('../components/ButlerPanel'));
const AgentPanel = lazyComponent(() => import('../components/AgentPanel'));

async function summarizeRoom(rid: string): Promise<void> {
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
  if (!isTauri) throw new Error(t('settings.kernel.runtime.nativeServiceDesktopOnly'));
  if (!isOfficialApp(app) || app.source.kind !== 'bundled') {
    throw new Error(t('settings.kernel.runtime.nativeServiceBundledOnly'));
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
    if (!app) throw new Error(t('settings.kernel.runtime.appNotInstalled'));
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
    if (!isTauri) throw new Error(t('settings.kernel.runtime.filePickerDesktopOnly'));
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      title: t('settings.kernel.runtime.filePickerTitle'),
      multiple: false,
      directory: false,
    });
    return typeof selected === 'string' ? { path: selected } : { cancelled: true };
  });
  capabilityBus.register('native.call', 'native:service', async (params, context) => {
    const app = installedApps.get(context.appId);
    if (!app?.manifest.service || !isOfficialApp(app) || app.source.kind !== 'bundled') {
      throw new Error(t('settings.kernel.runtime.noSignedNativeService'));
    }
    if (app.manifest.service.platforms && !app.manifest.service.platforms.includes(desktopPlatform())) {
      throw new Error(
        t('settings.kernel.runtime.nativeServiceUnsupportedPlatform', { platform: desktopPlatform() }),
      );
    }
    const object = params as { method?: unknown; params?: unknown } | undefined;
    if (typeof object?.method !== 'string' || !object.method) {
      throw new Error(t('settings.kernel.runtime.nativeCallMissingMethod'));
    }
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
      throw new Error(t('settings.kernel.runtime.envNotDeclared'));
    }
    if (!isTauri) throw new Error(t('settings.kernel.runtime.envDesktopOnly'));
    const values = await invoke<Record<string, string>>('app_env_get', { names: [name] });
    return { name, value: values[name] ?? null };
  });
  capabilityBus.register('storage.get', 'storage:local', (params, context) =>
    kernelStore.appData.get(scopedAppId(context.appId), stringParam(params, 'key')),
  );
  capabilityBus.register('storage.set', 'storage:local', async (params, context) => {
    const object = params as { key?: unknown; value?: unknown } | undefined;
    if (typeof object?.key !== 'string' || !object.key) {
      throw new Error(t('settings.kernel.runtime.storageMissingKey'));
    }
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
      throw new Error(t('settings.kernel.runtime.requestUiNotifyOnly'));
    }
    const message = props.message.slice(0, 500);
    if (props.level === 'error') activeKernelHost.notifications.error(message);
    else if (props.level === 'success') activeKernelHost.notifications.success(message);
    else activeKernelHost.notifications.info(message);
    return { ok: true };
  });
  capabilityBus.register('net.fetch', 'net:fetch', async (params, context) => {
    const object = params as { url?: unknown; method?: unknown; headers?: unknown; body?: unknown } | undefined;
    if (typeof object?.url !== 'string') throw new Error(t('settings.kernel.runtime.netFetchMissingUrl'));
    const url = new URL(object.url);
    if (!context.manifest.netAllow?.includes(url.origin)) {
      throw new Error(t('settings.kernel.runtime.netAllowDenied', { origin: url.origin }));
    }
    const method = typeof object.method === 'string' ? object.method.toUpperCase() : 'GET';
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new Error(t('settings.kernel.runtime.netFetchUnsupportedMethod', { method }));
    }
    const headers = new Headers();
    if (object.headers && typeof object.headers === 'object') {
      for (const [key, value] of Object.entries(object.headers as Record<string, unknown>)) {
        if (typeof value === 'string' && !/^(authorization|cookie|proxy-authorization)$/i.test(key)) {
          headers.set(key, value);
        }
      }
    }
    const body = typeof object.body === 'string' ? object.body : undefined;
    if (body && body.length > 1024 * 1024) throw new Error(t('settings.kernel.runtime.netFetchBodyLimit'));
    await ensureHttpOrigin(url);
    const response = await httpFetch(
      url,
      { method, headers, body, redirect: 'manual', maxRedirections: 0 } as RequestInit,
    );
    if (response.status >= 300 && response.status < 400) {
      throw new Error(t('settings.kernel.runtime.netFetchNoRedirect'));
    }
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error(t('settings.kernel.runtime.netFetchResponseLimit'));
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

function OpenInAppButton({ appId, appName }: { appId: string; appName: string }) {
  const translate = useT();
  return (
    <button
      onClick={() => {
        const module = kernelRegistry
          .get('nav.module')
          .find((candidate) => kernelRegistry.ownerOf('nav.module', candidate) === appId);
        if (module) activeKernelHost.navigation.setModule(module.id);
      }}
      className="my-1 rounded-md border border-line bg-surface-2 px-3 py-2 text-left text-xs text-primary"
    >
      {translate('settings.kernel.runtime.openInApp', { name: appName })}
    </button>
  );
}

function activateApp(app: InstalledApp): () => void | Promise<void> {
  permissionGate.setGrant({ appId: app.manifest.id, granted: app.granted });
  const cleanups: Array<() => void | Promise<void>> = [];
  if (app.manifest.service && app.granted.includes('native:service')) {
    const start = startNativeService(app);
    nativeServiceStarts.set(app.manifest.id, start);
    void start.catch((error) =>
      activeKernelHost.notifications.error(
        error,
        t('settings.kernel.runtime.nativeServiceStartFailed', { name: app.manifest.name }),
      ),
    );
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
            render: () => <AppModule appId={app.manifest.id} bridge={bridgeHost} />,
          }),
        );
      } else if (point === 'panel.right') {
        cleanups.push(
          kernelRegistry.register(app.manifest.id, point, {
            id,
            render: () => <AppPanel appId={app.manifest.id} bridge={bridgeHost} />,
          }),
        );
      } else if (point === 'message.action') {
        cleanups.push(
          kernelRegistry.register(app.manifest.id, point, {
            id,
            label:
              typeof raw.label === 'string'
                ? raw.label
                : t('settings.kernel.runtime.openWithApp', { name: app.manifest.name }),
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
            render: () => <OpenInAppButton appId={app.manifest.id} appName={app.manifest.name} />,
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

function registerCoreNavModules(features: ReturnType<typeof runtimeFeatures>): void {
  const modules = [
    ['workbench', t('settings.kernel.module.workbench'), WorkbenchModule, undefined],
    ['butler-view', t('settings.kernel.module.butler'), ButlerPage, Bell],
    ['todos', t('settings.kernel.module.todos'), TodosPage, undefined],
    ['calendar', t('settings.kernel.module.calendar'), CalendarPage, undefined],
    ['contacts', t('settings.kernel.module.contacts'), ContactsPage, undefined],
  ] as const;
  for (const [id, label, render, icon] of modules) {
    if (id === 'butler-view' && !features.butler) continue;
    if (kernelRegistry.get('nav.module').some((candidate) => candidate.id === id)) continue;
    kernelRegistry.register('core', 'nav.module', { id, label, render, ...(icon ? { icon } : {}) });
    if (id === 'calendar' && isTauri && !kernelRegistry.get('nav.module').some((candidate) => candidate.id === 'downloads')) {
      kernelRegistry.register('core', 'nav.module', {
        id: 'downloads',
        label: t('settings.kernel.module.downloads'),
        render: DownloadsPage,
        icon: Download,
      });
    }
  }
}

export function ensureCoreModulesRegistered(host: KernelHost = defaultKernelHost): void {
  const features = runtimeFeatures();
  if (!features.bootKernel) return;
  if (coreBuiltinsRegistered && kernelRegistry.get('nav.module').length > 0) return;
  coreBuiltinsRegistered = true;
  registerCoreNavModules(features);
  const basePanels = [
    ['thread', ThreadPanel],
    ['pins', PinPanel],
    ['starred', StarredPanel],
    ['members', MembersPanel],
    ['search', SearchPanel],
    ['info', RoomInfoPanel],
    ['files', FilesPanel],
    ['mentions', MentionsPanel],
    ['kanban', KanbanPanel],
    ['oncall', OncallPanel],
    ['butler', ButlerPanel],
    ['agent', AgentPanel],
  ] as const;
  for (const [id, render] of basePanels) {
    if (
      (id === 'butler' && !features.butler)
      || (id === 'agent' && !features.sharedAgent)
      || kernelRegistry.get('panel.right').some((candidate) => candidate.id === id)
    ) continue;
    kernelRegistry.register('core', 'panel.right', { id, render });
  }
  host.navigation.installModuleValidator(
    (module) =>
      module === 'messages' ||
      module === 'settings' ||
      kernelRegistry.get('nav.module').some((candidate) => candidate.id === module),
  );
}

export function syncAiKernelBuiltins(): void {
  const features = runtimeFeatures();
  const aiRuntimeProvider = getAiRuntimeProvider();
  if (
    features.sharedAgent &&
    !kernelRegistry.get('composer.command').some((candidate) => candidate.id === 'agent-exit')
  ) {
    kernelRegistry.register('core', 'composer.command', {
      id: 'agent-exit',
      name: 'exit',
      description: t('settings.kernel.command.agentExitDesc'),
      run: async ({ tmid }) => {
        if (!tmid) throw new Error(t('settings.kernel.command.agentExitThreadOnly'));
        await endSharedAgentSession(tmid);
      },
    });
  }
  if (features.ai) {
    if (aiBuiltinsRegistered) return;
    aiBuiltinsRegistered = true;
    if (
      aiRuntimeProvider === 'pi' &&
      !kernelRegistry.get('panel.right').some((candidate) => candidate.id === 'ai')
    ) {
      kernelRegistry.register('core', 'panel.right', { id: 'ai', render: SummaryPanel });
    }
    if (!kernelRegistry.get('composer.command').some((candidate) => candidate.id === 'summary')) {
      kernelRegistry.register('core', 'composer.command', {
        id: 'summary',
        name: 'summary',
        description: t('settings.kernel.command.summaryDesc'),
        run: ({ rid }) => {
          void summarizeRoom(rid);
        },
      });
    }
    if (!kernelRegistry.get('composer.command').some((candidate) => candidate.id === 'butler')) {
      kernelRegistry.register('core', 'composer.command', {
        id: 'butler',
        name: 'ai',
        description: t('settings.kernel.command.butlerDesc'),
        params: t('settings.kernel.command.butlerParams'),
        run: runButlerCommand,
      });
    }
    if (
      aiRuntimeProvider === 'pi' &&
      !kernelRegistry.get('composer.trigger').some((candidate) => candidate.id === 'codex')
    ) {
      kernelRegistry.register('core', 'composer.trigger', {
        id: 'codex',
        prefix: '$codex',
        run: async (context) => {
          // M8 话题即会话：指令必须先成为普通 Rocket.Chat 消息，宿主再从消息流触发 Agent。
          if (context.tmid) return false;
          try {
            const prompt = context.text.replace(/^\$codex(?:\s+|$)/i, '').trim();
            if (!prompt) throw new Error(t('settings.kernel.trigger.codexMissingPrompt'));
            await handoffToCodexTask(prompt, t('settings.kernel.trigger.codexTitle'));
          } catch (error) {
            activeKernelHost.notifications.error(error, t('settings.kernel.trigger.codexCreateFailed'));
          }
        },
      });
    }
  }
}

function registerBuiltins(): void {
  ensureCoreModulesRegistered(activeKernelHost);
  syncAiKernelBuiltins();
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
    // 消息内容只推给获得 chat:read 授权的应用：零权限应用收不到消息，与
    // chat.current / chat.history 的权限口径一致。更新事件（回应/编辑）是
    // 应用实时计票的通道。
    const canReadChat = (appId: string) => permissionGate.has(appId, 'chat:read');
    const { received, updated } = diffChatMessages(state, previous);
    if (received) bridgeHost.emitWhere('message.received', plainMessage(received), canReadChat);
    for (const message of updated) {
      bridgeHost.emitWhere('message.updated', plainMessage(message), canReadChat);
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
    if (signal?.aborted) throw new Error(t('settings.kernel.runtime.initCancelled'));
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
      throw new Error(t('settings.kernel.runtime.initCancelled'));
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
  coreBuiltinsRegistered = false;
  aiBuiltinsRegistered = false;
  setupComplete = false;
  initialized = false;
  activeKernelHost = defaultKernelHost;
}

export async function shutdownKernel(): Promise<void> {
  await initializing?.catch(() => undefined);
  await teardownKernel();
}

registerUserRuntimeShutdownHook('kernel', () => shutdownKernel());
