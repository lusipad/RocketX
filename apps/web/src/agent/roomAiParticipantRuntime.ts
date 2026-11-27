import { create } from 'zustand';
import { t } from '../i18n';
import { tsMs, type RcMessage } from '@rcx/rc-client';
import { getServerBase, isTauriRuntime } from '../lib/client';
import {
  parseDecisionBlockFromBody,
  summarizeDecisionForHandoff,
  type RoundtableDecisionPayload,
} from '../lib/hostedAgentAnswer';
import { toSendableMessageChunks } from '../lib/messageChunks';
import { prepareNativeWorktree, sendAgentBotMessage } from '../platform/desktopCommands';
import { useAcpAgents } from '../stores/acpAgents';
import { useButlerRoomBindings } from '../stores/butlerRoomBindings';
import { useButlerSkills } from '../stores/butlerSkills';
import { useChat } from '../stores/chat';
import {
  createDefaultRoundtableSeats,
  resolvePreferredProjectWorkspace,
  useRoomAiParticipants,
  type RoomAiParticipant,
  type RoomAiReplyPolicy,
  type RoomAiSeat,
  type RoundtableRoleId,
} from '../stores/roomAiParticipants';
import { useWorkLedger } from '../stores/workLedger';
import {
  hasCustomAutomationControllerFactory,
  runCodexAutomation,
} from './codexAutomation';
import { agentMessageBridgeChanges } from './messageBridge';
import { redactAgentOutput } from './safety';
import { SerialCommandQueue } from './session';
import { planSafeExecutionWorkspace } from './worktreeLifecycle';

export interface RoomAiReplyResult {
  text: string;
  threadId?: string;
  acpSessionKey?: string;
}

export type RoomAiButlerRunner = (input: {
  participant: RoomAiParticipant;
  prompt: string;
  instruction: string;
  message: RcMessage;
  roomName: string;
  seat?: RoomAiSeat;
  signal?: AbortSignal;
}) => Promise<RoomAiReplyResult>;

export interface RoundtableLiveRun {
  runId: string;
  currentSeatId: string;
  currentSeatTitle: string;
  currentRoleId: RoundtableRoleId;
  stepIndex: number;
  totalSteps: number;
  activityHint: string;
}

interface RoundtableLiveState {
  runs: Record<string, RoundtableLiveRun>;
}

export const useRoundtableLiveState = create<RoundtableLiveState>(() => ({
  runs: {},
}));

interface ActiveRoundtableController {
  runId: string;
  runAbort: AbortController;
  seatAbort: AbortController | null;
  skipCurrent: boolean;
  forceSynthesize: boolean;
}

const activeRoundtableControllers = new Map<string, ActiveRoundtableController>();

let customButlerRunner: RoomAiButlerRunner | null = null;
const roomQueues = new Map<string, SerialCommandQueue>();
const processedMessageIds = new Set<string>();
const MAX_PROCESSED_IDS = 1200;

function queueForRoom(rid: string): SerialCommandQueue {
  let queue = roomQueues.get(rid);
  if (!queue) {
    queue = new SerialCommandQueue();
    roomQueues.set(rid, queue);
  }
  return queue;
}

export function setRoomAiButlerRunner(runner: RoomAiButlerRunner | null): void {
  customButlerRunner = runner;
}

export function skipCurrentRoundtableSeat(rid: string): boolean {
  const ctrl = activeRoundtableControllers.get(rid);
  if (!ctrl || ctrl.runAbort.signal.aborted) return false;
  ctrl.skipCurrent = true;
  ctrl.seatAbort?.abort('skipped');
  return true;
}

export function forceSynthesizeRoundtableNow(rid: string): boolean {
  const ctrl = activeRoundtableControllers.get(rid);
  if (!ctrl || ctrl.runAbort.signal.aborted) return false;
  ctrl.forceSynthesize = true;
  ctrl.seatAbort?.abort('force_synthesize');
  return true;
}

