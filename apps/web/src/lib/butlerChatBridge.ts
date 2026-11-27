import { t } from '../i18n';

export const BUTLER_SHARE_MIME = 'application/x-rcx-butler-share';
export const CHAT_TO_BUTLER_MIME = 'application/x-rcx-chat-message';
export const AI_PARTICIPANT_MIME = 'application/x-rcx-ai-participant';

export interface AiParticipantSeatSnapshot {
  seatId: string;
  roleId: 'product' | 'architect' | 'contrarian' | 'captain' | 'custom';
  roleTitle: string;
  stancePrompt?: string;
  agentKind: 'pi_butler' | 'acp';
  agentId: string;
  agentName: string;
  enabled: boolean;
  threadId?: string;
  acpSessionKey?: string;
}

export interface AiParticipantDragPayload {
  source: 'butler' | 'acp_agent' | 'ai_discussion';
  mode?: 'solo' | 'roundtable';
  seats?: AiParticipantSeatSnapshot[];
  agentKind: 'pi_butler' | 'acp';
  agentId: string;
  agentName: string;
  discussionRid?: string;
  discussionName?: string;
  threadId?: string;
  acpSessionKey?: string;
  workspaceRoot?: string;
  summary?: string;
  decisionSummary?: string;
}

export type ButlerSharePayload =
  | {
      kind: 'insight';
      id: string;
      insightKind: string;
      title: string;
      summary: string;
      suggestedActions?: string[];
      ref?: { rid?: string; todoId?: string; sessionKey?: string; actionId?: string };
    }
  | {
      kind: 'reply';
      messageId: string;
      title?: string;
      text: string;
      workspaceRoot?: string;
    }
  | {
      kind: 'acp_session';
      sessionKey: string;
      agentId: string;
      agentName: string;
      title: string;
      status: string;
      summary: string;
      pendingApproval?: string;
      workspaceRoot?: string;
    }
  | {
      kind: 'work_card';
      cardId: string;
      title: string;
      stage: string;
      waitState: string;
      goal?: string;
      nextStep?: string;
    }
  | {
      kind: 'skill';
      skillId: string;
      slug: string;
      name: string;
      description: string;
      category: string;
      approvalPolicy: string;
      triggers: string[];
      allowedTools: string[];
      instructionsMd: string;
    }
  | {
      kind: 'watchpoint';
      watchpointId: string;
      reason: string;
      conditionKind: string;
      expiresAt: number;
    };

export interface ChatToButlerMessageItem {
  mid: string;
  sender: string;
  username: string;
  ts: number;
  text: string;
  tmid?: string;
}

export interface ChatToButlerPayload {
  rid: string;
  roomName: string;
  messages: ChatToButlerMessageItem[];
}

export interface ParsedSharedSkillCard {
  name: string;
  slug: string;
  description: string;
  category: string;
  approvalPolicy: string;
  triggers: string[];
  allowedTools: string[];
  instructionsPreview: string;
  rawMarkdown: string;
}

function unquoteYaml(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      /* fallback below */
    }
  }
  return trimmed.replace(/^["']|["']$/g, '');
}

function parseListField(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => String(v).trim()).filter(Boolean);
      }
    } catch {
      /* fallback */
    }
  }
  return trimmed
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => unquoteYaml(s))
    .filter(Boolean);
}

