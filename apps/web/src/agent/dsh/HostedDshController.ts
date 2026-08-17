import {
  DshController,
  type DshControllerRuntime,
  type DshServerRequest,
} from './DshController';
import { approvalResponse, questionResponse } from './protocol';
import {
  projectDshTranscript,
  type DshSessionEvent,
  type DshTranscript,
} from './project';
import type {
  DshPendingApproval,
  DshPendingQuestion,
  DshQuestion,
  DshQuestionAnswer,
} from './types';

const DEEPSEEK_API_KEY_REF = 'DEEPSEEK_API_KEY';
const HISTORY_PAGE_SIZE = 200;

interface DshCredentialDescribeResponse {
  credentials?: Record<string, { configured?: unknown; writable?: unknown }>;
}

interface DshModelGroupResponse {
  groups?: Array<{
    id?: unknown;
    name?: unknown;
    models?: Array<{
      id?: unknown;
      name?: unknown;
      description?: unknown;
      reasoning?: {
        efforts?: Array<{ id?: unknown }>;
        defaultEffort?: unknown;
      };
    }>;
  }>;
}

interface DshAgentPresetListResponse {
  presets?: Array<{ id?: unknown; trust?: unknown; isDefault?: unknown }>;
}

interface DshSettingsDescribeResponse {
  namespaces?: Array<{ ns?: unknown; schema?: unknown; value?: unknown }>;
}

interface DshSessionCreateResponse {
  sessionId?: unknown;
}

interface DshSessionHistoryResponse {
  events?: Array<{ event?: unknown }>;
}

interface DshCommandExecutionResponse {
  result?: { kind?: unknown; text?: unknown };
}

interface PendingPrompt {
  baselineSeq: number;
  accepted: boolean;
  resolve: (value: { turnId: string; text: string }) => void;
  reject: (reason: Error) => void;
}

export interface HostedDshControllerOptions {
  onApproval?: (approval: DshPendingApproval) => void;
  onApprovalResolved?: (sessionId: string, approvalId: string) => void;
  onQuestion?: (question: DshPendingQuestion) => void;
  onQuestionResolved?: (sessionId: string, questionRpcId: string) => void;
  onSessionUpdated?: (sessionId: string) => void;
  onTrace?: (request: DshServerRequest) => void;
  onInterrupted?: (error: Error) => void;
  runtime?: DshControllerRuntime;
}

export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface DshModelOption {
  id: string;
  name: string;
  description?: string;
  reasoning?: {
    efforts: Array<{ id: string; name?: string }>;
    defaultEffort?: string;
  };
}

export interface DshModelGroup {
  id: string;
  name: string;
  models: DshModelOption[];
}

export interface DshAgentPreset {
  id: string;
  name?: string;
  description?: string;
  trust?: string;
  isDefault: boolean;
  broken?: string;
}

export interface DshPermissionPreset {
  id: string;
  name: string;
  description?: string;
}

export interface DshStartConfiguration {
  models: {
    groups: DshModelGroup[];
    defaultSelection?: DshModelSelection;
  };
  agentPresets: DshAgentPreset[];
  defaultAgentPreset?: string;
  permission?: {
    options: DshPermissionPreset[];
    defaultPreset?: string;
  };
}

export interface DshSessionCreateOptions {
  model?: DshModelSelection;
  agentPreset?: string;
  permissionPreset?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asTurnId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return `turn-${value}`;
  return undefined;
}

