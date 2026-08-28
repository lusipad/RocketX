import type { RoomType } from '@rcx/rc-client';
import { rest } from './client';
import { currentLanPeers, redactedLanPeers } from '../lan/runtime';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { useUI } from '../stores/ui';
import { useWorkbench } from '../stores/workbench';
import { toast } from '../stores/toast';
import { installModuleValidator } from '../stores/ui';
import { startRoutineScheduler } from '../stores/routines';
import { postBridgeMessageForPort } from '../kernel/postMessage';
import { createDefaultKernelChatPostPort } from './kernelChatPostMessage';
import type {
  KernelChatEventState,
  KernelHost,
  KernelLanPeer,
} from '../kernel/host';

function eventState(state: ReturnType<typeof useChat.getState>): KernelChatEventState {
  return { activeRid: state.activeRid, messages: state.messages };
}

function roomType(type: string | undefined): RoomType | null {
  return type === 'c' || type === 'p' || type === 'd' || type === 'l' ? type : null;
}

export function createDefaultKernelHost(): KernelHost {
  return {
    identity: {
      userId: () => useAuth.getState().user?._id ?? null,
    },
    chat: {
      current: () => {
        const state = useChat.getState();
        const rid = state.activeRid;
        return { rid, messages: rid ? (state.messages[rid] ?? []).slice(-50) : [] };
      },
      history: (rid, count) => useChat.getState().messages[rid]?.slice(-count) ?? [],
      postMessage: (rid, text, tmid) =>
        postBridgeMessageForPort(createDefaultKernelChatPostPort(), rid, text, tmid),
    },
    rooms: {
      list: () =>
        Object.values(useChat.getState().subscriptions).map((subscription) => ({
          rid: subscription.rid,
          name: subscription.fname || subscription.name,
          type: subscription.t,
          unread: subscription.unread ?? 0,
        })),
      isMember: (rid) => !!useChat.getState().subscriptions[rid],
      typeOf: (rid) => roomType(useChat.getState().subscriptions[rid]?.t),
      memberIds: (rid) => [
        ...(useChat.getState().rooms[rid]?.uids ?? []),
        ...(useChat.getState().members[rid] ?? []).map((user) => user._id),
      ],
    },
    users: {
      read: (rid) =>
        rid
          ? (useChat.getState().members[rid] ?? []).map((user) => ({
              _id: user._id,
              username: user.username,
              name: user.name,
              status: user.status,
            }))
          : [],
    },
    files: {
      list: (rid, type, count) => rest.domains.files.getRoomFiles(rid, type, count),
      read: (path) => rest.domains.files.fetchFile(path),
    },
    lan: {
      listPeers: () => redactedLanPeers(currentLanPeers()) as KernelLanPeer[],
    },
    navigation: {
      currentModule: () => useUI.getState().module,
      setModule: (module) => useUI.getState().setModule(module as Parameters<ReturnType<typeof useUI.getState>['setModule']>[0]),
      currentPanel: () => useChat.getState().rightPanel?.kind ?? null,
      setPanel: (kind) => useChat.getState().setPanel(kind ? { kind: kind as never } : null),
      installModuleValidator: (validator) => installModuleValidator(validator as Parameters<typeof installModuleValidator>[0]),
    },
    events: {
      subscribeChat: (listener) =>
        useChat.subscribe((state, previous) => listener(eventState(state), eventState(previous))),
    },
    workbench: { useConnected: () => !!useWorkbench((state) => state.config?.adoBase) },
    notifications: {
      info: (message) => toast.info(String(message)),
      success: (message) => toast.success(String(message)),
      error: (message, title) => toast.error(message, title),
    },
    background: { startRoutines: startRoutineScheduler },
    ai: {
      summarize: async (rid) => {
        const { useAiAssistant } = await import('../stores/aiAssistant');
        await useAiAssistant.getState().summarize(rid);
      },
    },
    agent: {
      endSession: async (tmid) => {
        const { useSharedAgent } = await import('../stores/sharedAgent');
        await useSharedAgent.getState().endSession(tmid);
      },
      startBridge: async () => {
        const { startSharedAgentBridge } = await import('../stores/sharedAgent');
        await startSharedAgentBridge();
      },
      stopBridge: async () => {
        const { stopSharedAgentBridge } = await import('../stores/sharedAgent');
        stopSharedAgentBridge();
      },
    },
  };
}
