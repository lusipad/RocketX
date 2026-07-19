import type { RcMessage } from '@rcx/rc-client';
import { Bell, Blocks, TerminalSquare } from 'lucide-react';
import { getServerBase, httpFetch, rest } from '../lib/client';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { installModuleValidator, useUI } from '../stores/ui';
import { useWorkbench } from '../stores/workbench';
import { startRoutineScheduler } from '../stores/routines';
import ContactsPage from '../pages/ContactsPage';
import TodosPage from '../pages/TodosPage';
import CalendarPage from '../pages/CalendarPage';
import WorkbenchPage from '../pages/WorkbenchPage';
import SettingsPage from '../pages/SettingsPage';
import ButlerPage from '../pages/ButlerPage';
import CodexPage from '../pages/CodexPage';
import ThreadPanel from '../components/ThreadPanel';
import AgentPanel from '../components/AgentPanel';
import PinPanel from '../components/PinPanel';
import StarredPanel from '../components/StarredPanel';
import MembersPanel from '../components/MembersPanel';
import SearchPanel from '../components/SearchPanel';
import RoomInfoPanel from '../components/RoomInfoPanel';
import FilesPanel from '../components/FilesPanel';
import MentionsPanel from '../components/MentionsPanel';
import SummaryPanel from '../components/SummaryPanel';
import ButlerPanel from '../components/ButlerPanel';
import { useAiAssistant } from '../stores/aiAssistant';
import { startSharedAgentBridge, useSharedAgent } from '../stores/sharedAgent';
import { AppManager, setActiveAppManager, type InstalledApp } from './installed';
import { PermissionGate } from './permission';
import { CapabilityBus } from './capabilities/bus';
import { BridgeHost } from './bridge';
import { kernelRegistry } from './registry';
import { AppModule, AppPanel } from './AppFrame';
import type { ExtensionPoint, ReservedContribution } from './types';
import { createSandboxedWorker } from './sandbox/worker';
import { ensureHttpOrigin } from '../lib/http';
import { hydrateButlerArchive } from '../lib/butlerArchive';
import { initializeAiRuntime } from './ai/runtime';
import { kernelStore } from './store';
import { runCodexTrigger } from '../lib/codexOnce';
import { currentLanPeers, redactedLanPeers, sendLanChat } from '../lan/runtime';
import { runButlerCommand } from './butler';

export { kernelStore } from './store';
export const permissionGate = new PermissionGate((entry) => kernelStore.audit.append(entry).then(() => {}));
export const capabilityBus = new CapabilityBus(permissionGate);
export const bridgeHost = new BridgeHost(capabilityBus);
export const installedApps = new AppManager(kernelStore);

let initialized = false;
let bridgeEventsStarted = false;

function WorkbenchModule() {
  const config = useWorkbench((state) => state.config);
  const connected = !!(
    config && (config.mode === 'direct' ? config.adoBase : config.bridge)
  );
  return connected ? <WorkbenchPage /> : <SettingsPage initialSection="workbench" />;
}

function scopedAppId(appId: string): string {
  const userId = useAuth.getState().user?._id ?? 'guest';
  return `${userId}@${getServerBase() || 'same-origin'}:${appId}`;
}

function stringParam(params: unknown, key: string, fallback = ''): string {
  const value = params && typeof params === 'object' ? (params as Record<string, unknown>)[key] : undefined;
  return typeof value === 'string' ? value : fallback;
}

function plainMessage(message: RcMessage): RcMessage {
  return structuredClone(message);
}