export function formatSharePayloadForChat(payload: ButlerSharePayload): string {
  switch (payload.kind) {
    case 'insight': {
      const lines = [
        `**[Butler · ${payload.title}]**`,
        payload.summary.trim(),
      ];
      if (payload.suggestedActions && payload.suggestedActions.length > 0) {
        lines.push('', `> ${t('chat.butlerBridge.suggestedPrefix')}: ${payload.suggestedActions.join(' / ')}`);
      }
      return lines.join('\n');
    }
    case 'reply': {
      const clean = payload.text.trim();
      return payload.title?.trim()
        ? `**[Butler · ${payload.title.trim()}]**\n\n${clean}`
        : clean;
    }
    case 'acp_session': {
      const lines = [
        `**[Agent · ${payload.agentName}] ${payload.title}** (\`${payload.status}\`)`,
      ];
      if (payload.summary.trim()) {
        lines.push('', payload.summary.trim());
      }
      if (payload.pendingApproval?.trim()) {
        lines.push('', `> **${t('chat.butlerBridge.pendingDecisionPrefix')}**: ${payload.pendingApproval.trim()}`);
      }
      return lines.join('\n');
    }
    case 'work_card': {
      const lines = [
        `**[${t('chat.butlerBridge.workCardPrefix')}] ${payload.title}** (\`${payload.stage}\` · \`${payload.waitState}\`)`,
      ];
      if (payload.goal?.trim()) lines.push(`- ${t('chat.butlerBridge.goalPrefix')}: ${payload.goal.trim()}`);
      if (payload.nextStep?.trim()) lines.push(`- ${t('chat.butlerBridge.nextStepPrefix')}: ${payload.nextStep.trim()}`);
      return lines.join('\n');
    }
    case 'watchpoint': {
      return `**[${t('chat.butlerBridge.watchpointPrefix')}]** ${payload.reason.trim()} (\`${payload.conditionKind}\`)`;
    }
    case 'skill': {
      const frontmatter = [
        '---',
        `name: ${JSON.stringify(payload.name)}`,
        `slug: ${JSON.stringify(payload.slug)}`,
        `description: ${JSON.stringify(payload.description || '')}`,
        `category: ${JSON.stringify(payload.category || 'general')}`,
        `approvalPolicy: ${JSON.stringify(payload.approvalPolicy || 'confirm_write')}`,
        `triggers: ${JSON.stringify(payload.triggers ?? [])}`,
        `allowedTools: ${JSON.stringify(payload.allowedTools ?? [])}`,
        '---',
        '',
        payload.instructionsMd.trim(),
      ].join('\n');
      const header = `**[${t('chat.butlerBridge.sharedSkillPrefix')}] ${payload.name}** (\`/${payload.slug}\`)${
        payload.description.trim() ? ` — ${payload.description.trim()}` : ''
      }`;
      return `${header}\n\n\`\`\`rocketx-skill\n${frontmatter}\n\`\`\``;
    }
  }
}

export function parseSharedSkillFromMessage(text: string): ParsedSharedSkillCard | null {
  if (!text) return null;
  const match = /```rocketx-skill[ \t]*\r?\n([\s\S]*?)```/i.exec(text);
  if (!match) return null;
  const rawMarkdown = match[1].trim();
  if (!rawMarkdown) return null;

  let name = 'Shared Skill';
  let slug = 'shared-skill';
  let description = '';
  let category = 'general';
  let approvalPolicy = 'confirm_write';
  let triggers: string[] = [];
  let allowedTools: string[] = [];
  let body = rawMarkdown;

  const normalized = rawMarkdown.replace(/\r\n/g, '\n');
  if (normalized.startsWith('---\n')) {
    const closeIdx = normalized.indexOf('\n---', 4);
    if (closeIdx > 0) {
      const fm = normalized.slice(4, closeIdx);
      body = normalized.slice(closeIdx + 4).trim();
      for (const line of fm.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const colon = trimmed.indexOf(':');
        if (colon <= 0) continue;
        const key = trimmed.slice(0, colon).trim();
        const val = trimmed.slice(colon + 1).trim();
        if (key === 'name' || key === 'title') name = unquoteYaml(val) || name;
        else if (key === 'slug' || key === 'id') slug = unquoteYaml(val) || slug;
        else if (key === 'description') description = unquoteYaml(val);
        else if (key === 'category') category = unquoteYaml(val) || category;
        else if (key === 'approvalPolicy' || key === 'approval_policy') approvalPolicy = unquoteYaml(val) || approvalPolicy;
        else if (key === 'triggers') triggers = parseListField(val);
        else if (key === 'allowedTools' || key === 'allowed_tools') allowedTools = parseListField(val);
      }
    }
  }

  return {
    name,
    slug,
    description,
    category,
    approvalPolicy,
    triggers,
    allowedTools,
    instructionsPreview: body.slice(0, 600),
    rawMarkdown: normalized,
  };
}

export function formatChatMessagesForButlerPrompt(payload: ChatToButlerPayload): string {
  const header = `[${t('chat.butlerBridge.fromRoomPrefix')}: #${payload.roomName || payload.rid} (rid=${payload.rid})]`;
  const quotes = payload.messages
    .slice(0, 12)
    .map((m) => `> **${m.sender || m.username}** (${m.mid}): ${m.text.trim().replace(/\n+/g, '\n> ')}`)
    .join('\n>\n');
  return `${header}\n${quotes}\n\n${t('chat.butlerBridge.handlePromptSuffix')}`;
}

function hasMimeType(dt: DataTransfer | null | undefined, mime: string): boolean {
  if (!dt?.types) return false;
  return Array.from(dt.types).includes(mime);
}

export function writeButlerShareDrag(dt: DataTransfer, payload: ButlerSharePayload): void {
  try {
    dt.setData(BUTLER_SHARE_MIME, JSON.stringify(payload));
    dt.setData('text/plain', formatSharePayloadForChat(payload));
    dt.effectAllowed = 'copy';
  } catch {
    /* ignore restricted DataTransfer */
  }
}