export function abortRoundtableRun(rid: string): boolean {
  const ctrl = activeRoundtableControllers.get(rid);
  if (!ctrl) return false;
  ctrl.runAbort.abort('superseded');
  ctrl.seatAbort?.abort('superseded');
  activeRoundtableControllers.delete(rid);
  useRoundtableLiveState.setState((state) => {
    if (!state.runs[rid]) return state;
    const next = { ...state.runs };
    delete next[rid];
    return { runs: next };
  });
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rememberProcessedMessage(mid: string): void {
  processedMessageIds.add(mid);
  if (processedMessageIds.size > MAX_PROCESSED_IDS) {
    const first = processedMessageIds.values().next().value;
    if (first) processedMessageIds.delete(first);
  }
}

const ROLE_ALIASES: Record<RoundtableRoleId, string[]> = {
  product: ['产品设计', '产品经理', '产品', 'product design', 'product'],
  architect: ['架构工程', '系统架构', '架构师', '架构', 'architecture', 'architect'],
  contrarian: ['挑刺官', '挑刺', '反方', 'contrarian'],
  captain: ['主理人', '主理', 'captain'],
  custom: [],
};

function hasMentionAlias(text: string, aliases: readonly string[]): boolean {
  const unique = [...new Set(aliases.map((a) => a.trim()).filter(Boolean))];
  if (unique.length === 0) return false;
  const escaped = unique.map(escapeRegExp).join('|');
  const pattern = new RegExp(
    `(?:^|[\\s(（\\[【])@(?:${escaped})(?=$|[\\s,，:：.。!！?？)）\\]】])`,
    'iu',
  );
  return pattern.test(text);
}

function stripLeadingMentionAlias(text: string, aliases: readonly string[]): string {
  const trimmed = text.trim();
  const unique = [...new Set(aliases.map((a) => a.trim()).filter(Boolean))];
  if (unique.length === 0) return trimmed;
  const escaped = unique.map(escapeRegExp).join('|');
  const leadingPattern = new RegExp(
    `^(?:@(?:${escaped}))(?:\\s+|[:：,，]\\s*|$)([\\s\\S]*)$`,
    'iu',
  );
  const match = leadingPattern.exec(trimmed);
  if (!match) return trimmed;
  return match[1]?.trim() || trimmed;
}

export function matchTargetedSeat(
  text: string,
  seats: readonly RoomAiSeat[],
  agentName: string,
): { kind: 'seat'; seat: RoomAiSeat; instruction: string } | { kind: 'roundtable'; instruction: string } | null {
  const trimmed = text.trim();
  if (!trimmed || /^🤖(?:\s|$)/u.test(trimmed)) return null;

  const enabledSeats = seats.filter((s) => s.enabled);
  for (const seat of enabledSeats) {
    const aliases = [
      seat.roleTitle,
      ...ROLE_ALIASES[seat.roleId],
      ...(seat.agentName && seat.agentName !== agentName ? [seat.agentName] : []),
    ];
    if (hasMentionAlias(trimmed, aliases)) {
      return {
        kind: 'seat',
        seat,
        instruction: stripLeadingMentionAlias(trimmed, aliases),
      };
    }
  }

  const roundtableAliases = ['全员圆桌', '圆桌', 'roundtable', 'ai', '管家', 'butler', agentName];
  if (hasMentionAlias(trimmed, roundtableAliases)) {
    return {
      kind: 'roundtable',
      instruction: stripLeadingMentionAlias(trimmed, roundtableAliases),
    };
  }

  return null;
}

/**
 * 判断群消息是否需要由 AI 参与者响应：
 * - 永远忽略 AI 自身发送的 `🤖 ...` 回复，防止回环
 * - `every_message` 模式下直接响应所有非空消息（适合 AI 讨论组）
 * - `mention_only` 模式下仅当包含 `@ai` / `@管家` / `@butler` 或 `@<AgentName>` 时触发（适合普通群聊）
 */
export function extractRoomParticipantInstruction(
  text: string,
  policy: RoomAiReplyPolicy,
  agentName: string,
): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^🤖(?:\s|$)/u.test(trimmed)) return null;

  if (policy === 'every_message') {
    return trimmed;
  }

  const normalizedAgent = agentName.trim();
  const aliasAlternation = normalizedAgent
    ? `ai|管家|butler|${escapeRegExp(normalizedAgent)}`
    : 'ai|管家|butler';

  const leadingPattern = new RegExp(
    `^(?:@(?:${aliasAlternation}))(?:\\s+|[:：,，]\\s*|$)([\\s\\S]*)$`,
    'iu',
  );
  const leading = leadingPattern.exec(trimmed);
  if (leading) {
    const rest = leading[1]?.trim() ?? '';
    return rest || trimmed;
  }

  const inlinePattern = new RegExp(
    `(?:^|[\\s(（\\[【])@(?:${aliasAlternation})(?=$|[\\s,，:：.。!！?？)）\\]】])`,
    'iu',
  );
  if (inlinePattern.test(trimmed)) {
    return trimmed;
  }

  return null;
}

export function formatHostedRoomAiReply(agentName: string, body: string, note?: string): string {
  const cleanBody = redactAgentOutput(body).text.trim();
  const safeName = agentName.trim() || 'Pi 管家';
  const cleanNote = note?.trim();
  const header = cleanNote ? `🤖 ${safeName}（${cleanNote}）` : `🤖 ${safeName}`;
  return `${header}\n${cleanBody}`;
}

function formatHistoryExcerpt(messages: readonly RcMessage[], limit: number): string {
  return [...messages]
    .filter((m) => !m.t && (m.msg ?? '').trim())
    .sort((a, b) => tsMs(a.ts) - tsMs(b.ts))
    .slice(-limit)
    .map((m) => {
      const speaker = m.u?.name || m.u?.username || 'user';
      const ts = tsMs(m.ts);
      const timeTag = Number.isFinite(ts) && ts > 0 ? new Date(ts).toLocaleTimeString() : '';
      return `- [${speaker}${timeTag ? ` ${timeTag}` : ''}] ${(m.msg ?? '').trim()}`;
    })
    .join('\n');
}

export function buildRoomAiParticipantPrompt(input: {
  participant: RoomAiParticipant;
  message: RcMessage;
  instruction: string;
  messages: readonly RcMessage[];
  originMessages?: readonly RcMessage[];
  roomName: string;
}): string {
  const { participant, message, instruction, messages, originMessages, roomName } = input;
  const sender = message.u?.name || message.u?.username || 'user';
  const enabledSkills = useButlerSkills
    .getState()
    .skills.filter((skill) => skill.enabled)
    .slice(0, 8);

  const sections: string[] = [
    `[Role] You are "${participant.agentName}", participating inside Rocket.Chat room "${roomName || participant.rid}" (${
      participant.replyPolicy === 'every_message'
        ? 'AI Discussion Group: direct collaborative conversation'
        : 'Group Chat Participant: respond concisely when @mentioned'
    }).`,
  ];

  if (participant.workspaceRoot?.trim()) {
    sections.push(`[Bound Project Workspace] ${participant.workspaceRoot.trim()}`);
  }

  if (enabledSkills.length > 0) {
    sections.push(
      `[Available Butler Skills]\n${enabledSkills
        .map((s) => `- ${s.name} (/${s.slug})${s.description ? `: ${s.description}` : ''}`)
        .join('\n')}`,
    );
  }

  if (participant.latestDecisionSummary?.trim()) {
    sections.push(`[Distilled Roundtable Decision]\n${participant.latestDecisionSummary.trim()}`);
  }

  if (participant.originDiscussionRid && originMessages && originMessages.length > 0) {
    const originExcerpt = formatHistoryExcerpt(originMessages, 12);
    if (originExcerpt) {
      sections.push(
        `[Origin AI Discussion Context: ${participant.originDiscussionName || participant.originDiscussionRid}]\n${originExcerpt}`,
      );
    }
  }

  const roomExcerpt = formatHistoryExcerpt(
    messages.filter((m) => m._id !== message._id),
    18,
  );
  if (roomExcerpt) {
    sections.push(`[Recent Room Messages]\n${roomExcerpt}`);
  }

  sections.push(`[Current Message from ${sender}]\n${instruction}`);
  sections.push(
    '[Response Rules] Reply directly with actionable answers, clear conclusions, or next decisions needed. Do not add a "🤖 ..." header (it will be attached automatically). If tools were used, summarize the real outcome accurately.',
  );

  return sections.join('\n\n');
}