function registerCapabilities(): void {
  capabilityBus.register('chat.current', 'chat:read', () => {
    const chat = useChat.getState();
    const rid = chat.activeRid;
    return {
      rid,
      messages: rid ? (chat.messages[rid] ?? []).slice(-50).map(plainMessage) : [],
    };
  });
  capabilityBus.register('chat.history', 'chat:history', (params) => {
    const chat = useChat.getState();
    const rid = stringParam(params, 'rid', chat.activeRid ?? '');
    const count = Math.min(200, Math.max(1, Number((params as { count?: unknown } | undefined)?.count) || 50));
    if (!rid || (!chat.subscriptions[rid] && rid !== chat.activeRid)) throw new Error('无权读取这个会话');
    return (chat.messages[rid] ?? []).slice(-count).map(plainMessage);
  });
  capabilityBus.register('chat.postMessage', 'chat:write', async (params) => {
    const chat = useChat.getState();
    const rid = stringParam(params, 'rid', chat.activeRid ?? '');
    const text = stringParam(params, 'text').trim();
    const tmid = stringParam(params, 'tmid') || undefined;
    if (!rid || !chat.subscriptions[rid]) throw new Error('只能向已加入的会话发送消息');
    if (!text || text.length > 20_000) throw new Error('消息为空或过长');
    await chat.send(text, { rid, ...(tmid ? { tmid } : {}) });
    return { ok: true };
  });
  capabilityBus.register('rooms.list', 'rooms:list', () => {
    const chat = useChat.getState();
    return Object.values(chat.subscriptions).map((subscription) => ({
      rid: subscription.rid,
      name: subscription.fname || subscription.name,
      type: subscription.t,
      unread: subscription.unread ?? 0,
    }));
  });
  capabilityBus.register('users.read', 'users:read', () => {
    const chat = useChat.getState();
    const rid = chat.activeRid;
    return rid
      ? (chat.members[rid] ?? []).map((user) => ({
          _id: user._id,
          username: user.username,
          name: user.name,
          status: user.status,
        }))
      : [];
  });
  capabilityBus.register('files.list', 'files:read', async (params) => {
    const chat = useChat.getState();
    const rid = stringParam(params, 'rid', chat.activeRid ?? '');
    const type = chat.subscriptions[rid]?.t;
    if (!rid || !type) throw new Error('只能读取已加入会话的文件');
    return rest.getRoomFiles(rid, type, 50);
  });
  capabilityBus.register('files.read', 'files:read', async (params) => {
    const path = stringParam(params, 'path');
    const server = getServerBase();
    if (!path.startsWith('/') && !(server && path.startsWith(`${server}/`))) {
      throw new Error('只能读取当前 Rocket.Chat 服务器的文件');
    }
    const blob = await rest.fetchFile(path);
    if (blob.size > 10 * 1024 * 1024) throw new Error('Bridge 单次文件读取上限为 10 MB');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return { type: blob.type, size: blob.size, base64: btoa(binary) };
  });
  capabilityBus.register('lan.peers', 'lan:discover', () =>
    redactedLanPeers(currentLanPeers()),
  );
  capabilityBus.register('lan.send', 'lan:transfer', async (params) => {
    const object = params as Record<string, unknown> | undefined;
    const userId = stringParam(params, 'userId');
    const roomId = stringParam(params, 'roomId');
    const text = stringParam(params, 'text');
    const chat = useChat.getState();
    if (!roomId || !chat.subscriptions[roomId]) throw new Error('只能向已加入的会话发送 LAN 数据');
    const memberIds = new Set([
      ...(chat.rooms[roomId]?.uids ?? []),
      ...(chat.members[roomId] ?? []).map((user) => user._id),
    ]);
    if (!userId || !memberIds.has(userId)) {
      throw new Error('LAN 接收方必须是当前会话成员');
    }
    if (!text || text.length > 48 * 1024) throw new Error('LAN 数据为空或超过 48 KiB');
    const messageId =
      typeof object?.messageId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(object.messageId)
        ? object.messageId
        : crypto.randomUUID().replace(/-/g, '').slice(0, 17);
    await sendLanChat(userId, {
      messageId,
      roomId,
      originalTs: Date.now(),
      text,
    });
    return { ok: true, messageId };
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
    if (props.level === 'error') toast.error(message);
    else if (props.level === 'success') toast.success(message);
    else toast.info(message);
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
    useUI.getState().setModule(module.id);
    return;
  }
  const panel = kernelRegistry
    .get('panel.right')
    .find((candidate) => kernelRegistry.ownerOf('panel.right', candidate) === appId);
  if (panel && panel.id.startsWith('app:')) {
    useChat.getState().setPanel({ kind: panel.id as `app:${string}` });
  }
}

function emitAfterOpen(appId: string, event: string, payload: unknown): void {
  openAppSurface(appId);
  bridgeHost.emit(appId, event, payload);
}

function activateApp(app: InstalledApp): () => void {
  permissionGate.setGrant({ appId: app.manifest.id, granted: app.granted });
  const cleanups: Array<() => void> = [];
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
                  if (module) useUI.getState().setModule(module.id);
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
  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
    bridgeHost.clearApp(app.manifest.id);
    permissionGate.revokeApp(app.manifest.id);
    const module = useUI.getState().module;
    if (module.startsWith(`app:${app.manifest.id}:`)) useUI.getState().setModule('messages');
    const panel = useChat.getState().rightPanel;
    if (panel?.kind.startsWith(`app:${app.manifest.id}:`)) useChat.getState().setPanel(null);
  };
}