function titleCaseKebab(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function schemaNodeAtPath(schema: unknown, path: readonly string[]): Record<string, unknown> | null {
  let node = record(schema);
  for (const key of path) {
    if (!node) return null;
    if (node.type === 'object') {
      node = record(record(node.dict)?.[key] ?? record(node.properties)?.[key]);
      continue;
    }
    if (node.type === 'dict' || node.type === 'array') {
      node = record(node.inner);
      continue;
    }
    return null;
  }
  return node;
}

function schemaEnumOptions(node: unknown): DshPermissionPreset[] {
  const current = record(node);
  if (!current) return [];
  const candidates = current.type === 'union' && Array.isArray(current.list)
    ? current.list
    : [current];
  return candidates.flatMap((candidate): DshPermissionPreset[] => {
    const choice = record(candidate);
    const id = asString(choice?.value);
    if (choice?.type === 'const' && id) {
      const description = asString(record(choice.meta)?.description);
      return [{
        id,
        name: description ?? titleCaseKebab(id),
        ...(description ? { description } : {}),
      }];
    }
    if (Array.isArray(choice?.enum)) {
      return choice.enum.flatMap((entry): DshPermissionPreset[] => {
        const id = asString(entry);
        return id ? [{ id, name: titleCaseKebab(id) }] : [];
      });
    }
    return [];
  });
}

function modelSelectionFromSettings(value: unknown): DshModelSelection | undefined {
  const selection = record(value);
  const provider = asString(selection?.provider);
  const model = asString(selection?.model);
  if (!provider || !model) return undefined;
  const reasoningEffort = asString(selection?.reasoningEffort);
  return {
    provider,
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function requireCommandSuccess(response: unknown): void {
  const payload = record(response) as DshCommandExecutionResponse | null;
  const result = record(payload?.result);
  if (result?.kind === 'success') return;
  const message = asString(result?.text);
  throw new Error(message ?? 'DeepSeek 权限切换失败');
}

function asSessionEvent(value: unknown): DshSessionEvent | null {
  const event = record(value);
  if (
    !event
    || typeof event.type !== 'string'
    || !Number.isInteger(event.seq)
    || !Number.isInteger(event.time)
    || !('data' in event)
  ) return null;
  return event as unknown as DshSessionEvent;
}

function turnIdFromEvent(event: DshSessionEvent): string | undefined {
  return asTurnId(record(event.data)?.turn);
}

function turnErrorMessage(event: DshSessionEvent): string | undefined {
  if (event.type !== 'turn/end') return undefined;
  const reason = record(record(event.data)?.reason);
  if (reason?.kind !== 'error') return undefined;
  const error = record(reason.error);
  return asString(error?.message) ?? 'DeepSeek 执行失败';
}

function assistantTextSince(sessionId: string, events: Iterable<DshSessionEvent>, baselineSeq: number): string {
  const transcript = projectDshTranscript(
    sessionId,
    [...events].filter((event) => event.seq > baselineSeq),
  );
  return transcript.messages
    .filter((message) => message.role === 'assistant')
    .at(-1)
    ?.text
    ?.trim() ?? '';
}

function requireSessionId(response: unknown): string {
  const payload = record(response) as DshSessionCreateResponse | null;
  const sessionId = asString(payload?.sessionId);
  if (!sessionId) throw new Error('DSH 没有返回 sessionId');
  return sessionId;
}

function questionList(value: unknown): DshQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): DshQuestion[] => {
    const question = record(entry) as Partial<DshQuestion> | null;
    if (!question || typeof question.id !== 'string' || typeof question.question !== 'string') {
      return [];
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
        const value = record(option);
        const label = asString(value?.label);
        if (!label) return [];
        return [{
          label,
          ...(typeof value?.description === 'string' ? { description: value.description } : {}),
        }];
      })
      : undefined;
    return [{
      id: question.id,
      question: question.question,
      ...(typeof question.header === 'string' ? { header: question.header } : {}),
      ...(typeof question.detail === 'string' ? { detail: question.detail } : {}),
      ...(options ? { options } : {}),
      ...(question.multiSelect === true ? { multiSelect: true } : {}),
    }];
  });
}

