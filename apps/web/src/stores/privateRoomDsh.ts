import { create } from 'zustand';
import {
  HostedDshController,
  type HostedDshControllerOptions,
} from '../agent/dsh/HostedDshController';
import type { DshTranscript } from '../agent/dsh/project';
import type {
  DshPendingApproval,
  DshPendingQuestion,
  DshQuestionAnswer,
} from '../agent/dsh/types';

export const PRIVATE_ROOM_DSH_STORAGE_KEY = 'rcx-private-room-dsh-sessions-v1';

interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type PrivateRoomDshStatus = 'connecting' | 'ready' | 'running' | 'waiting-input' | 'error';

export interface PrivateRoomDshSession {
  key: string;
  scope: string;
  rid: string;
  workspaceRoot: string;
  dshSessionId?: string;
  transcript: DshTranscript;
  status: PrivateRoomDshStatus;
  error?: string;
  approvals: DshPendingApproval[];
  questions: DshPendingQuestion[];
}

interface OpenPrivateRoomDshOptions {
  scope: string;
  rid: string;
  workspaceRoot: string;
}

interface PrivateRoomDshState {
  sessions: Record<string, PrivateRoomDshSession>;
  openRoom: (options: OpenPrivateRoomDshOptions) => Promise<string>;
  newRoomSession: (options: OpenPrivateRoomDshOptions) => Promise<string>;
  prompt: (key: string, text: string) => Promise<void>;
  cancel: (key: string) => Promise<void>;
  respondApproval: (key: string, approvalId: string, approved: boolean) => Promise<void>;
  respondQuestion: (key: string, rpcId: string, answers: DshQuestionAnswer[]) => Promise<void>;
}

type PrivateDshController = Pick<
  HostedDshController,
  | 'connect'
  | 'createSession'
  | 'resumeSession'
  | 'getTranscript'
  | 'prompt'
  | 'cancel'
  | 'respondApproval'
  | 'respondQuestion'
  | 'stop'
>;

type PrivateDshControllerFactory = (
  workspaceRoot: string,
  connectionId: string,
  options: HostedDshControllerOptions,
) => PrivateDshController;

const EMPTY_TRANSCRIPT: DshTranscript = { messages: [], activities: [] };
const roomOpenRequests = new Map<string, Promise<string>>();
let controller: PrivateDshController | null = null;
let controllerIdentity = '';
let controllerRequest: Promise<PrivateDshController> | null = null;
let storageOverride: SessionStorage | undefined;
let controllerFactory: PrivateDshControllerFactory = (workspaceRoot, connectionId, options) => (
  new HostedDshController(workspaceRoot, connectionId, options)
);