function registerBuiltins(): void {
  const modules = [
    ['butler-view', '管家', ButlerPage, Bell],
    ['todos', '待办', TodosPage, undefined],
    ['calendar', '日历', CalendarPage, undefined],
    ['workbench', '工作台', WorkbenchModule, undefined],
    ['contacts', '通讯录', ContactsPage, undefined],
    ['codex', 'Codex', CodexPage, TerminalSquare],
  ] as const;
  for (const [id, label, render, icon] of modules) {
    kernelRegistry.register('core', 'nav.module', { id, label, render, ...(icon ? { icon } : {}) });
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
    kernelRegistry.register('core', 'panel.right', { id, render });
  }
  kernelRegistry.register('core', 'composer.command', {
    id: 'summary',
    name: 'summary',
    description: '用 AI 总结当前会话未读消息',
    run: ({ rid }) => {
      useChat.getState().setPanel({ kind: 'ai' });
      void useAiAssistant.getState().summarize(rid);
    },
  });
  kernelRegistry.register('core', 'composer.command', {
    id: 'butler',
    name: 'ai',
    description: '打开 AI，可直接跟上问题',
    params: '问题（可选）',
    run: runButlerCommand,
  });
  kernelRegistry.register('core', 'composer.trigger', {
    id: 'codex',
    prefix: '$codex',
    run: async (context) => {
      // M8 话题即会话：指令必须先成为普通 Rocket.Chat 消息，宿主再从消息流触发 Agent。
      if (context.tmid) return false;
      try {
        await runCodexTrigger(context);
      } catch (error) {
        toast.error(error, 'Codex 执行失败');
      }
    },
  });
  kernelRegistry.register('core', 'composer.command', {
    id: 'agent-exit',
    name: 'exit',
    description: '结束当前话题的共享 Agent 会话',
    run: async ({ tmid }) => {
      if (!tmid) throw new Error('/exit 只能在话题中结束共享 Agent 会话');
      await useSharedAgent.getState().endSession(tmid);
    },
  });
}

function registerBridgeEvents(): void {
  if (bridgeEventsStarted) return;
  bridgeEventsStarted = true;
  startSharedAgentBridge();
  useChat.subscribe((state, previous) => {
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
  });
  const root = document.documentElement;
  new MutationObserver(() => {
    bridgeHost.emitAll('theme.changed', { theme: root.dataset.theme ?? 'light' });
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}

export function initializeKernel(): void {
  if (initialized) return;
  initialized = true;
  setActiveAppManager(installedApps);
  initializeAiRuntime(kernelStore);
  registerCapabilities();
  registerBuiltins();
  installModuleValidator(
    (module) =>
      module === 'messages' ||
      module === 'settings' ||
      kernelRegistry.get('nav.module').some((candidate) => candidate.id === module),
  );
  registerBridgeEvents();
  installedApps.setActivator(activateApp);
  bridgeHost.start();
  void hydrateButlerArchive().finally(startRoutineScheduler);
  void installedApps.hydrate().catch((error) => toast.error(error, '加载扩展应用失败'));
}
