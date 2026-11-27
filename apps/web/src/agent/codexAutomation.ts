import {
  AppServerController,
  type AppServerControllerOptions,
  type CodexPermissionPreset,
  type CodexRuntimeSelection,
} from './AppServerController';
import { t } from '../i18n';
import type { Turn } from './protocol/generated/v2/Turn';
import { runExistingThreadAutomation, useCodexWorkspace } from '../stores/codexWorkspace';

export interface CodexAutomationOptions {
  workspaceRoot: string;
  text: string;
  name: string;
  model?: string;
  effort?: string | null;
  permissionPreset?: CodexPermissionPreset;
  skillName?: string;
  targetThreadId?: string;
  signal?: AbortSignal;
  onAdmitted?: () => void;
}

type ControllerFactory = (options: AppServerControllerOptions) => AppServerController;

let controllerFactory: ControllerFactory = (options) => new AppServerController(options);
let customControllerFactoryDepth = 0;

export function hasCustomAutomationControllerFactory(): boolean {
  return customControllerFactoryDepth > 0;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finalText(turns: readonly Turn[]): string {
  for (const turn of [...turns].reverse()) {
    for (const item of [...turn.items].reverse()) {
      if (item.type === 'agentMessage' && item.text.trim()) return item.text.trim();
    }
  }
  return '';
}

function selection(
  models: Awaited<ReturnType<AppServerController['connect']>>['models'],
  requestedModel?: string,
  requestedEffort?: string | null,
  permissionPreset: CodexPermissionPreset = 'auto',
): CodexRuntimeSelection {
  const model = models.find((item) => item.model === requestedModel || item.id === requestedModel)
    ?? models.find((item) => item.isDefault)
    ?? models[0];
  if (!model) throw new Error(t('agent.codexAutomation.noModels'));
  const effort = requestedEffort
    && model.supportedReasoningEfforts.some((item) => item.reasoningEffort === requestedEffort)
    ? requestedEffort
    : model.defaultReasoningEffort;
  return { model: model.model, effort, permissionPreset };
}

/** 已安排任务与手动任务共享同一 App Server 协议；无人值守时不代答用户输入。 */
export async function runCodexAutomation(options: CodexAutomationOptions): Promise<{ text: string; threadId: string }> {
  const workspaceRoot = options.workspaceRoot.trim();
  const text = options.text.trim();
  if (!workspaceRoot) throw new Error(t('agent.codexAutomation.noWorkspace'));
  if (!text) throw new Error(t('agent.codexAutomation.emptyPrompt'));
  if (options.signal?.aborted) throw options.signal.reason ?? new Error(t('agent.codexAutomation.canceled'));
  if (options.targetThreadId) {
    const wsState = useCodexWorkspace.getState();
    const ownsLiveGuiThread =
      wsState.workspaceRoot.trim() === workspaceRoot
      && (wsState.status === 'ready' || wsState.status === 'running' || wsState.status === 'waiting-input')
      && (
        wsState.activeThreadId === options.targetThreadId
        || wsState.threads.some((th) => th.id === options.targetThreadId)
      );
    if (ownsLiveGuiThread) {
    return runExistingThreadAutomation({
      threadId: options.targetThreadId,
      workspaceRoot,
      text,
      model: options.model,
      effort: options.effort,
      permissionPreset: options.permissionPreset,
      signal: options.signal,
    });
  }

  }

  let threadId = '';
  let turnId = '';
  let complete: ((turn: Record<string, unknown>) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  const completed = new Promise<Record<string, unknown>>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  const controller = controllerFactory({
    onNotification: (method, value) => {
      const params = record(value);
      if (threadId && params.threadId !== threadId) return;
      if (method === 'turn/completed') complete?.(record(params.turn));
    },
    onServerRequest: async ({ method, policy }) => {
      if (policy === 'host-input') throw new Error(t('agent.codexAutomation.needsUserInput'));
      if (method === 'item/permissions/requestApproval') {
        if (options.permissionPreset === 'ask') {
          throw new Error(t('agent.codexAutomation.needsApproval'));
        }
        return { permissions: {}, scope: 'turn', strictAutoReview: true };
      }
      if (policy === 'host-approval') {
        if (options.permissionPreset === 'ask') {
          throw new Error(t('agent.codexAutomation.needsApproval'));
        }
        return { decision: 'decline' };
      }
      throw new Error(t('agent.codexAutomation.unattendedUnsupported', { method }));
    },
    onInterrupted: (error) => fail?.(error),
  });

  const interrupt = (): void => {
    if (threadId && turnId) void controller.interruptTurn(threadId, turnId).catch(() => undefined);
    fail?.(options.signal?.reason instanceof Error ? options.signal.reason : new Error(t('agent.codexAutomation.canceled')));
  };
  options.signal?.addEventListener('abort', interrupt, { once: true });

  try {
    const catalog = await controller.connect(`automation-${crypto.randomUUID()}`, workspaceRoot);
    if (options.skillName) {
      const skill = catalog.skills.find((item) => item.name === options.skillName);
      if (!skill) throw new Error(t('agent.codexAutomation.skillNotFound', { name: options.skillName }));
      if (!skill.enabled) throw new Error(t('agent.codexAutomation.skillDisabled', { name: options.skillName }));
    }
    const runtimeSelection = selection(
      catalog.models,
      options.model,
      options.effort,
      options.permissionPreset,
    );
    const thread = options.targetThreadId
      ? await controller.resumeThread(options.targetThreadId, runtimeSelection, workspaceRoot)
      : await controller.startThread(runtimeSelection, options.name);
    threadId = thread.id;
    options.onAdmitted?.();
    turnId = await controller.startTurn(
      threadId,
      [{ type: 'text', text, text_elements: [] }],
      runtimeSelection,
    );
    const result = await completed;
    const status = result.status;
    if (status === 'failed') {
      throw new Error(typeof record(result.error).message === 'string'
        ? String(record(result.error).message)
        : t('agent.codexAutomation.failed'));
    }
    if (status === 'interrupted') throw new Error(t('agent.codexAutomation.interrupted'));
    const loaded = await controller.readThread(threadId);
    const output = finalText(loaded.turns);
    if (!output) throw new Error(t('agent.codexAutomation.noOutput'));
    return { text: output, threadId };
  } finally {
    options.signal?.removeEventListener('abort', interrupt);
    await controller.stop();
  }
}

export function setCodexAutomationControllerFactory(factory: ControllerFactory): () => void {
  const previous = controllerFactory;
  let restored = false;
  controllerFactory = factory;
  customControllerFactoryDepth += 1;
  return () => {
    if (restored) return;
    restored = true;
    controllerFactory = previous;
    customControllerFactoryDepth = Math.max(0, customControllerFactoryDepth - 1);
  };
}