export class HostedDshController {
  private controller: DshController | null = null;
  private connectPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private interrupted: Error | null = null;
  private stopped = false;
  private generation = 0;
  private readonly events = new Map<string, Map<number, DshSessionEvent>>();
  private readonly pendingPrompts = new Map<string, PendingPrompt>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly connectionId: string,
    private readonly options: HostedDshControllerOptions = {},
  ) {}

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    if (this.controller && !this.interrupted) return;

    const operation = (async () => {
      const generation = ++this.generation;
      this.interrupted = null;
      this.stopped = false;
      const controller = new DshController(
        this.workspaceRoot,
        {
          onMux: (request) => this.handleMux(request, generation),
          onHost: (request) => this.handleHost(request, generation),
          onError: (error) => {
            void this.interrupt(error, generation);
          },
          onExit: (code) => {
            void this.interrupt(new Error(`DSH 进程已退出${code === null ? '' : `（${code}）`}`), generation);
          },
        },
        this.options.runtime,
        this.connectionId,
      );

      this.controller = controller;
      try {
        await controller.start();
        await controller.call('host.describe');
        const described = await controller.call<DshCredentialDescribeResponse>('credentials.describe', {
          refs: [DEEPSEEK_API_KEY_REF],
        });
        const credential = record(described.credentials)?.[DEEPSEEK_API_KEY_REF];
        if (record(credential)?.configured !== true) {
          throw new Error('请先在 DSH 中配置 DeepSeek API Key');
        }
      } catch (reason) {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        await controller.stop().catch(() => undefined);
        if (this.controller === controller) this.controller = null;
        throw error;
      }
    })();

    const tracked = operation.finally(() => {
      if (this.connectPromise === tracked) this.connectPromise = null;
    });
    this.connectPromise = tracked;
    return tracked;
  }

  async getStartConfiguration(): Promise<DshStartConfiguration> {
    const controller = await this.requireController();
    const [modelsResponse, presetsResponse, settingsResponse] = await Promise.all([
      controller.call<DshModelGroupResponse>('llm.models'),
      controller.call<DshAgentPresetListResponse>('agentPreset.list'),
      controller.call<DshSettingsDescribeResponse>('settings.describe'),
    ]);

    const groups = (modelsResponse.groups ?? []).flatMap((group): DshModelGroup[] => {
      const provider = asString(group?.id);
      const providerLabel = asString(group?.name) ?? provider;
      if (!provider || !providerLabel) return [];
      const models = (group.models ?? []).flatMap((entry): DshModelOption[] => {
        const model = asString(entry?.id);
        const modelLabel = asString(entry?.name) ?? model;
        if (!model || !modelLabel) return [];
        const efforts = Array.isArray(entry.reasoning?.efforts)
          ? entry.reasoning.efforts.flatMap((effort) => {
            const current = record(effort);
            const id = asString(current?.id);
            const name = asString(current?.name);
            return id ? [{ id, ...(name ? { name } : {}) }] : [];
          })
          : [];
        const defaultReasoningEffort = asString(entry.reasoning?.defaultEffort);
        return [{
          id: model,
          name: modelLabel,
          ...(asString(entry?.description) ? { description: asString(entry?.description)! } : {}),
          ...(efforts.length > 0 || defaultReasoningEffort
            ? {
              reasoning: {
                efforts,
                ...(defaultReasoningEffort ? { defaultEffort: defaultReasoningEffort } : {}),
              },
            }
            : {}),
        }];
      });
      return [{ id: provider, name: providerLabel, models }];
    });

    const agentPresets = (presetsResponse.presets ?? []).flatMap((entry): DshAgentPreset[] => {
      const current = record(entry);
      const id = asString(current?.id);
      if (!id) return [];
      const trust = asString(current?.trust);
      const name = asString(current?.name);
      const description = asString(current?.description);
      const broken = asString(current?.broken);
      return [{
        id,
        ...(name ? { name } : {}),
        ...(trust ? { trust } : {}),
        ...(description ? { description } : {}),
        isDefault: current?.isDefault === true,
        ...(broken ? { broken } : {}),
      }];
    });

    const namespaces = settingsResponse.namespaces ?? [];
    const modelSelection = modelSelectionFromSettings(
      namespaces.find((view) => asString(view?.ns) === 'agent-default-model')?.value,
    );
    const permissionView = namespaces.find((view) => asString(view?.ns) === 'permission');
    const defaultPermissionPreset = asString(record(permissionView?.value)?.defaultPreset);
    const permissionPresets = permissionView
      ? schemaEnumOptions(schemaNodeAtPath(permissionView.schema, ['defaultPreset']))
      : [];

    return {
      models: {
        groups,
        ...(modelSelection ? { defaultSelection: modelSelection } : {}),
      },
      agentPresets,
      ...(agentPresets.find((entry) => entry.isDefault)?.id
        ? { defaultAgentPreset: agentPresets.find((entry) => entry.isDefault)!.id }
        : {}),
      ...(permissionPresets.length > 0 || defaultPermissionPreset
        ? {
          permission: {
            options: permissionPresets,
            ...(defaultPermissionPreset ? { defaultPreset: defaultPermissionPreset } : {}),
          },
        }
        : {}),
    };
  }

  async createSession(options: DshSessionCreateOptions = {}): Promise<string> {
    const controller = await this.requireController();
    const agentPreset = asString(options.agentPreset);
    const modelSelection = record(options.model);
    const provider = asString(modelSelection?.provider);
    const model = asString(modelSelection?.model);
    const reasoningEffort = asString(modelSelection?.reasoningEffort);
    const permissionPreset = asString(options.permissionPreset);
    if ((provider && !model) || (!provider && model) || (!provider && reasoningEffort)) {
      throw new Error('DSH 会话启动参数缺少完整模型选择');
    }
    const sessionId = requireSessionId(await controller.call<DshSessionCreateResponse>('session.create', {
      cwd: this.workspaceRoot,
      ...(agentPreset ? { agentPreset } : {}),
    }));
    this.events.set(sessionId, this.events.get(sessionId) ?? new Map());
    if (provider && model) {
      await controller.call('session.selectModel', {
        sessionId,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
    }
    if (permissionPreset) {
      requireCommandSuccess(await controller.call<DshCommandExecutionResponse>('commands/execute', {
        args: {
          agentId: sessionId,
          line: `/permission ${permissionPreset}`,
        },
      }));
    }
    return sessionId;
  }

  async resumeSession(sessionId: string): Promise<void> {
    const controller = await this.requireController();
    const normalized = sessionId.trim();
    if (!normalized) throw new Error('DSH sessionId 不能为空');
    const existed = this.events.has(normalized);
    const sessionEvents = this.events.get(normalized) ?? new Map<number, DshSessionEvent>();
    this.events.set(normalized, sessionEvents);
    try {
      const history = await controller.call<DshSessionHistoryResponse>('session.history', {
        sessionId: normalized,
        maxMessages: HISTORY_PAGE_SIZE,
      });
      for (const item of history.events ?? []) {
        const event = asSessionEvent(item?.event);
        if (event) sessionEvents.set(event.seq, event);
      }
      this.options.onSessionUpdated?.(normalized);
    } catch (error) {
      if (!existed) this.events.delete(normalized);
      throw error;
    }
  }

  getTranscript(sessionId: string): DshTranscript {
    const normalized = sessionId.trim();
    return projectDshTranscript(normalized, this.events.get(normalized)?.values() ?? []);
  }

  attachmentLeaseId(): string {
    if (!this.controller) throw new Error('DSH 尚未连接');
    return this.controller.attachmentLeaseId();
  }

  async prompt(sessionId: string, text: string): Promise<{ turnId: string; text: string }> {
    const controller = await this.requireController();
    const normalized = sessionId.trim();
    const content = text.trim();
    if (!normalized) throw new Error('DSH sessionId 不能为空');
    if (!content) throw new Error('提示词不能为空');
    if (!this.events.has(normalized)) throw new Error('请先创建或恢复 DSH 会话');
    if (this.pendingPrompts.has(normalized)) {
      throw new Error('该 DSH 会话已有进行中的 prompt');
    }
    const events = this.events.get(normalized)!;
    const baselineSeq = [...events.keys()].reduce((max, seq) => Math.max(max, seq), -1);

    const result = new Promise<{ turnId: string; text: string }>((resolve, reject) => {
      this.pendingPrompts.set(normalized, { baselineSeq, accepted: false, resolve, reject });
    });

    try {
      await controller.call('session.prompt', {
        sessionId: normalized,
        mode: 'queue',
        content: [{ type: 'text', text: content }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const pending = this.pendingPrompts.get(normalized);
      if (pending) {
        pending.accepted = true;
        this.maybeResolvePrompt(normalized, events);
      }
    } catch (reason) {
      const error = reason instanceof Error ? reason : new Error(String(reason));
      this.pendingPrompts.get(normalized)?.reject(error);
      this.pendingPrompts.delete(normalized);
      throw error;
    }

    return result;
  }

  async cancel(sessionId: string): Promise<void> {
    const controller = await this.requireController();
    await controller.call('session.cancel', { sessionId: sessionId.trim() });
  }

  async respondApproval(approval: DshPendingApproval, approved: boolean): Promise<void> {
    const controller = await this.requireController();
    await controller.respond(approvalResponse(approval, approved));
  }

  async respondQuestion(question: DshPendingQuestion, answers: DshQuestionAnswer[]): Promise<void> {
    const controller = await this.requireController();
    await controller.respond(questionResponse(question, answers));
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const operation = (async () => {
      this.generation += 1;
      this.stopped = true;
      const active = this.controller;
      this.controller = null;
      this.connectPromise = null;
      this.rejectPendingPrompts(new Error('DSH 连接已关闭'));
      if (active) await active.stop().catch(() => undefined);
    })();
    const tracked = operation.finally(() => {
      if (this.stopPromise === tracked) this.stopPromise = null;
    });
    this.stopPromise = tracked;
    return tracked;
  }

  private async requireController(): Promise<DshController> {
    if (this.interrupted) throw this.interrupted;
    if (!this.controller) await this.connect();
    if (this.interrupted) throw this.interrupted;
    if (!this.controller) throw new Error('DSH 尚未连接');
    return this.controller;
  }

  private handleMux(request: DshServerRequest, generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    const frame = record(request.payload);
    if (!frame || typeof frame.type !== 'string' || request.method !== frame.type) return;

    const sessionId = asString(frame.sessionId);
    if (sessionId && !this.events.has(sessionId)) return;
    this.options.onTrace?.(request);
    if (frame.type === 'stream/error') {
      const message = asString(record(frame.error)?.message) ?? 'DSH 事件流失败';
      void this.interrupt(new Error(message), generation);
      return;
    }

    if (frame.type === 'approval/requested' && sessionId && typeof frame.approvalId === 'string' && typeof frame.toolName === 'string') {
      this.options.onApproval?.({
        rpcId: request.rpcId,
        sessionId,
        approvalId: frame.approvalId,
        toolName: frame.toolName,
        ...(typeof frame.callId === 'string' ? { callId: frame.callId } : {}),
        ...(typeof frame.reason === 'string' ? { reason: frame.reason } : {}),
      });
      return;
    }

    if (frame.type === 'approval/resolved' && sessionId && typeof frame.approvalId === 'string') {
      this.options.onApprovalResolved?.(sessionId, frame.approvalId);
      return;
    }

    if (frame.type === 'question/requested' && sessionId) {
      const questions = questionList(frame.questions);
      if (questions.length === 0) return;
      this.options.onQuestion?.({
        rpcId: request.rpcId,
        sessionId,
        questions,
      });
      return;
    }

    if (frame.type === 'question/resolved' && sessionId) {
      const questionRpcId = asString(frame.questionRpcId);
      if (questionRpcId) this.options.onQuestionResolved?.(sessionId, questionRpcId);
      return;
    }

    if (frame.type !== 'session/event' || !sessionId) return;
    const event = asSessionEvent(frame.event);
    if (!event) return;
    const events = this.events.get(sessionId) ?? new Map<number, DshSessionEvent>();
    events.set(event.seq, event);
    this.events.set(sessionId, events);
    this.options.onSessionUpdated?.(sessionId);
    this.maybeResolvePrompt(sessionId, events);
  }

  private handleHost(request: DshServerRequest, generation: number): void {
    if (this.stopped || generation !== this.generation) return;
    const frame = record(request.payload);
    if (!frame || typeof frame.type !== 'string' || request.method !== frame.type) return;

    const sessionId = asString(frame.sessionId);
    if (sessionId && !this.events.has(sessionId)) return;
    this.options.onTrace?.(request);

    if (frame.type === 'stream/error') {
      const message = asString(record(frame.error)?.message) ?? 'DSH 主机事件流失败';
      void this.interrupt(new Error(message), generation);
      return;
    }

    if (frame.type === 'host/agent-error') {
      const message = asString(frame.message) ?? 'DeepSeek 执行失败';
      void this.interrupt(new Error(message), generation);
    }
  }

  private maybeResolvePrompt(
    sessionId: string,
    events: Map<number, DshSessionEvent>,
  ): void {
    const pending = this.pendingPrompts.get(sessionId);
    if (!pending?.accepted) return;
    const currentEvents = [...events.values()]
      .filter((event) => event.seq > pending.baselineSeq)
      .sort((left, right) => left.seq - right.seq);
    const start = currentEvents.find((event) => event.type === 'turn/start');
    const turnId = start ? turnIdFromEvent(start) : undefined;
    if (!start || !turnId) return;
    const end = currentEvents.find((event) => (
      event.seq > start.seq
      && event.type === 'turn/end'
      && turnIdFromEvent(event) === turnId
    ));
    if (!end) return;
    const text = assistantTextSince(sessionId, events.values(), pending.baselineSeq);
    const failure = turnErrorMessage(end);
    this.pendingPrompts.delete(sessionId);
    if (failure) {
      pending.reject(new Error(failure));
      return;
    }
    pending.resolve({ turnId, text });
  }

  private async interrupt(error: Error, generation: number): Promise<void> {
    if (generation !== this.generation || this.interrupted) return;
    this.interrupted = error;
    this.rejectPendingPrompts(error);
    this.options.onInterrupted?.(error);
    await this.stop();
  }

  private rejectPendingPrompts(error: Error): void {
    for (const pending of this.pendingPrompts.values()) pending.reject(error);
    this.pendingPrompts.clear();
  }
}