function roleDirective(seat: RoomAiSeat): string {
  const custom = seat.stancePrompt?.trim() ? ` Custom stance: ${seat.stancePrompt.trim()}.` : '';
  switch (seat.roleId) {
    case 'product':
      return `Role: Product Design (${seat.roleTitle}). Focus on user value, primary flow, and explicit MVP non-goals based on the room request and team context (avoid slow exhaustive shell crawls). Keep response <= 160 words, max 3 bullets, NO greetings or agreement filler.${custom}`;
    case 'architect':
      return `Role: Architecture & Engineering (${seat.roleTitle}). Run 3-5 targeted read-only inspections in the bound workspace to verify exact file paths, symbols, state boundaries, and migration risks. Keep response <= 180 words, max 3-4 bullets with concrete file paths, NO greetings or filler.${custom}`;
    case 'contrarian':
      return `Role: Contrarian / Devil's Advocate (${seat.roleTitle}). You are FORBIDDEN from praising or politely agreeing with prior speakers. Attack weak assumptions, identify regression risks, over-engineering, UX friction, or edge-case traps (at most 1-2 quick read-only spot checks if verifying a factual claim). Keep <= 150 words, max 3 bullets.${custom}`;
    case 'captain':
      return `Role: Roundtable Captain (${seat.roleTitle}). Synthesize the prior speakers' verified findings directly without redundant repository crawls, highlight genuine consensus and core contention, and ALWAYS append a valid \`\`\`rcx-decision JSON block with keys: title, consensus (string[]), contention (string), options ([{id, label, summary, recommended}]), targetFiles (string[]), acceptance (string[]).${custom}`;
    default:
      return `Role: ${seat.roleTitle}. Contribute focused domain critique in <= 150 words, max 3 bullets, referencing earlier speakers directly without polite filler.${custom}`;
  }
}