function browserStorage(): SessionStorage | undefined {
  if (storageOverride) return storageOverride;
  return typeof localStorage === 'undefined' ? undefined : localStorage;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function emptySession(options: OpenPrivateRoomDshOptions): PrivateRoomDshSession {
  return {
    key: privateRoomDshKey(options.scope, options.rid),
    ...options,
    transcript: EMPTY_TRANSCRIPT,
    status: 'connecting',
    approvals: [],
    questions: [],
  };
}

export function privateRoomDshKey(scope: string, rid: string): string {
  return `${scope}:${rid}`;
}

function readSessionMap(storage: SessionStorage | undefined = browserStorage()): Record<string, string> {
  if (!storage) return {};
  try {
    const parsed = JSON.parse(storage.getItem(PRIVATE_ROOM_DSH_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => (
      typeof entry[1] === 'string' && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

export function privateRoomDshSessionId(
  scope: string,
  rid: string,
  storage: SessionStorage | undefined = browserStorage(),
): string | undefined {
  return readSessionMap(storage)[privateRoomDshKey(scope, rid)];
}

function persistSessionId(key: string, sessionId?: string): void {
  const storage = browserStorage();
  if (!storage) return;
  const sessions = readSessionMap(storage);
  if (sessionId) sessions[key] = sessionId;
  else delete sessions[key];
  storage.setItem(PRIVATE_ROOM_DSH_STORAGE_KEY, JSON.stringify(sessions));
}

function sessionKeyById(sessionId: string): string | undefined {
  return Object.values(usePrivateRoomDsh.getState().sessions)
    .find((session) => session.dshSessionId === sessionId)?.key;
}

function refreshTranscript(sessionId: string): void {
  const key = sessionKeyById(sessionId);
  if (!key || !controller) return;
  const transcript = controller.getTranscript(sessionId);
  usePrivateRoomDsh.setState((state) => {
    const session = state.sessions[key];
    return session ? {
      sessions: { ...state.sessions, [key]: { ...session, transcript } },
    } : state;
  });
}

function updatePendingState(sessionId: string, update: (
  session: PrivateRoomDshSession,
) => PrivateRoomDshSession): void {
  const key = sessionKeyById(sessionId);
  if (!key) return;
  usePrivateRoomDsh.setState((state) => {
    const session = state.sessions[key];
    return session ? { sessions: { ...state.sessions, [key]: update(session) } } : state;
  });
}

function activeSessionStatus(session: PrivateRoomDshSession): boolean {
  return session.status === 'connecting'
    || session.status === 'ready'
    || session.status === 'running'
    || session.status === 'waiting-input';
}

function controllerOptions(identity: string): HostedDshControllerOptions {
  return {
    onSessionUpdated: refreshTranscript,
    onApproval: (approval) => updatePendingState(approval.sessionId, (session) => ({
      ...session,
      status: 'waiting-input',
      approvals: session.approvals.some((item) => item.approvalId === approval.approvalId)
        ? session.approvals
        : [...session.approvals, approval],
    })),
    onApprovalResolved: (sessionId, approvalId) => updatePendingState(sessionId, (session) => {
      const approvals = session.approvals.filter((item) => item.approvalId !== approvalId);
      return {
        ...session,
        approvals,
        status: approvals.length === 0 && session.questions.length === 0 ? 'running' : 'waiting-input',
      };
    }),
    onQuestion: (question) => updatePendingState(question.sessionId, (session) => ({
      ...session,
      status: 'waiting-input',
      questions: session.questions.some((item) => item.rpcId === question.rpcId)
        ? session.questions
        : [...session.questions, question],
    })),
    onQuestionResolved: (sessionId, rpcId) => updatePendingState(sessionId, (session) => {
      const questions = session.questions.filter((item) => item.rpcId !== rpcId);
      return {
        ...session,
        questions,
        status: questions.length === 0 && session.approvals.length === 0 ? 'running' : 'waiting-input',
      };
    }),
    onInterrupted: (error) => {
      if (controllerIdentity !== identity) return;
      usePrivateRoomDsh.setState((state) => ({
        sessions: Object.fromEntries(Object.entries(state.sessions).map(([key, session]) => {
          if (`${session.scope}\u0000${session.workspaceRoot}` !== identity || !activeSessionStatus(session)) {
            return [key, session];
          }
          return [key, {
            ...session,
            status: 'error' as const,
            error: error.message,
            approvals: [],
            questions: [],
          }];
        })),
      }));
      controller = null;
      controllerRequest = null;
    },
  };
}

async function ensureController(scope: string, workspaceRoot: string): Promise<PrivateDshController> {
  const identity = `${scope}\u0000${workspaceRoot}`;
  if (controller && controllerIdentity === identity) return controller;
  if (controllerRequest && controllerIdentity === identity) return controllerRequest;

  const previous = controller;
  controller = null;
  controllerRequest = null;
  controllerIdentity = identity;
  if (previous) await previous.stop().catch(() => undefined);

  const connectionId = `private-room-${scope.replace(/[^a-zA-Z0-9_-]/g, '').slice(-36) || 'local'}`;
  const next = controllerFactory(workspaceRoot, connectionId, controllerOptions(identity));
  const request = next.connect().then(() => {
    if (controllerIdentity !== identity) throw new Error('私人房间 AI 已切换账号或工作区');
    controller = next;
    return next;
  }).catch(async (error) => {
    if (controllerIdentity === identity) {
      controller = null;
      controllerRequest = null;
    }
    await next.stop().catch(() => undefined);
    throw error;
  });
  controllerRequest = request;
  return request;
}

function missingSession(error: unknown): boolean {
  return /not found|unknown session|不存在|找不到/iu.test(message(error));
}

async function openRoom(options: OpenPrivateRoomDshOptions, forceNew: boolean): Promise<string> {
  const key = privateRoomDshKey(options.scope, options.rid);
  const existingRequest = roomOpenRequests.get(key);
  if (existingRequest && !forceNew) return existingRequest;

  const request = (async () => {
    usePrivateRoomDsh.setState((state) => ({
      sessions: {
        ...state.sessions,
        [key]: {
          ...(state.sessions[key] ?? emptySession(options)),
          ...options,
          key,
          status: 'connecting',
          error: undefined,
        },
      },
    }));
    try {
      const activeController = await ensureController(options.scope, options.workspaceRoot);
      let sessionId = forceNew
        ? undefined
        : usePrivateRoomDsh.getState().sessions[key]?.dshSessionId
          ?? privateRoomDshSessionId(options.scope, options.rid);
      if (sessionId) {
        try {
          await activeController.resumeSession(sessionId);
        } catch (error) {
          if (!missingSession(error)) throw error;
          sessionId = undefined;
          persistSessionId(key);
        }
      }
      if (!sessionId) sessionId = await activeController.createSession();
      persistSessionId(key, sessionId);
      const transcript = activeController.getTranscript(sessionId);
      usePrivateRoomDsh.setState((state) => ({
        sessions: {
          ...state.sessions,
          [key]: {
            ...(state.sessions[key] ?? emptySession(options)),
            ...options,
            key,
            dshSessionId: sessionId,
            transcript,
            status: 'ready',
            error: undefined,
            approvals: [],
            questions: [],
          },
        },
      }));
      return sessionId;
    } catch (error) {
      usePrivateRoomDsh.setState((state) => {
        const session = state.sessions[key] ?? emptySession(options);
        return {
          sessions: {
            ...state.sessions,
            [key]: { ...session, status: 'error', error: message(error) },
          },
        };
      });
      throw error;
    }
  })().finally(() => {
    if (roomOpenRequests.get(key) === request) roomOpenRequests.delete(key);
  });
  roomOpenRequests.set(key, request);
  return request;
}

export const usePrivateRoomDsh = create<PrivateRoomDshState>((set, get) => ({
  sessions: {},
  openRoom: (options) => openRoom(options, false),
  newRoomSession: (options) => openRoom(options, true),
  prompt: async (key, text) => {
    const session = get().sessions[key];
    if (!session?.dshSessionId) throw new Error('请先打开私人房间 AI 会话');
    const activeController = await ensureController(session.scope, session.workspaceRoot);
    set((state) => ({
      sessions: {
        ...state.sessions,
        [key]: { ...session, status: 'running', error: undefined },
      },
    }));
    try {
      await activeController.prompt(session.dshSessionId, text);
      const transcript = activeController.getTranscript(session.dshSessionId);
      set((state) => {
        const latest = state.sessions[key];
        if (!latest) return state;
        return {
          sessions: {
            ...state.sessions,
            [key]: {
              ...latest,
              transcript,
              status: latest.approvals.length > 0 || latest.questions.length > 0 ? 'waiting-input' : 'ready',
            },
          },
        };
      });
    } catch (error) {
      set((state) => {
        const latest = state.sessions[key];
        return latest ? {
          sessions: {
            ...state.sessions,
            [key]: { ...latest, status: 'error', error: message(error) },
          },
        } : state;
      });
      throw error;
    }
  },
  cancel: async (key) => {
    const session = get().sessions[key];
    if (!session?.dshSessionId) return;
    const activeController = await ensureController(session.scope, session.workspaceRoot);
    await activeController.cancel(session.dshSessionId);
    set((state) => {
      const latest = state.sessions[key];
      return latest ? {
        sessions: { ...state.sessions, [key]: { ...latest, status: 'ready' } },
      } : state;
    });
  },
  respondApproval: async (key, approvalId, approved) => {
    const session = get().sessions[key];
    const approval = session?.approvals.find((item) => item.approvalId === approvalId);
    if (!session || !approval) return;
    const activeController = await ensureController(session.scope, session.workspaceRoot);
    await activeController.respondApproval(approval, approved);
    set((state) => {
      const latest = state.sessions[key];
      if (!latest) return state;
      const approvals = latest.approvals.filter((item) => item.approvalId !== approvalId);
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            ...latest,
            approvals,
            status: approvals.length === 0 && latest.questions.length === 0 ? 'running' : 'waiting-input',
          },
        },
      };
    });
  },
  respondQuestion: async (key, rpcId, answers) => {
    const session = get().sessions[key];
    const question = session?.questions.find((item) => item.rpcId === rpcId);
    if (!session || !question) return;
    const activeController = await ensureController(session.scope, session.workspaceRoot);
    await activeController.respondQuestion(question, answers);
    set((state) => {
      const latest = state.sessions[key];
      if (!latest) return state;
      const questions = latest.questions.filter((item) => item.rpcId !== rpcId);
      return {
        sessions: {
          ...state.sessions,
          [key]: {
            ...latest,
            questions,
            status: questions.length === 0 && latest.approvals.length === 0 ? 'running' : 'waiting-input',
          },
        },
      };
    });
  },
}));

export function setPrivateRoomDshStorageForTests(storage?: SessionStorage): () => void {
  const previous = storageOverride;
  storageOverride = storage;
  return () => {
    storageOverride = previous;
  };
}

export function setPrivateRoomDshControllerFactoryForTests(
  factory: PrivateDshControllerFactory,
): () => void {
  const previous = controllerFactory;
  controllerFactory = factory;
  return () => {
    controllerFactory = previous;
  };
}

export async function resetPrivateRoomDshForTests(): Promise<void> {
  const active = controller;
  controller = null;
  controllerRequest = null;
  controllerIdentity = '';
  roomOpenRequests.clear();
  usePrivateRoomDsh.setState({ sessions: {} });
  await active?.stop().catch(() => undefined);
}