export function hasButlerShareDrag(dt: DataTransfer | null | undefined): boolean {
  return hasMimeType(dt, BUTLER_SHARE_MIME);
}

export function readButlerShareDrag(dt: DataTransfer | null | undefined): ButlerSharePayload | null {
  if (!dt) return null;
  try {
    const raw = dt.getData(BUTLER_SHARE_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ButlerSharePayload>;
    if (!parsed || typeof parsed.kind !== 'string') return null;
    return parsed as ButlerSharePayload;
  } catch {
    return null;
  }
}

export function writeChatToButlerDrag(dt: DataTransfer, payload: ChatToButlerPayload): void {
  try {
    dt.setData(CHAT_TO_BUTLER_MIME, JSON.stringify(payload));
    dt.setData('text/plain', formatChatMessagesForButlerPrompt(payload));
    dt.effectAllowed = 'copy';
  } catch {
    /* ignore restricted DataTransfer */
  }
}

export function hasChatToButlerDrag(dt: DataTransfer | null | undefined): boolean {
  return hasMimeType(dt, CHAT_TO_BUTLER_MIME);
}

export function readChatToButlerDrag(dt: DataTransfer | null | undefined): ChatToButlerPayload | null {
  if (!dt) return null;
  try {
    const raw = dt.getData(CHAT_TO_BUTLER_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatToButlerPayload>;
    if (!parsed || typeof parsed.rid !== 'string' || !Array.isArray(parsed.messages)) return null;
    return parsed as ChatToButlerPayload;
  } catch {
    return null;
  }
}

export function formatAiDiscussionHandoffDraft(payload: AiParticipantDragPayload): string {
  if (payload.mode === 'roundtable' && payload.decisionSummary?.trim()) {
    const scopeTitle = payload.discussionName
      ? `${t('chat.aiParticipant.roundtableHandoffTitle')}（${payload.discussionName}）`
      : t('chat.aiParticipant.roundtableHandoffTitle');
    return `🤖 **${scopeTitle}**\n${payload.decisionSummary.trim()}\n${t('chat.aiParticipant.roundtableHandoffHint')}`;
  }
  const title = payload.discussionName
    ? `🤖 **${payload.agentName}** (${payload.discussionName})`
    : `🤖 **${payload.agentName}**`;
  const lines = [title];
  if (payload.summary?.trim()) {
    lines.push(payload.summary.trim());
  }
  lines.push(t('chat.aiParticipant.handoffHint'));
  return lines.join('\n');
}

export function writeAiParticipantDrag(dt: DataTransfer, payload: AiParticipantDragPayload): void {
  try {
    dt.setData(AI_PARTICIPANT_MIME, JSON.stringify(payload));
    dt.setData('text/plain', formatAiDiscussionHandoffDraft(payload));
    dt.effectAllowed = 'copy';
  } catch {
    /* ignore restricted DataTransfer */
  }
}

export function hasAiParticipantDrag(dt: DataTransfer | null | undefined): boolean {
  return hasMimeType(dt, AI_PARTICIPANT_MIME);
}

export function readAiParticipantDrag(dt: DataTransfer | null | undefined): AiParticipantDragPayload | null {
  if (!dt) return null;
  try {
    const raw = dt.getData(AI_PARTICIPANT_MIME);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AiParticipantDragPayload>;
    if (
      !parsed
      || (parsed.agentKind !== 'pi_butler' && parsed.agentKind !== 'acp')
      || typeof parsed.agentId !== 'string'
      || typeof parsed.agentName !== 'string'
    ) {
      return null;
    }
    return {
      source: parsed.source === 'acp_agent' || parsed.source === 'ai_discussion' ? parsed.source : 'butler',
      mode: parsed.mode === 'roundtable' ? 'roundtable' : parsed.mode === 'solo' ? 'solo' : undefined,
      seats: Array.isArray(parsed.seats) ? parsed.seats : undefined,
      agentKind: parsed.agentKind,
      agentId: parsed.agentId,
      agentName: parsed.agentName,
      discussionRid: typeof parsed.discussionRid === 'string' ? parsed.discussionRid : undefined,
      discussionName: typeof parsed.discussionName === 'string' ? parsed.discussionName : undefined,
      threadId: typeof parsed.threadId === 'string' ? parsed.threadId : undefined,
      acpSessionKey: typeof parsed.acpSessionKey === 'string' ? parsed.acpSessionKey : undefined,
      workspaceRoot: typeof parsed.workspaceRoot === 'string' ? parsed.workspaceRoot : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
      decisionSummary: typeof parsed.decisionSummary === 'string' ? parsed.decisionSummary : undefined,
    };
  } catch {
    return null;
  }
}