function buildRoundtableSeatPrompt(input: {
  participant: RoomAiParticipant;
  seat: RoomAiSeat;
  message: RcMessage;
  topic: string;
  messages: readonly RcMessage[];
  originMessages?: readonly RcMessage[];
  roomName: string;
  priorRoundNotes: ReadonlyArray<{ roleTitle: string; agentName: string; text: string }>;
}): string {
  const basePrompt = buildRoomAiParticipantPrompt({
    participant: {
      ...input.participant,
      agentName: input.seat.roleTitle,
    },
    message: input.message,
    instruction: input.topic,
    messages: input.messages,
    originMessages: input.originMessages,
    roomName: input.roomName,
  });

  const sections = [
    basePrompt,
    `[Roundtable Directive]\n${roleDirective(input.seat)}\n[Safety Guard] Discussion phase ONLY: inspect codebase read-only; NEVER edit files or execute mutating commands until the user approves the decision card.`,
  ];

  if (input.priorRoundNotes.length > 0) {
    sections.push(
      `[Earlier Roundtable Voices This Turn]\n${input.priorRoundNotes
        .map((n) => `### ${n.roleTitle} (${n.agentName})\n${n.text.trim()}`)
        .join('\n\n')}`,
    );
  }

  return sections.join('\n\n');
}

function seatActivityHint(roleId: RoundtableRoleId): string {
  switch (roleId) {
    case 'product':
      return t('chat.aiParticipant.activityProduct');
    case 'architect':
      return t('chat.aiParticipant.activityArchitect');
    case 'contrarian':
      return t('chat.aiParticipant.activityContrarian');
    case 'captain':
      return t('chat.aiParticipant.activityCaptain');
    default:
      return t('chat.aiParticipant.activityCustom');
  }
}

async function postRoomAiReply(rid: string, tmid: string | undefined, text: string): Promise<void> {
  const chunks = toSendableMessageChunks(text, undefined);
  let useChatFallback = false;
  let botDelivered = false;

  for (const chunk of chunks) {
    if (!useChatFallback) {
      try {
        const sent = await sendAgentBotMessage({
          serverUrl: getServerBase(),
          rid,
          tmid: tmid ?? null,
          text: chunk,
        });
        if (sent !== null) {
          botDelivered = true;
          continue;
        }
        if (botDelivered) {
          throw new Error(t('agent.shared.botChunkFailed'));
        }
        useChatFallback = true;
      } catch (error) {
        if (botDelivered) throw error;
        useChatFallback = true;
      }
    }

    await useChat.getState().send(chunk, {
      rid,
      tmid,
      preserveWhitespace: true,
    });
  }
}

async function runDefaultParticipantTurn(input: {
  participant: RoomAiParticipant;
  prompt: string;
  roomName: string;
  seat?: RoomAiSeat;
  signal?: AbortSignal;
}): Promise<RoomAiReplyResult> {
  const { participant, prompt, roomName, seat, signal } = input;
  const workspaceRoot = participant.workspaceRoot || resolvePreferredProjectWorkspace();
  const effectiveKind = seat?.agentKind ?? participant.agentKind;
  const effectiveAgentId = seat?.agentId ?? participant.agentId;
  const effectiveAgentName = seat?.roleTitle ?? participant.agentName;
  const effectiveThreadId = seat ? seat.threadId : participant.threadId;
  const effectiveSessionKey = seat ? seat.acpSessionKey : participant.acpSessionKey;

  if (effectiveKind === 'acp') {
    const acp = useAcpAgents.getState();
    let sessionKey = effectiveSessionKey;
    if (!sessionKey || !acp.sessions[sessionKey]) {
      const started = await acp.startSession({
        agentId: effectiveAgentId,
        workspaceRoot,
        title: roomName ? `${effectiveAgentName} · ${roomName}` : effectiveAgentName,
      });
      sessionKey = started.sessionKey;
    }
    await acp.sendPrompt(sessionKey, prompt, { injectMemory: true });
    const latestSession = useAcpAgents.getState().sessions[sessionKey];
    const lastAssistant = [...(latestSession?.messages ?? [])]
      .reverse()
      .find((m) => m.role === 'assistant' && m.text.trim());
    return {
      text: lastAssistant?.text?.trim() ?? '',
      acpSessionKey: sessionKey,
    };
  }

  const automationName = roomName
    ? `AI 讨论 · ${effectiveAgentName} · ${roomName}`
    : `AI 讨论 · ${participant.rid}`;

  try {
    const result = await runCodexAutomation({
      workspaceRoot,
      text: prompt,
      name: automationName,
      targetThreadId: effectiveThreadId,
      permissionPreset: 'auto',
      signal,
    });
    return {
      text: result.text,
      threadId: result.threadId,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const missingStoredThread =
      Boolean(effectiveThreadId)
      && /找不到\s*Pi\s*会话|thread\s*not\s*found|session\s*not\s*found|targetWrongWorkspace/iu.test(detail);
    if (!missingStoredThread) throw error;

    const fresh = await runCodexAutomation({
      workspaceRoot,
      text: prompt,
      name: automationName,
      permissionPreset: 'auto',
      signal,
    });
    return {
      text: fresh.text,
      threadId: fresh.threadId,
    };
  }
}

class SeatAbortError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SeatAbortError';
  }
}

function raceWithAbortSignals<T>(
  promise: Promise<T>,
  runSignal: AbortSignal,
  seatSignal: AbortSignal,
): Promise<T> {
  if (runSignal.aborted) {
    return Promise.reject(new SeatAbortError(String(runSignal.reason ?? 'aborted')));
  }
  if (seatSignal.aborted) {
    return Promise.reject(new SeatAbortError(String(seatSignal.reason ?? 'skipped')));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      runSignal.removeEventListener('abort', onAbort);
      seatSignal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new SeatAbortError(String(seatSignal.reason || runSignal.reason || 'aborted')));
    };
    runSignal.addEventListener('abort', onAbort, { once: true });
    seatSignal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

async function runSingleSeatTurn(
  rid: string,
  participant: RoomAiParticipant,
  seat: RoomAiSeat,
  instruction: string,
  message: RcMessage,
  roomName: string,
  messages: readonly RcMessage[],
  originMessages?: readonly RcMessage[],
): Promise<boolean> {
  const prompt = buildRoundtableSeatPrompt({
    participant,
    seat,
    message,
    topic: instruction,
    messages,
    originMessages,
    roomName,
    priorRoundNotes: [],
  });
  const runner = customButlerRunner ?? runDefaultParticipantTurn;
  const seatParticipant: RoomAiParticipant = {
    ...participant,
    agentKind: seat.agentKind,
    agentId: seat.agentId,
    agentName: seat.roleTitle,
    threadId: seat.threadId,
    acpSessionKey: seat.acpSessionKey,
  };

  const reply = await runner({
    participant: seatParticipant,
    prompt,
    instruction,
    message,
    roomName,
    seat,
  });

  if (reply.threadId || reply.acpSessionKey) {
    useRoomAiParticipants.getState().upsertSeat(rid, {
      ...seat,
      ...(reply.threadId ? { threadId: reply.threadId } : {}),
      ...(reply.acpSessionKey ? { acpSessionKey: reply.acpSessionKey } : {}),
    });
  }

  const body = reply.text.trim();
  if (!body) return false;

  const parsedDecision = parseDecisionBlockFromBody(body);
  if (parsedDecision.decision) {
    useRoomAiParticipants.getState().updateParticipant(rid, {
      latestDecisionSummary: summarizeDecisionForHandoff(parsedDecision.decision),
    });
  }

  const formatted = formatHostedRoomAiReply(
    seat.roleTitle,
    body,
    seat.agentName,
  );
  await postRoomAiReply(rid, message.tmid, formatted);
  return true;
}

async function runRoundtableRelay(
  rid: string,
  participant: RoomAiParticipant,
  seats: readonly RoomAiSeat[],
  instruction: string,
  message: RcMessage,
  roomName: string,
  messages: readonly RcMessage[],
  originMessages?: readonly RcMessage[],
): Promise<boolean> {
  const enabledSeats = seats.filter((s) => s.enabled);
  if (enabledSeats.length === 0) return false;

  const processSeats = enabledSeats.filter((s) => s.roleId !== 'captain');
  const captainSeat = enabledSeats.find((s) => s.roleId === 'captain');
  const totalSteps = processSeats.length + (captainSeat ? 1 : 0);
  if (totalSteps === 0) return false;

  const runId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `rt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const runAbort = new AbortController();
  const ctrl: ActiveRoundtableController = {
    runId,
    runAbort,
    seatAbort: null,
    skipCurrent: false,
    forceSynthesize: false,
  };
  activeRoundtableControllers.set(rid, ctrl);

  const runner = customButlerRunner ?? runDefaultParticipantTurn;
  const roundNotes: Array<{ roleTitle: string; agentName: string; text: string }> = [];
  let postedCount = 0;

  try {
    for (let idx = 0; idx < processSeats.length; idx += 1) {
      if (runAbort.signal.aborted || ctrl.forceSynthesize) break;
      const seat = processSeats[idx];
      ctrl.skipCurrent = false;
      const seatAbort = new AbortController();
      ctrl.seatAbort = seatAbort;

      useRoundtableLiveState.setState((state) => ({
        runs: {
          ...state.runs,
          [rid]: {
            runId,
            currentSeatId: seat.seatId,
            currentSeatTitle: seat.roleTitle,
            currentRoleId: seat.roleId,
            stepIndex: idx + 1,
            totalSteps,
            activityHint: seatActivityHint(seat.roleId),
          },
        },
      }));

      const prompt = buildRoundtableSeatPrompt({
        participant,
        seat,
        message,
        topic: instruction,
        messages,
        originMessages,
        roomName,
        priorRoundNotes: roundNotes,
      });

      const seatParticipant: RoomAiParticipant = {
        ...participant,
        agentKind: seat.agentKind,
        agentId: seat.agentId,
        agentName: seat.roleTitle,
        threadId: seat.threadId,
        acpSessionKey: seat.acpSessionKey,
      };

      try {
        const reply = await raceWithAbortSignals(
          runner({
            participant: seatParticipant,
            prompt,
            instruction,
            message,
            roomName,
            seat,
            signal: seatAbort.signal,
          }),
          runAbort.signal,
          seatAbort.signal,
        );

        if (runAbort.signal.aborted) break;

        if (reply.threadId || reply.acpSessionKey) {
          useRoomAiParticipants.getState().upsertSeat(rid, {
            ...seat,
            ...(reply.threadId ? { threadId: reply.threadId } : {}),
            ...(reply.acpSessionKey ? { acpSessionKey: reply.acpSessionKey } : {}),
          });
        }

        const body = reply.text.trim();
        if (body) {
          roundNotes.push({
            roleTitle: seat.roleTitle,
            agentName: seat.agentName,
            text: body,
          });
          const note = `${seat.agentName} · ${t('chat.aiParticipant.roundtableRoundNote', { round: 1 })}`;
          await postRoomAiReply(rid, message.tmid, formatHostedRoomAiReply(seat.roleTitle, body, note));
          postedCount += 1;
        }
      } catch (err) {
        if (err instanceof SeatAbortError) {
          if (runAbort.signal.aborted) break;
          if (ctrl.forceSynthesize) break;
          if (ctrl.skipCurrent) {
            ctrl.skipCurrent = false;
            continue;
          }
        }
        throw err;
      }
    }

    if (captainSeat && !runAbort.signal.aborted) {
      const seatAbort = new AbortController();
      ctrl.seatAbort = seatAbort;
      useRoundtableLiveState.setState((state) => ({
        runs: {
          ...state.runs,
          [rid]: {
            runId,
            currentSeatId: captainSeat.seatId,
            currentSeatTitle: captainSeat.roleTitle,
            currentRoleId: captainSeat.roleId,
            stepIndex: totalSteps,
            totalSteps,
            activityHint: seatActivityHint(captainSeat.roleId),
          },
        },
      }));

      const prompt = buildRoundtableSeatPrompt({
        participant,
        seat: captainSeat,
        message,
        topic: instruction,
        messages,
        originMessages,
        roomName,
        priorRoundNotes: roundNotes,
      });

      const captainParticipant: RoomAiParticipant = {
        ...participant,
        agentKind: captainSeat.agentKind,
        agentId: captainSeat.agentId,
        agentName: captainSeat.roleTitle,
        threadId: captainSeat.threadId,
        acpSessionKey: captainSeat.acpSessionKey,
      };

      const reply = await raceWithAbortSignals(
        runner({
          participant: captainParticipant,
          prompt,
          instruction,
          message,
          roomName,
          seat: captainSeat,
          signal: seatAbort.signal,
        }),
        runAbort.signal,
        seatAbort.signal,
      );

      if (!runAbort.signal.aborted) {
        if (reply.threadId || reply.acpSessionKey) {
          useRoomAiParticipants.getState().upsertSeat(rid, {
            ...captainSeat,
            ...(reply.threadId ? { threadId: reply.threadId } : {}),
            ...(reply.acpSessionKey ? { acpSessionKey: reply.acpSessionKey } : {}),
          });
        }
        const body = reply.text.trim();
        if (body) {
          const parsedDecision = parseDecisionBlockFromBody(body);
          const summary = parsedDecision.decision
            ? summarizeDecisionForHandoff(parsedDecision.decision)
            : body.slice(0, 360);
          useRoomAiParticipants.getState().updateParticipant(rid, {
            latestDecisionSummary: summary,
          });
          await postRoomAiReply(
            rid,
            message.tmid,
            formatHostedRoomAiReply(
              captainSeat.roleTitle,
              body,
              t('chat.aiParticipant.decisionNote'),
            ),
          );
          postedCount += 1;
        }
      }
    }

    return postedCount > 0;
  } finally {
    if (activeRoundtableControllers.get(rid)?.runId === runId) {
      activeRoundtableControllers.delete(rid);
      useRoundtableLiveState.setState((state) => {
        if (state.runs[rid]?.runId !== runId) return state;
        const next = { ...state.runs };
        delete next[rid];
        return { runs: next };
      });
    }
  }
}

export async function handleRoomAiParticipantMessage(
  rid: string,
  message: RcMessage,
): Promise<boolean> {
  const participant = useRoomAiParticipants.getState().getActiveParticipant(rid);
  if (!participant) return false;
  if (!message._id || message.pending || message.failed || message.t) return false;
  if (participant.lastProcessedMessageId === message._id || processedMessageIds.has(message._id)) {
    return false;
  }

  const rawText = (message.msg ?? '').trim();
  if (!rawText || /^🤖(?:\s|$)/u.test(rawText)) return false;

  const chatState = useChat.getState();
  const room = chatState.subscriptions[rid] ?? chatState.rooms[rid];
  const roomName = room?.fname || room?.name || rid;
  const messages = chatState.messages[rid] ?? [];
  const originMessages = participant.originDiscussionRid
    ? chatState.messages[participant.originDiscussionRid] ?? []
    : undefined;

  if (participant.mode === 'roundtable') {
    const seats = participant.seats?.length
      ? participant.seats
      : createDefaultRoundtableSeats({
          kind: participant.agentKind,
          id: participant.agentId,
          name: participant.agentName,
        });
    const targeted = matchTargetedSeat(rawText, seats, participant.agentName);
    if (participant.replyPolicy === 'mention_only' && !targeted) {
      return false;
    }

    rememberProcessedMessage(message._id);
    useRoomAiParticipants.getState().updateParticipant(rid, {
      lastProcessedMessageId: message._id,
    });

    try {
      if (targeted?.kind === 'seat') {
        return await runSingleSeatTurn(
          rid,
          participant,
          targeted.seat,
          targeted.instruction,
          message,
          roomName,
          messages,
          originMessages,
        );
      }
      return await runRoundtableRelay(
        rid,
        participant,
        seats,
        targeted?.instruction ?? rawText,
        message,
        roomName,
        messages,
        originMessages,
      );
    } catch (error) {
      if (error instanceof SeatAbortError) {
        return false;
      }
      const detail = error instanceof Error ? error.message : String(error);
      const errorBody = t('chat.aiParticipant.replyFailedBody', { error: detail });
      await postRoomAiReply(
        rid,
        message.tmid,
        formatHostedRoomAiReply(participant.agentName, errorBody, t('chat.aiParticipant.errorNote')),
      ).catch(() => undefined);
      return false;
    }
  }

  const instruction = extractRoomParticipantInstruction(
    rawText,
    participant.replyPolicy,
    participant.agentName,
  );
  if (!instruction) return false;

  rememberProcessedMessage(message._id);
  useRoomAiParticipants.getState().updateParticipant(rid, {
    lastProcessedMessageId: message._id,
  });

  const prompt = buildRoomAiParticipantPrompt({
    participant,
    message,
    instruction,
    messages,
    originMessages,
    roomName,
  });

  const runner = customButlerRunner ?? runDefaultParticipantTurn;

  try {
    const reply = await runner({
      participant,
      prompt,
      instruction,
      message,
      roomName,
    });

    const patch: Partial<RoomAiParticipant> = {};
    if (reply.threadId && reply.threadId !== participant.threadId) {
      patch.threadId = reply.threadId;
    }
    if (reply.acpSessionKey && reply.acpSessionKey !== participant.acpSessionKey) {
      patch.acpSessionKey = reply.acpSessionKey;
    }
    if (Object.keys(patch).length > 0) {
      useRoomAiParticipants.getState().updateParticipant(rid, patch);
    }

    const body = reply.text.trim();
    if (!body) return false;

    const note = participant.isDiscussion
      ? t('chat.aiParticipant.discussionReplyNote')
      : t('chat.aiParticipant.groupReplyNote');
    const formatted = formatHostedRoomAiReply(participant.agentName, body, note);
    await postRoomAiReply(rid, message.tmid, formatted);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const errorBody = t('chat.aiParticipant.replyFailedBody', { error: detail });
    await postRoomAiReply(
      rid,
      message.tmid,
      formatHostedRoomAiReply(participant.agentName, errorBody, t('chat.aiParticipant.errorNote')),
    ).catch(() => undefined);
    return false;
  }
}

/**
 * 将圆桌《方案决议卡》拍板并转为可执行工作卡，经 4 层防爆炸守护决定原位安全快照施工或受管隔离 Worktree。
 */
export async function dispatchRoundtableDecisionToWork(input: {
  rid: string;
  mid?: string;
  decision: RoundtableDecisionPayload;
  chosenOptionId?: string;
  forceIsolateWorktree?: boolean;
}): Promise<{
  cardId: string;
  mode: 'in_place_checkpoint' | 'isolated_worktree';
  completion?: Promise<boolean>;
}> {
  const { rid, mid, decision, chosenOptionId, forceIsolateWorktree } = input;
  const participant = useRoomAiParticipants.getState().participants[rid];
  const chatState = useChat.getState();
  const room = chatState.subscriptions[rid] ?? chatState.rooms[rid];
  const roomName = room?.fname || room?.name || rid;
  const repoRoot = participant?.workspaceRoot || resolvePreferredProjectWorkspace();

  const chosen =
    decision.options.find((opt) => opt.id === chosenOptionId)
    ?? decision.options.find((opt) => opt.recommended)
    ?? decision.options[0];

  const acceptance =
    decision.acceptance && decision.acceptance.length > 0
      ? decision.acceptance
      : [t('agent.superAgent.defaultAcceptance')];

  const goalLines = [
    decision.title,
    chosen ? `Chosen option: ${chosen.label}${chosen.summary ? ` (${chosen.summary})` : ''}` : '',
    decision.consensus.length > 0 ? `Consensus: ${decision.consensus.join('; ')}` : '',
    decision.targetFiles?.length ? `Target files: ${decision.targetFiles.join(', ')}` : '',
  ].filter(Boolean);

  const card = await useWorkLedger.getState().createCard({
    title: decision.title,
    goal: goalLines.join('\n'),
    nextStep: chosen?.label || decision.title,
    acceptance,
    boundaries: decision.contention ? [decision.contention] : [],
    rid,
    mid,
    ownerKind: 'ai_dispatched',
    autonomyMode: 'confirm',
    enroll: true,
    stage: 'ready',
  });

  const plan = await planSafeExecutionWorkspace({
    repoRoot,
    cardId: card.id,
    forceIsolateWorktree,
  });

  useButlerRoomBindings.getState().bindToRoom({
    targetKind: 'acp_session',
    targetId: card.id,
    label: decision.title,
    rid,
    roomName,
    autoPost: true,
  });

  const summary = summarizeDecisionForHandoff(decision, chosen?.id);
  useRoomAiParticipants.getState().updateParticipant(rid, {
    linkedCardId: card.id,
    latestDecisionSummary: summary,
  });

  let execWorkspaceRoot = plan.workspaceRoot;
  if (plan.mode === 'isolated_worktree' && isTauriRuntime() && repoRoot.trim()) {
    const wt = await prepareNativeWorktree({
      repoRoot: repoRoot.trim(),
      branchName: `ai/card-${card.id.slice(0, 8)}`,
      slug: `card-${card.id.slice(0, 8)}`,
    });
    execWorkspaceRoot = wt.worktreePath;
    await useWorkLedger.getState().upsertLink({
      todoId: card.id,
      kind: 'git_branch',
      externalId: wt.branch,
      project: card.adoProject,
      repo: repoRoot.trim(),
      rid,
      headSha: wt.headSha,
      title: `Worktree: ${wt.branch}`,
      webUrl: null,
      stateSnapshot: 'isolated_worktree',
    }).catch(() => undefined);
    await useWorkLedger.getState().upsertSession({
      todoId: card.id,
      visibility: card.state.visibility,
      runtime: 'pi',
      origin: 'rocketx_managed',
      nativeSessionId: `roundtable-exec-${card.id.slice(0, 8)}`,
      title: card.title,
      workspaceRoot: execWorkspaceRoot,
      environmentId: card.state.environmentId,
      accountScope: null,
      controlEndpoint: 'pi-app-server://local',
      controlMode: 'controllable',
      controlReason: 'owned_live_controller',
      hostDeviceId: 'local',
      writerLeaseOwner: 'rocketx:local',
      writerLeaseExpiresAt: null,
      runtimeStatus: 'running',
      configSnapshotJson: JSON.stringify({ isolatedWorktree: true, branch: wt.branch }),
      lastEventSeq: 1,
      lastTurnId: null,
    }).catch(() => undefined);
  }

  const noticeText =
    plan.mode === 'isolated_worktree'
      ? t('chat.aiParticipant.dispatchedWorktree', { option: chosen?.label || decision.title })
      : t('chat.aiParticipant.dispatchedInPlace', { option: chosen?.label || decision.title });

  await postRoomAiReply(
    rid,
    undefined,
    formatHostedRoomAiReply(
      t('chat.aiParticipant.seatCaptainTitle'),
      noticeText,
      t('chat.aiParticipant.decisionNote'),
    ),
  );

  const canRunExecutionPipeline =
    Boolean(execWorkspaceRoot.trim())
    && (isTauriRuntime() || customButlerRunner !== null || hasCustomAutomationControllerFactory());

  if (!canRunExecutionPipeline) {
    return { cardId: card.id, mode: plan.mode };
  }

  const execParticipant: RoomAiParticipant = participant
    ? { ...participant, workspaceRoot: execWorkspaceRoot }
    : {
        rid,
        isDiscussion: true,
        mode: 'roundtable',
        agentKind: 'pi_butler',
        agentId: 'pi_butler',
        agentName: t('chat.aiParticipant.roundtableBadgeName'),
        replyPolicy: 'every_message',
        enabled: true,
        workspaceRoot: execWorkspaceRoot,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
  const seats = execParticipant.seats?.length
    ? execParticipant.seats
    : createDefaultRoundtableSeats();
  const architectSeat = seats.find((s) => s.roleId === 'architect') ?? seats[0];
  const contrarianSeat = seats.find((s) => s.roleId === 'contrarian') ?? architectSeat;
  const runner = customButlerRunner ?? runDefaultParticipantTurn;
  const dummyMsg: RcMessage = {
    _id: `exec-${card.id}`,
    rid,
    msg: decision.title,
    ts: new Date().toISOString(),
    u: { _id: 'system', username: 'system', name: 'System' },
  } as RcMessage;

  const completion = (async (): Promise<boolean> => {
    const pipelineRunId = `exec-${card.id}`;
    try {
      await useWorkLedger.getState().updateCard(card.id, { stage: 'in_progress' }).catch(() => undefined);

      useRoundtableLiveState.setState((state) => ({
        runs: {
          ...state.runs,
          [rid]: {
            runId: pipelineRunId,
            currentSeatId: architectSeat.seatId,
            currentSeatTitle: architectSeat.roleTitle,
            currentRoleId: architectSeat.roleId,
            stepIndex: 1,
            totalSteps: 2,
            activityHint: t('chat.aiParticipant.activityImplementing'),
          },
        },
      }));

      const implPrompt = [
        `[Approved Decision Implementation inside "${execWorkspaceRoot}"]`,
        `Title: ${decision.title}`,
        chosen ? `Approved Option: ${chosen.label}${chosen.summary ? ` — ${chosen.summary}` : ''}` : '',
        decision.consensus.length ? `Consensus:\n- ${decision.consensus.join('\n- ')}` : '',
        decision.targetFiles?.length ? `Target Files:\n- ${decision.targetFiles.join('\n- ')}` : '',
        `Acceptance Criteria:\n- ${acceptance.join('\n- ')}`,
        participant?.latestDecisionSummary ? `Context Summary:\n${participant.latestDecisionSummary}` : '',
        'Instructions: Implement the approved changes directly inside the workspace files, add or update automated tests, and execute the relevant test suite using tools to confirm ALL tests pass. Leave the verified changes in the working tree (do NOT git commit, git push, create a PR, or call external issue APIs — PR delivery runs in the next step). Reply concisely with the exact files edited and observed test output. Do NOT invent results.',
      ].filter(Boolean).join('\n\n');

      const implReply = await runner({
        participant: { ...execParticipant, agentKind: architectSeat.agentKind, agentId: architectSeat.agentId, agentName: architectSeat.roleTitle },
        prompt: implPrompt,
        instruction: decision.title,
        message: dummyMsg,
        roomName,
        seat: { ...architectSeat, threadId: undefined },
      });

      const implText = implReply.text.trim();
      if (implText) {
        await postRoomAiReply(
          rid,
          undefined,
          formatHostedRoomAiReply(
            architectSeat.roleTitle,
            implText,
            t('chat.aiParticipant.execCodingNote'),
          ),
        );
      }

      await useWorkLedger.getState().updateCard(card.id, { stage: 'verifying' }).catch(() => undefined);

      useRoundtableLiveState.setState((state) => ({
        runs: {
          ...state.runs,
          [rid]: {
            runId: pipelineRunId,
            currentSeatId: contrarianSeat.seatId,
            currentSeatTitle: contrarianSeat.roleTitle,
            currentRoleId: contrarianSeat.roleId,
            stepIndex: 2,
            totalSteps: 2,
            activityHint: t('chat.aiParticipant.activityVerifying'),
          },
        },
      }));

      const verifyPrompt = [
        `[Independent Adversarial Verification inside "${execWorkspaceRoot}"]`,
        `You are verifying the implementation of: ${decision.title}`,
        `Acceptance Criteria:\n- ${acceptance.join('\n- ')}`,
        implText ? `Implementer Report:\n${implText}` : '',
        'Instructions: Strictly READ-ONLY (do NOT edit or write files). Verify the working-tree edits (git status / git diff / file inspection) and re-run the test command yourself via tools to independently confirm every acceptance criterion and check for edge-case bugs. IMPORTANT: Uncommitted working-tree changes are expected here — do NOT mark FAIL solely because changes are not yet committed, pushed, or opened as a PR (RocketX handles branching, commit/push, PR creation, and issue comments in the subsequent PR Delivery step). Summarize what you inspected and end your reply on the final line with exactly `[VERDICT: PASS]` or `[VERDICT: FAIL]`.',
      ].filter(Boolean).join('\n\n');

      const verifyReply = await runner({
        participant: { ...execParticipant, agentKind: contrarianSeat.agentKind, agentId: contrarianSeat.agentId, agentName: contrarianSeat.roleTitle },
        prompt: verifyPrompt,
        instruction: `Verify: ${decision.title}`,
        message: dummyMsg,
        roomName,
        seat: { ...contrarianSeat, threadId: undefined },
      });

      const rawVerify = verifyReply.text.trim();
      const passed = rawVerify.length > 0 && !/\[VERDICT:\s*FAIL\]/i.test(rawVerify);
      const cleanVerify = rawVerify.replace(/\[VERDICT:\s*(?:PASS|FAIL)\]/giu, '').trim() || rawVerify;

      if (cleanVerify) {
        await postRoomAiReply(
          rid,
          undefined,
          formatHostedRoomAiReply(
            contrarianSeat.roleTitle,
            cleanVerify,
            passed
              ? t('chat.aiParticipant.execVerifyPassNote')
              : t('chat.aiParticipant.execVerifyFailNote'),
          ),
        );
      }

      const currentCard = useWorkLedger.getState().cards.find((c) => c.id === card.id) ?? card;
      await useWorkLedger.getState().addEvidence({
        todoId: card.id,
        sessionId: null,
        kind: 'test_run',
        title: `${contrarianSeat.roleTitle} · ${passed ? t('chat.aiParticipant.execVerifyPassNote') : t('chat.aiParticipant.execVerifyFailNote')}`,
        summary: cleanVerify.slice(0, 500) || null,
        headSha: null,
        workspaceRoot: execWorkspaceRoot,
        webUrl: null,
        passed,
        criterionIds: currentCard.state.acceptance,
        requirementsVersion: currentCard.state.requirementsVersion ?? 0,
        contentVersion: currentCard.state.contentVersion ?? 0,
      }).catch(() => undefined);

      if (passed) {
        await useWorkLedger.getState().updateCard(card.id, { stage: 'done' }).catch(() => undefined);
      } else {
        await useWorkLedger.getState().updateCard(card.id, {
          stage: 'ready',
          waitState: 'waiting_approval',
          waitReason: cleanVerify.slice(0, 120),
        }).catch(() => undefined);
      }
      return passed;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await useWorkLedger.getState().updateCard(card.id, {
        stage: 'ready',
        waitState: 'blocked',
        waitReason: detail.slice(0, 120),
      }).catch(() => undefined);
      await postRoomAiReply(
        rid,
        undefined,
        formatHostedRoomAiReply(
          t('chat.aiParticipant.seatArchitectTitle'),
          t('chat.aiParticipant.replyFailedBody', { error: detail }),
          t('chat.aiParticipant.errorNote'),
        ),
      ).catch(() => undefined);
      return false;
    } finally {
      useRoundtableLiveState.setState((state) => {
        if (state.runs[rid]?.runId !== pipelineRunId) return state;
        const next = { ...state.runs };
        delete next[rid];
        return { runs: next };
      });
    }
  })();

  return { cardId: card.id, mode: plan.mode, completion };
}

/**
 * 启动房间内 AI 参与者监听桥：
 * - 单 AI 模式走按房串行队列
 * - 圆桌模式收到新人类插话立即中断上一轮未播完的过时接力，并用最新前提重开
 */
export function startRoomAiParticipantBridge(): () => void {
  useRoomAiParticipants.getState().hydrate();
  const previousMessages = new Map<string, RcMessage[]>();
  const initializedRids = new Set<string>();

  const seedSnapshot = (rid: string, messages: readonly RcMessage[] | undefined) => {
    if (initializedRids.has(rid)) return;
    initializedRids.add(rid);
    previousMessages.set(rid, [...(messages ?? [])]);
  };

  const currentParticipants = useRoomAiParticipants.getState().participants;
  const currentChatMessages = useChat.getState().messages;
  for (const [rid, entry] of Object.entries(currentParticipants)) {
    if (entry.enabled) {
      seedSnapshot(rid, currentChatMessages[rid]);
    }
  }

  const unsubParticipants = useRoomAiParticipants.subscribe((state) => {
    const chatMessages = useChat.getState().messages;
    for (const [rid, entry] of Object.entries(state.participants)) {
      if (entry.enabled) {
        seedSnapshot(rid, chatMessages[rid]);
      } else {
        initializedRids.delete(rid);
        previousMessages.delete(rid);
        abortRoundtableRun(rid);
      }
    }
  });

  const unsubChat = useChat.subscribe((chatState) => {
    const participants = useRoomAiParticipants.getState().participants;
    for (const [rid, entry] of Object.entries(participants)) {
      if (!entry.enabled) continue;
      const current = chatState.messages[rid] ?? [];
      const historyJustLoaded = !initializedRids.has(rid);
      const changes = agentMessageBridgeChanges(
        current,
        previousMessages.get(rid) ?? [],
        historyJustLoaded,
      );
      initializedRids.add(rid);
      previousMessages.set(rid, [...current]);

      if (changes.handle.length === 0) continue;

      if (entry.mode === 'roundtable') {
        const seats = entry.seats?.length ? entry.seats : createDefaultRoundtableSeats();
        const triggeringMessages = changes.handle.filter((msg) => {
          const text = (msg.msg ?? '').trim();
          if (!text || msg.pending || msg.failed || msg.t) return false;
          if (/^🤖(?:\s|$)/u.test(text)) return false;
          if (entry.replyPolicy === 'every_message') return true;
          return matchTargetedSeat(text, seats, entry.agentName) !== null;
        });

        if (triggeringMessages.length > 0) {
          abortRoundtableRun(rid);
          for (const message of triggeringMessages) {
            void handleRoomAiParticipantMessage(rid, message);
          }
        }
        continue;
      }

      for (const message of changes.handle) {
        void queueForRoom(rid).enqueue(() => handleRoomAiParticipantMessage(rid, message));
      }
    }
  });

  return () => {
    unsubParticipants();
    unsubChat();
    for (const rid of [...activeRoundtableControllers.keys()]) {
      abortRoundtableRun(rid);
    }
  };
}
