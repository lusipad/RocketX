import {
  ArrowUpRight,
  BookmarkPlus,
  Bot,
  Brain,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  FolderOpen,
  GitBranch,
  GitCompare,
  GitFork,
  Loader2,
  Mic,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  PauseCircle,
  Pin,
  RefreshCw,
  Send,
  Settings,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openCodexNewThread } from '../agent/codexTransfer';
import { useI18n, useT, type MessageKey, type TranslateFn } from '../i18n';
import {
  codexArtifactFromLink,
  codexArtifactsFromMarkdown,
  type CodexArtifact,
} from '../lib/codexArtifacts';
import { isTauriRuntime } from '../lib/client';
import { PI_CONFIGURED_STORAGE_KEY } from '../lib/runtimeMode';
import { openDesktopDialog } from '../platform/desktopDialog';
import { revealDesktopPath } from '../platform/desktopOpener';
import { renderMarkdownDoc, StableStreamingMarkdown, type MarkdownLinkRenderer } from '../lib/markdown';
import { createGitCheckpoint, diffWorkspaceGit, listWorkspaceFiles } from '../platform/desktopCommands';
import { useStickToBottom } from '../lib/stickToBottom';
import { resolvePortalWorkContext } from '../lib/workContext';
import { useCodexStreamingView } from '../lib/useCodexStreamingText';
import type { CodexHostInput } from '../agent/codexHostInput';
import { appendCodexImages, type CodexImageInput } from '../lib/codexImages';
import {
  applyComposerReplacement,
  detectComposerTrigger,
  rankSlashCommands,
  type ActiveComposerToken,
  type RankedSlashOption,
} from '../lib/composerCommands';
import { useAgentComposerDraft, useAgentComposerDrafts, type AgentComposerRequest } from '../stores/agentComposerDrafts';
import {
  useCodexWorkspace,
  type CodexFollowUpMode,
  type CodexPendingRequest,
  type CodexWorkspaceEvent,
  type CodexWorkspaceMessage,
} from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import ShareToRoomButton from './ShareToRoomButton';
import PullAiToChatButton from './PullAiToChatButton';
import {
  formatChatMessagesForButlerPrompt,
  hasChatToButlerDrag,
  readChatToButlerDrag,
  writeButlerShareDrag,
} from '../lib/butlerChatBridge';
import { useWorkLedger } from '../stores/workLedger';
import { buildSkillExecutionPrompt, useButlerSkills } from '../stores/butlerSkills';
import { useButlerCognition } from '../stores/butlerCognition';
import { useButlerMemory, type ButlerMemoryEntry } from '../stores/butlerMemory';
import { parseDelegationEvent, type ParsedDelegationEvent } from '../agent/chiefOfStaff';
import {
  extractMemoryCandidates,
  parseRecalledMemoryBlock,
  recallForPrompt,
  type MemoryCandidate,
} from '../agent/memoryAutoRecall';
import ButlerConversationHistory from './ButlerConversationHistory';
import ButlerErrandInputCard from './ButlerErrandInputCard';
import ButlerWorkPortalDock, { type PortalTab } from './ButlerWorkPortalDock';
import { CodexArtifactLink } from './CodexArtifactPanel';
import WorkDiffDrawer from './WorkDiffDrawer';
import ButlerTerminalDrawer from './ButlerTerminalDrawer';
import { ButlerComposerFilePopover, ButlerComposerSlashPopover } from './ButlerComposerPopovers';
import PiQuickOnboardingCard from './PiQuickOnboardingCard';
import AgentComposerFeedback from './AgentComposerFeedback';
import LocalVoiceControls from './LocalVoiceControls';
import CodexImagePicker, {
  CodexGeneratedImages,
  CodexImageAttachments,
  CodexImagePreviews,
  pasteCodexImages,
} from './CodexImagePicker';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function approvalSummary(request: CodexPendingRequest): string {
  const params = request.params;
  if (typeof params.command === 'string') return params.command;
  if (Array.isArray(params.command)) return params.command.filter((part) => typeof part === 'string').join(' ');
  const changes = record(params.fileChanges);
  if (Object.keys(changes).length > 0) return Object.keys(changes).join('\n');
  const permissions = record(params.permissions ?? params.additionalPermissions);
  if (Object.keys(permissions).length > 0) return JSON.stringify(permissions, null, 2);
  if (typeof params.reason === 'string') return params.reason;
  return request.method;
}

function ApprovalCard({ request }: { request: CodexPendingRequest }) {
  const t = useT();
  const resolve = useCodexWorkspace((state) => state.resolveRequest);
  const decide = (action: 'accept' | 'accept-session' | 'decline'): void => {
    try {
      resolve(request.id, { action });
    } catch (reason) {
      toast.error(reason, t('butler.conversation.approvalSubmitFailed'));
    }
  };
  return (
    <section className="codex-native-request" aria-label={t('butler.conversation.approvalAria')}>
      <header>
        <CircleAlert size={15} aria-hidden="true" />
        <strong>{t('butler.conversation.approvalTitle')}</strong>
      </header>
      <pre>{approvalSummary(request)}</pre>
      <footer>
        <button type="button" onClick={() => decide('decline')}>{t('butler.conversation.approvalDecline')}</button>
        <button type="button" onClick={() => decide('accept-session')}>{t('butler.conversation.approvalAcceptSession')}</button>
        <button type="button" className="is-primary" onClick={() => decide('accept')}>{t('butler.conversation.approvalAcceptOnce')}</button>
      </footer>
    </section>
  );
}

function InputCard({ request }: { request: CodexPendingRequest }) {
  const resolve = useCodexWorkspace((state) => state.resolveRequest);
  const input: CodexHostInput = {
    id: request.id,
    method: request.method as CodexHostInput['method'],
    policy: 'host-input',
    params: request.params,
    at: Date.now(),
  };
  return (
    <ButlerErrandInputCard
      input={input}
      onResolve={(response) => {
        if ('answers' in response) {
          const values = Object.fromEntries(Object.entries(response.answers).map(([key, answer]) => [
            key,
            answer?.answers ?? [],
          ]));
          resolve(request.id, { action: 'accept', values });
          return;
        }
        resolve(request.id, {
          action: response.action,
          values: record(response.content),
        });
      }}
    />
  );
}

interface ComposerChoice {
  id: string;
  label: string;
  description?: string;
}

function ComposerMenu({
  ariaLabel,
  label,
  value,
  choices,
  disabled,
  onChange,
  footerAction,
}: {
  ariaLabel: string;
  label: string;
  value: string;
  choices: readonly ComposerChoice[];
  disabled?: boolean;
  onChange: (value: string) => void;
  footerAction?: { label: string; icon?: React.ReactNode; onClick: () => void };
}) {
  const t = useT();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!detailsRef.current?.contains(event.target as Node)) detailsRef.current?.removeAttribute('open');
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') detailsRef.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, []);

  return (
    <details ref={detailsRef} className="codex-native-menu">
      <summary
        aria-label={ariaLabel}
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <span>{label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </summary>
      <div role="menu" aria-label={t('butler.conversation.menuOptionsAria', { label: ariaLabel })}>
        {choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            role="menuitemradio"
            aria-checked={choice.id === value}
            onClick={() => {
              detailsRef.current?.removeAttribute('open');
              onChange(choice.id);
            }}
          >
            <span>{choice.label}{choice.id === value ? <Check size={13} aria-hidden="true" /> : null}</span>
            {choice.description ? <small>{choice.description}</small> : null}
          </button>
        ))}
        {footerAction ? (
          <div className="border-t border-line/50 mt-1 pt-1">
            <button
              type="button"
              role="menuitem"
              className="text-primary hover:text-primary-hover font-medium flex items-center gap-1.5 w-full text-left py-1.5 px-2 rounded hover:bg-fill-hover text-xs transition-colors"
              onClick={() => {
                detailsRef.current?.removeAttribute('open');
                footerAction.onClick();
              }}
            >
              {footerAction.icon}
              <span>{footerAction.label}</span>
            </button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function Activity({ event }: { event: CodexWorkspaceEvent }) {
  const statusIcon = event.status === 'running'
    ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
    : event.status === 'failed'
      ? <X size={13} aria-hidden="true" />
      : <Check size={13} aria-hidden="true" />;
  const heading = (
    <>
      {statusIcon}
      <span>
        <strong>{event.title}</strong>
        {event.summary ? <small>{event.summary}</small> : null}
      </span>
      {event.detail ? <ChevronDown size={13} aria-hidden="true" /> : null}
    </>
  );
  return event.detail ? (
    <details className="codex-native-activity" data-status={event.status}>
      <summary>{heading}</summary>
      <pre>{event.detail}</pre>
    </details>
  ) : (
    <div className="codex-native-activity" data-status={event.status}>{heading}</div>
  );
}

function DelegationTreeCard({ delegation }: { delegation: ParsedDelegationEvent }) {
  const t = useT();
  const setButlerView = useUI((state) => state.setButlerView);
  const [expanded, setExpanded] = useState(true);

  return (
    <section
      aria-label={t('butler.cos.delegationAria')}
      className="my-2 rounded-xl border border-primary/25 bg-surface-3 p-3 shadow-raise"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex items-center gap-1.5 text-left text-xs font-semibold text-ink hover:text-primary"
        >
          <GitFork size={13} className="text-primary" aria-hidden="true" />
          <span>{t('butler.cos.delegationTitle')}</span>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary">
            {delegation.nodes.length}
          </span>
          <ChevronDown
            size={12}
            className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setButlerView('kanban')}
            className="rounded-lg border border-line bg-surface-4 px-2 py-0.5 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-ink"
          >
            {t('butler.assistant.viewBoard')}
          </button>
          <button
            type="button"
            onClick={() => setButlerView('acp-hub')}
            className="rounded-lg border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary transition hover:bg-primary/20"
          >
            {t('butler.cos.openAcpHub')}
          </button>
        </div>
      </div>

      {expanded && (
        <ul className="mt-2 space-y-1.5 border-l-2 border-primary/30 pl-3">
          {delegation.nodes.map((node) => {
            const roleLabel = node.role === 'researcher' || node.role === 'coder' || node.role === 'reviewer' || node.role === 'ops'
              ? t(`butler.cos.role.${node.role}` as MessageKey)
              : node.role === 'coordinator'
                ? t('butler.cos.role.coordinator')
                : node.role === 'specialist'
                  ? t('butler.cos.role.specialist')
                  : node.role;
            const autonomyLabel = node.autonomyMode === 'readonly' || node.autonomyMode === 'confirm' || node.autonomyMode === 'autonomous'
              ? t(`butler.policy.autonomy.${node.autonomyMode}` as MessageKey)
              : node.autonomyMode;
            const stateLabel = node.state === 'completed' || node.state === 'failed' || node.state === 'awaiting_approval' || node.state === 'queued' || node.state === 'running'
              ? t(`butler.cos.state.${node.state}` as MessageKey)
              : node.state;
            return (
              <li
                key={`${delegation.eventId}-${node.index}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line-soft bg-surface-4 px-2.5 py-1.5 text-xs"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="rounded-full bg-fill-2 px-2 py-0.5 text-2xs font-medium text-ink-2">
                    {roleLabel}
                  </span>
                  <span className="truncate font-medium text-ink">{node.title}</span>
                  {node.agentName ? (
                    <span className="truncate text-xs text-ink-3">· {node.agentName}</span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {node.isolateWorktree ? (
                    <span className="rounded-full bg-fill-1 px-2 py-0.5 text-2xs text-ink-3">
                      {t('butler.cos.worktreeBadge')}
                    </span>
                  ) : null}
                  {autonomyLabel ? (
                    <span className="rounded-full bg-fill-1 px-2 py-0.5 text-2xs text-ink-2">
                      {autonomyLabel}
                    </span>
                  ) : null}
                  <span
                    className={`rounded-full px-2 py-0.5 text-2xs font-medium ${
                      node.state === 'completed'
                        ? 'bg-success/15 text-success'
                        : node.state === 'failed'
                          ? 'bg-danger/15 text-danger'
                          : node.state === 'awaiting_approval'
                            ? 'bg-warning/15 text-warning'
                            : 'bg-primary/10 text-primary'
                    }`}
                  >
                    {stateLabel}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ConversationMessage({
  entry,
  renderLink,
  progressive = false,
  streaming = false,
}: {
  entry: CodexWorkspaceMessage;
  renderLink: MarkdownLinkRenderer;
  progressive?: boolean;
  streaming?: boolean;
}) {
  const t = useT();
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const isAssistant = entry.role === 'assistant';
  const engineName = 'Pi';
  const [skillSaveOpen, setSkillSaveOpen] = useState(false);
  const [skillNameDraft, setSkillNameDraft] = useState('');
  const [savingSkill, setSavingSkill] = useState(false);
  const [copiedReply, setCopiedReply] = useState(false);

  const parsedUser = useMemo(() => {
    if (isAssistant || !entry.text) {
      return { cleanText: entry.text, recalledCount: 0, recalledLines: [] as string[], isPlanMode: false };
    }
    const recall = parseRecalledMemoryBlock(entry.text);
    const planPrefix = t('agent.composer.planModePrefix');
    let display = recall.cleanText;
    let isPlanMode = false;
    if (planPrefix && display.startsWith(planPrefix)) {
      isPlanMode = true;
      display = display.slice(planPrefix.length).replace(/^\s+/, '');
    }
    return {
      cleanText: display || entry.text,
      recalledCount: recall.recalledCount,
      recalledLines: recall.recalledLines,
      isPlanMode,
    };
  }, [entry.text, isAssistant, t]);

  const handleSaveAsSkill = async () => {
    const cleanName = skillNameDraft.trim();
    if (!cleanName || !entry.text.trim()) return;
    setSavingSkill(true);
    try {
      await useButlerSkills.getState().upsertSkill({
        name: cleanName,
        description: cleanName,
        category: 'general',
        instructionsMd: entry.text.trim(),
        workspaceRoot: workspaceRoot?.trim() || null,
      });
      setSkillSaveOpen(false);
      setSkillNameDraft('');
      toast.success(t('butler.skills.savedFromMessageToast', { name: cleanName }));
    } catch (error) {
      toast.error(error, t('butler.skills.saveFailed'));
    } finally {
      setSavingSkill(false);
    }
  };

  return (
    <article data-speaker={entry.role} className={`codex-native-message${streaming ? ' is-streaming' : ''}`}>
      <div className="codex-native-speaker flex flex-wrap items-center gap-1.5 mb-1.5 text-xs font-semibold text-ink-2">
        {isAssistant ? (
          <>
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Bot size={13} />
            </span>
            <span>{engineName}</span>
          </>
        ) : (
          <>
            <span>{t('butler.speaker.you')}</span>
            {parsedUser.isPlanMode ? (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-2xs font-medium text-primary">
                {t('agent.composer.planModeActiveBadge')}
              </span>
            ) : null}
            {parsedUser.recalledCount > 0 ? (
              <span
                title={parsedUser.recalledLines.join('\n')}
                className="inline-flex items-center gap-1 rounded-full bg-fill-2 px-2 py-0.5 text-2xs font-medium text-ink-3"
              >
                <Brain size={10} aria-hidden="true" />
                {t('butler.memoryRecall.userMessageBadge', { count: parsedUser.recalledCount })}
              </span>
            ) : null}
          </>
        )}
      </div>
      <div className="butler-conversation-markdown">
        {entry.text
          ? isAssistant
            ? progressive
              ? <StableStreamingMarkdown text={entry.text} renderLink={renderLink} />
              : renderMarkdownDoc(entry.text, undefined, renderLink)
            : parsedUser.cleanText
          : null}
        <CodexImageAttachments attachments={entry.attachments} />
        <CodexGeneratedImages images={entry.generatedImages} />
      </div>
      {isAssistant && !streaming && entry.text.trim() ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!skillSaveOpen ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const writer = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText(entry.text) : undefined;
                  if (writer) {
                    void writer.then(() => {
                      setCopiedReply(true);
                      setTimeout(() => setCopiedReply(false), 1500);
                    }).catch(() => {});
                  }
                }}
                className="inline-flex items-center gap-1 rounded-md border border-line-soft bg-surface-3 px-2 py-0.5 text-xs text-ink-3 transition hover:border-line hover:text-ink"
              >
                {copiedReply ? <Check size={11} className="text-success" /> : <Copy size={11} />}
                <span>{t(copiedReply ? 'common.copied' : 'common.copy')}</span>
              </button>
              <ShareToRoomButton
                compact
                payload={{
                  kind: 'reply',
                  messageId: entry.id,
                  text: entry.text,
                  workspaceRoot: workspaceRoot?.trim() || undefined,
                }}
              />
              <PullAiToChatButton
                compact
                source="butler"
                agentKind="pi_butler"
                agentId="pi_butler"
                agentName={t('chat.aiParticipant.piButlerName')}
                threadId={useCodexWorkspace.getState().activeThreadId ?? undefined}
                workspaceRoot={workspaceRoot?.trim() || undefined}
                summary={entry.text.slice(0, 240)}
              />
              <button
                type="button"
                onClick={() => {
                  setSkillNameDraft('');
                  setSkillSaveOpen(true);
                }}
                className="inline-flex items-center gap-1 rounded-md border border-line-soft bg-surface-3 px-2 py-0.5 text-xs text-ink-3 transition hover:border-primary/40 hover:text-primary"
              >
                <BookmarkPlus size={11} />
                <span>{t('butler.skills.saveFromMessage')}</span>
              </button>
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface-3 p-1.5 text-xs">
              <input
                type="text"
                autoFocus
                value={skillNameDraft}
                onChange={(e) => setSkillNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleSaveAsSkill();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setSkillSaveOpen(false);
                  }
                }}
                placeholder={t('butler.skills.saveFromMessagePlaceholder')}
                className="h-6 w-44 rounded border border-line bg-surface-2 px-2 text-xs text-ink outline-none focus:border-primary"
              />
              <button
                type="button"
                disabled={savingSkill || !skillNameDraft.trim()}
                onClick={() => void handleSaveAsSkill()}
                className="inline-flex h-6 items-center gap-1 rounded bg-primary px-2 text-xs font-medium text-white disabled:opacity-50"
              >
                <Check size={11} />
                <span>{t('common.save')}</span>
              </button>
              <button
                type="button"
                onClick={() => setSkillSaveOpen(false)}
                className="h-6 rounded px-1.5 text-xs text-ink-3 hover:text-ink"
              >
                {t('common.cancel')}
              </button>
            </div>
          )}
        </div>
      ) : null}
    </article>
  );
}

interface ComposerChoiceDescriptor {
  id: string;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
}

const PERMISSION_CHOICE_DESCRIPTORS: readonly ComposerChoiceDescriptor[] = [
  {
    id: 'ask',
    labelKey: 'butler.conversation.permission.askLabel',
    descriptionKey: 'butler.conversation.permission.askDesc',
  },
  {
    id: 'auto',
    labelKey: 'butler.conversation.permission.autoLabel',
    descriptionKey: 'butler.conversation.permission.autoDesc',
  },
  {
    id: 'full',
    labelKey: 'butler.conversation.permission.fullLabel',
    descriptionKey: 'butler.conversation.permission.fullDesc',
  },
];

const FOLLOW_UP_CHOICE_DESCRIPTORS: readonly ComposerChoiceDescriptor[] = [
  {
    id: 'steer',
    labelKey: 'butler.conversation.followUp.steerLabel',
    descriptionKey: 'butler.conversation.followUp.steerDesc',
  },
  {
    id: 'queue',
    labelKey: 'butler.conversation.followUp.queueLabel',
    descriptionKey: 'butler.conversation.followUp.queueDesc',
  },
];

const EFFORT_LABEL_KEYS: Record<string, MessageKey> = {
  low: 'butler.conversation.effort.low',
  medium: 'butler.conversation.effort.medium',
  high: 'butler.conversation.effort.high',
  xhigh: 'butler.conversation.effort.xhigh',
  minimal: 'butler.conversation.effort.minimal',
  ultra: 'butler.conversation.effort.ultra',
  none: 'butler.conversation.effort.off',
  off: 'butler.conversation.effort.off',
};

function effortLabel(effort: string, t: TranslateFn): string {
  const key = EFFORT_LABEL_KEYS[effort.toLowerCase()];
  return key ? t(key) : effort;
}

const MODERN_MODEL_SPECS: Record<string, { name: string; tagKey?: MessageKey }> = {
  'deepseek-v4-flash': { name: 'DeepSeek V4 Flash' },
  'deepseek/deepseek-v4-flash': { name: 'DeepSeek V4 Flash' },
  'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', tagKey: 'butler.conversation.modelTag.reasoning' },
  'deepseek/deepseek-v4-pro': { name: 'DeepSeek V4 Pro', tagKey: 'butler.conversation.modelTag.reasoning' },
  'deepseek-reasoner': { name: 'DeepSeek R1', tagKey: 'butler.conversation.modelTag.deepReasoning' },
  'deepseek/deepseek-reasoner': { name: 'DeepSeek R1', tagKey: 'butler.conversation.modelTag.deepReasoning' },
  'deepseek-r1': { name: 'DeepSeek R1', tagKey: 'butler.conversation.modelTag.deepReasoning' },
  'deepseek-chat': { name: 'DeepSeek V3' },
  'deepseek/deepseek-chat': { name: 'DeepSeek V3' },
  'claude-sonnet-5.5': { name: 'Claude Sonnet 5.5' },
  'anthropic/claude-sonnet-5.5': { name: 'Claude Sonnet 5.5' },
  'claude-opus-5.5': { name: 'Claude Opus 5.5' },
  'anthropic/claude-opus-5.5': { name: 'Claude Opus 5.5' },
  'claude-haiku-5.5': { name: 'Claude Haiku 5.5' },
  'anthropic/claude-haiku-5.5': { name: 'Claude Haiku 5.5' },
  'claude-3-7-sonnet-20250219': { name: 'Claude 3.7 Sonnet' },
  'anthropic/claude-3-7-sonnet-20250219': { name: 'Claude 3.7 Sonnet' },
  'claude-3-5-sonnet-20241022': { name: 'Claude 3.5 Sonnet' },
  'gpt-6.1-sol': { name: 'GPT-6.1 Sol', tagKey: 'butler.conversation.modelTag.engineeringCode' },
  'openai/gpt-6.1-sol': { name: 'GPT-6.1 Sol', tagKey: 'butler.conversation.modelTag.engineeringCode' },
  'gpt-6-astra': { name: 'GPT-6 Astra', tagKey: 'butler.conversation.modelTag.multiAgent' },
  'openai/gpt-6-astra': { name: 'GPT-6 Astra', tagKey: 'butler.conversation.modelTag.multiAgent' },
  'gpt-6-luna': { name: 'GPT-6 Luna', tagKey: 'butler.conversation.modelTag.fast' },
  'openai/gpt-6-luna': { name: 'GPT-6 Luna', tagKey: 'butler.conversation.modelTag.fast' },
  'o3-mini': { name: 'o3-mini', tagKey: 'butler.conversation.modelTag.fastReasoning' },
  'openai/o3-mini': { name: 'o3-mini', tagKey: 'butler.conversation.modelTag.fastReasoning' },
  'gemini-4-argon': { name: 'Gemini 4 Argon' },
  'google/gemini-4-argon': { name: 'Gemini 4 Argon' },
  'gemini-3.8-flash': { name: 'Gemini 3.8 Flash' },
  'google/gemini-3.8-flash': { name: 'Gemini 3.8 Flash' },
  'gemini-2.5-pro': { name: 'Gemini 2.5 Pro' },
  'google/gemini-2.5-pro': { name: 'Gemini 2.5 Pro' },
  'qwen3-coder': { name: 'Qwen 3 Coder', tagKey: 'butler.conversation.modelTag.localCoding' },
  'ollama/qwen3-coder': { name: 'Qwen 3 Coder', tagKey: 'butler.conversation.modelTag.localCoding' },
  'qwen3:8b': { name: 'Qwen 3 8B' },
  'qwen3.8-27b': { name: 'Qwen 3.8 27B' },
  'deepseek-r1:8b': { name: 'DeepSeek R1 8B' },
};

function formatModelLabel(id: string, t: TranslateFn, defaultName?: string): string {
  const stripped = id.replace(/^(deepseek|anthropic|openai|google|ollama)\//i, '');
  const spec = MODERN_MODEL_SPECS[id] ?? MODERN_MODEL_SPECS[stripped];
  if (spec) return spec.tagKey ? `${spec.name} (${t(spec.tagKey)})` : spec.name;
  if (defaultName && defaultName !== id) return defaultName;
  return stripped;
}

export default function ButlerConversation({ embedded = false, workBrief }: { embedded?: boolean; workBrief?: React.ReactNode }) {
  const { t, tp } = useI18n();
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const scope = useCodexWorkspace((state) => state.scope);
  const aiRuntimeProvider = useUI((state) => state.aiRuntimeProvider);
  const isPi = aiRuntimeProvider === 'pi';
  const engineName = 'Pi';
  const defaultWorkspaceRoot = useCodexWorkspace((state) => state.defaultWorkspaceRoot);
  const butlerWorkspaceRoot = useCodexWorkspace((state) => state.butlerWorkspaceRoot);
  const status = useCodexWorkspace((state) => state.status);
  const error = useCodexWorkspace((state) => state.error);
  const threads = useCodexWorkspace((state) => state.threads);
  const activeThreadId = useCodexWorkspace((state) => state.activeThreadId);
  const messages = useCodexWorkspace((state) => state.messages);
  const { streamingText, events } = useCodexStreamingView();
  const requests = useCodexWorkspace((state) => state.pendingRequests);
  const queuedMessages = useCodexWorkspace((state) => state.queuedMessages);
  const composerDraft = useCodexWorkspace((state) => state.composerDraft);
  const models = useCodexWorkspace((state) => state.models);
  const selectedModel = useCodexWorkspace((state) => state.selectedModel);
  const selectedEffort = useCodexWorkspace((state) => state.selectedEffort);
  const permissionPreset = useCodexWorkspace((state) => state.permissionPreset);
  const followUpMode = useCodexWorkspace((state) => state.followUpMode);
  const setWorkspaceRoot = useCodexWorkspace((state) => state.setWorkspaceRoot);
  const connect = useCodexWorkspace((state) => state.connect);
  const reconnectRuntime = useCodexWorkspace((state) => state.reconnectRuntime);
  const refreshFromCodex = useCodexWorkspace((state) => state.refreshFromCodex);
  const handoffToCodex = useCodexWorkspace((state) => state.handoffToCodex);
  const send = useCodexWorkspace((state) => state.send);
  const interrupt = useCodexWorkspace((state) => state.interrupt);
  const setModel = useCodexWorkspace((state) => state.setModel);
  const setEffort = useCodexWorkspace((state) => state.setEffort);
  const setPermissionPreset = useCodexWorkspace((state) => state.setPermissionPreset);
  const setFollowUpMode = useCodexWorkspace((state) => state.setFollowUpMode);
  const clearComposerDraft = useCodexWorkspace((state) => state.clearComposerDraft);
  const composerTarget = { kind: 'butler' as const, scope, workspaceRoot, recipientId: activeThreadId ?? null };
  const { key: composerKey, draft } = useAgentComposerDraft(composerTarget);
  const input = draft.text;
  const images = draft.images;
  const imageReadKeysRef = useRef(new Set<string>());
  const [imageReadKeys, setImageReadKeys] = useState(new Set<string>());
  const readingImages = imageReadKeys.has(composerKey);
  const setReadingImages = (reading: boolean) => {
    if (reading) imageReadKeysRef.current.add(composerKey);
    else imageReadKeysRef.current.delete(composerKey);
    setImageReadKeys(new Set(imageReadKeysRef.current));
  };
  const setInput = useCallback((text: string) => useAgentComposerDrafts.getState().edit(composerKey, { text }), [composerKey]);
  const setImages = useCallback((nextImages: CodexImageInput[]) => useAgentComposerDrafts.getState().edit(composerKey, { images: nextImages }), [composerKey]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<CodexArtifact | null>(null);
  const [artifactThreadId, setArtifactThreadId] = useState<string | null>(null);
  const [portalOpen, setPortalOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const memoryPaused = useButlerMemory((state) => state.memoryPaused);
  const cognitionInsights = useButlerCognition((state) => state.insights);
  const markInsightFeedback = useButlerCognition((state) => state.markInsightFeedback);
  const unreadProactiveInsights = useMemo(
    () => cognitionInsights.filter((item) => item.status === 'unread' && item.level !== 'silent_log'),
    [cognitionInsights],
  );
  const [recalledMemories, setRecalledMemories] = useState<ButlerMemoryEntry[]>([]);
  const [recalledExpanded, setRecalledExpanded] = useState(false);
  const [memoryCandidate, setMemoryCandidate] = useState<MemoryCandidate | null>(null);
  const [composerToken, setComposerToken] = useState<ActiveComposerToken | null>(null);
  const [pickerFiles, setPickerFiles] = useState<string[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [diffSummary, setDiffSummary] = useState<{ additions: number; deletions: number; files: number } | null>(null);
  const [voicePanelOpen, setVoicePanelOpen] = useState(false);
  const [portalTab, setPortalTab] = useState<PortalTab>('workcard');
  const setModule = useUI((state) => state.setModule);
  const setButlerView = useUI((state) => state.setButlerView);
  const butlerSidebarCollapsed = useUI((state) => state.butlerSidebarCollapsed);
  const toggleButlerSidebarCollapsed = useUI((state) => state.toggleButlerSidebarCollapsed);
  const ledgerCards = useWorkLedger((state) => state.cards);
  const ledgerSessions = useWorkLedger((state) => state.sessions);
  const ledgerLinks = useWorkLedger((state) => state.links);

  const linkedCard = useMemo(() => {
    return resolvePortalWorkContext({
      cards: ledgerCards, sessions: ledgerSessions, acpSessions: [], activeThreadId,
      activeWorkspaceRoot: workspaceRoot, currentRuntime: 'pi', selectedCardId: null,
    }).card;
  }, [activeThreadId, ledgerSessions, ledgerCards, workspaceRoot]);

  const linkedBranch = useMemo(() => {
    if (!linkedCard) return null;
    return ledgerLinks.find((l) => l.todoId === linkedCard.id && l.kind === 'git_branch')?.externalId ?? null;
  }, [linkedCard, ledgerLinks]);
  const [refreshingFromCodex, setRefreshingFromCodex] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyCloseRef = useRef<HTMLButtonElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoOpenedArtifactMessageRef = useRef<string>();
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const activeModel = models.find((model) =>
    model.model === selectedModel
    || model.id === selectedModel
    || (selectedModel && model.model.endsWith(`/${selectedModel}`))
    || (selectedModel && selectedModel.endsWith(`/${model.model}`))
  );
  const running = status === 'running' || status === 'waiting-input';
  const latestActivity = events.at(-1);
  const completedMessage = !running && messages.at(-1)?.role === 'assistant'
    ? messages.at(-1)
    : undefined;
  const visibleMessages = completedMessage ? messages.slice(0, -1) : messages;
  const activeAssistantMessage: CodexWorkspaceMessage | undefined = streamingText
    ? { id: 'active-assistant', role: 'assistant', text: streamingText, pending: true }
    : completedMessage;
  const activityStatus = running
    ? t('butler.conversation.status.working')
    : status === 'interrupted' || error === 'Pi 本轮已中断' || error === 'Codex 本轮已中断' || error === t('butler.conversation.interruptedTitle')
      ? t('butler.conversation.status.interrupted')
      : events.some((event) => event.status === 'failed')
        ? t('butler.conversation.status.incomplete')
        : t('butler.conversation.status.completed');
  const desktopRuntime = isTauriRuntime();
  let hasSavedPiConfig = false;
  try { hasSavedPiConfig = localStorage.getItem(PI_CONFIGURED_STORAGE_KEY) === '1'; } catch { /* Storage may be unavailable. */ }
  const canCompose = desktopRuntime
    && Boolean(workspaceRoot)
    && !['idle', 'connecting', 'interrupted', 'external', 'unavailable'].includes(status);
  const refreshLabel = status === 'external' ? t('butler.conversation.continueInRocketX') : t('butler.conversation.syncSession');
  const composerPlaceholder = status === 'external'
    ? t('butler.conversation.placeholderExternal')
    : running
      ? t(followUpMode === 'steer' ? 'butler.conversation.placeholderSteer' : 'butler.conversation.placeholderQueue')
      : activeThreadId ? t('butler.conversation.placeholderFollowUp') : t('butler.conversation.placeholderEmpty');
  const title = activeThread?.name?.trim() || activeThread?.preview.trim() || t('butler.conversation.newTaskTitle');
  const modelChoices = useMemo<ComposerChoice[]>(() => models.map((model) => ({
    id: model.model,
    label: formatModelLabel(model.model, t, model.displayName),
    description: model.description,
  })), [models, t]);
  const effortChoices = useMemo<ComposerChoice[]>(() => (
    activeModel?.supportedReasoningEfforts.map((effort) => ({
      id: effort.reasoningEffort,
      label: effortLabel(effort.reasoningEffort, t),
      description: effort.description,
    })) ?? []
  ), [activeModel, t]);
  const permissionChoices = useMemo<ComposerChoice[]>(() => PERMISSION_CHOICE_DESCRIPTORS.map((choice) => ({
    id: choice.id,
    label: t(choice.labelKey),
    description: t(choice.descriptionKey),
  })), [t]);
  const followUpChoices = useMemo<ComposerChoice[]>(() => FOLLOW_UP_CHOICE_DESCRIPTORS.map((choice) => ({
    id: choice.id,
    label: t(choice.labelKey),
    description: t(choice.descriptionKey),
  })), [t]);
  const permissionLabel = permissionChoices.find((choice) => choice.id === permissionPreset)?.label ?? t('butler.conversation.permissionFallback');

  const renderArtifactLink = useCallback<MarkdownLinkRenderer>((label, href) => {
    const artifact = codexArtifactFromLink(label, href, workspaceRoot);
    return artifact
      ? <CodexArtifactLink artifact={artifact} label={label} onOpen={(art) => {
          setSelectedArtifact(art);
          setArtifactThreadId(activeThreadId ?? null);
          setPortalTab('artifact');
          setPortalOpen(true);
        }} />
      : undefined;
  }, [activeThreadId, workspaceRoot]);



  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && (event.key === 'p' || event.key === 'P')) {
        event.preventDefault();
        setDiffOpen(false);
        setPortalOpen((current) => !current);
      } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'd' || event.key === 'D') && workspaceRoot) {
        event.preventDefault();
        setPortalOpen(false);
        setDiffOpen((current) => !current);
      } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'j' || event.key === 'J') && workspaceRoot && desktopRuntime) {
        event.preventDefault();
        setTerminalOpen((current) => !current);
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'n' || event.key === 'N') && workspaceRoot && desktopRuntime) {
        event.preventDefault();
        void openCodexNewThread('', workspaceRoot).catch(() => undefined);
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'w' || event.key === 'W') && workspaceRoot && desktopRuntime) {
        event.preventDefault();
        setPortalOpen(false);
        setDiffOpen(true);
      } else if ((event.ctrlKey || event.metaKey) && (event.key === 'b' || event.key === 'B')) {
        event.preventDefault();
        toggleButlerSidebarCollapsed();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [desktopRuntime, toggleButlerSidebarCollapsed, workspaceRoot]);

  useEffect(() => {
    if (composerToken?.kind !== 'file' || !desktopRuntime || !workspaceRoot?.trim()) {
      setPickerFiles([]);
      return;
    }
    let cancelled = false;
    setPickerLoading(true);
    void listWorkspaceFiles(workspaceRoot, composerToken.query, 40)
      .then((list) => {
        if (!cancelled) {
          setPickerFiles(list);
          setPickerIndex(0);
        }
      })
      .catch(() => {
        if (!cancelled) setPickerFiles([]);
      })
      .finally(() => {
        if (!cancelled) setPickerLoading(false);
      });
    return () => { cancelled = true; };
  }, [composerToken, desktopRuntime, workspaceRoot]);

  const butlerSkills = useButlerSkills((state) => state.skills);
  const hydrateSkills = useButlerSkills((state) => state.hydrate);
  useEffect(() => {
    void hydrateSkills();
  }, [hydrateSkills]);

  const rankedSlashCommands = useMemo<RankedSlashOption[]>(
    () => (composerToken?.kind === 'slash'
      ? rankSlashCommands(
          composerToken.query,
          t,
          butlerSkills
            .filter((item) => item.enabled)
            .map((item) => ({
              id: item.id,
              slug: item.slug,
              name: item.name,
              description: item.description,
              promptTemplate: buildSkillExecutionPrompt(item),
              category: item.category,
              runCount: item.runCount,
            })),
        )
      : []),
    [butlerSkills, composerToken, t],
  );

  useEffect(() => {
    if (composerToken?.kind === 'slash') {
      setPickerIndex(0);
    }
  }, [composerToken?.kind, composerToken?.query]);

  const refreshDiffSummary = useCallback(async () => {
    if (!isTauriRuntime() || !workspaceRoot?.trim()) {
      setDiffSummary(null);
      return;
    }
    try {
      const snap = await diffWorkspaceGit(workspaceRoot, null);
      setDiffSummary({
        additions: snap.totalAdditions,
        deletions: snap.totalDeletions,
        files: snap.files.length,
      });
    } catch {
      setDiffSummary(null);
    }
  }, [workspaceRoot]);

  useEffect(() => {
    if (!running) {
      void refreshDiffSummary();
    }
  }, [refreshDiffSummary, running, activeThreadId]);

  const closeHistory = useCallback((): void => {
    setHistoryOpen(false);
    requestAnimationFrame(() => historyButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!historyOpen) return;
    requestAnimationFrame(() => historyCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeHistory();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = historyPanelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary')]
        .filter((item) => item.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [closeHistory, historyOpen]);

  useEffect(() => {
    if (!composerDraft) return;
    setInput(composerDraft);
    clearComposerDraft();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [clearComposerDraft, composerDraft, setInput]);

  useEffect(() => {
    setSelectedArtifact(null);
    setArtifactThreadId(null);
    autoOpenedArtifactMessageRef.current = undefined;
  }, [activeThreadId, scope, workspaceRoot]);

  useEffect(() => {
    const latest = [...messages].reverse().find((entry) => entry.role === 'assistant' && entry.text);
    if (!latest || autoOpenedArtifactMessageRef.current === latest.id) return;
    autoOpenedArtifactMessageRef.current = latest.id;
    const artifacts = codexArtifactsFromMarkdown(latest.text, workspaceRoot);
    if (artifacts.length > 0) {
      setSelectedArtifact(artifacts.at(-1) ?? null);
      setArtifactThreadId(activeThreadId ?? null);
    }
  }, [activeThreadId, messages, workspaceRoot]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(180, Math.max(24, textarea.scrollHeight))}px`;
  }, [images, input]);

  const { scrollRef, onScroll, stickToBottom } = useStickToBottom([
    messages,
    streamingText,
    events,
    requests,
    queuedMessages,
  ], composerKey);

  const chooseWorkspace = async (): Promise<void> => {
    if (!isTauriRuntime()) throw new Error(t('butler.conversation.desktopOnlyChooseWorkspace'));
    const path = await openDesktopDialog({ directory: true, multiple: false, title: t('butler.chooseWorkspaceTitle') });
    if (typeof path !== 'string') return;
    await setWorkspaceRoot(path);
    await connect();
  };

  const dispatchRequest = async (request: AgentComposerRequest): Promise<void> => {
    let requestKey = composerKey;
    let submitted = false;
    stickToBottom.current = true;
    useButlerCognition.getState().recordUserActivity(Date.now(), 'butler');
    try {
      await send(request.text, request.images, request.options.mode, {
        threadId: request.target.recipientId ?? undefined,
        workspaceRoot: request.target.workspaceRoot,
        scope: request.target.scope,
        onSubmitted: () => { submitted = true; },
        onThreadCreated: (threadId) => {
          requestKey = useAgentComposerDrafts.getState().bindRecipient(requestKey, request.id, threadId);
        },
      });
      useAgentComposerDrafts.getState().finish(requestKey, request.id);
      if (!useButlerMemory.getState().memoryPaused) {
        const cleanUserText = request.text.replace(/^<recalled_memory>[\s\S]*?<\/recalled_memory>\s*/u, '');
        const candidates = extractMemoryCandidates(
          cleanUserText,
          '',
          useButlerMemory.getState().memories,
        );
        setMemoryCandidate(candidates[0] ?? null);
      }
    } catch (reason) {
      useAgentComposerDrafts.getState().finish(requestKey, request.id, reason, submitted);
    }
  };

  const submit = async (text = input, modeOverride?: CodexFollowUpMode): Promise<void> => {
    if (!canCompose || imageReadKeysRef.current.has(composerKey)) return;
    const prefix = t('agent.composer.planModePrefix');
    const plannedText = planMode && text.trim() && !text.includes(prefix)
      ? `${prefix}\n\n${text}`
      : text;
    const recall = await recallForPrompt(plannedText, workspaceRoot);
    setRecalledMemories(recall.memories);
    setRecalledExpanded(false);
    const finalText = recall.promptBlock
      ? `${recall.promptBlock}\n\n${plannedText}`
      : plannedText;
    const request = useAgentComposerDrafts.getState().begin(composerTarget, { mode: modeOverride }, finalText);
    if (request) {
      setComposerToken(null);
      await dispatchRequest(request);
    }
  };

  const applyFileSelection = (filePath: string) => {
    if (!composerToken || composerToken.kind !== 'file') return;
    const { nextText, nextCursor } = applyComposerReplacement(input, composerToken, `@${filePath}`);
    setInput(nextText);
    setComposerToken(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const applySlashSelection = (option: RankedSlashOption) => {
    if (!composerToken || composerToken.kind !== 'slash') return;
    setComposerToken(null);
    if (option.kind === 'action') {
      const stripped = `${input.slice(0, composerToken.start)}${input.slice(composerToken.end)}`.trim();
      setInput(stripped);
      if (option.id === 'plan') {
        setPlanMode((prev) => !prev);
      } else if (option.id === 'pulse') {
        void useButlerCognition.getState().runAmbientTurn('manual').then((res) => {
          toast.info(res.ran ? t('butler.cognition.pulseDoneToast') : t('butler.cognition.pulseSkippedToast'));
        }).catch((err) => toast.error(err, t('butler.cognition.pulseFailed')));
      } else if (option.id === 'dream') {
        void useButlerCognition.getState().runDreamNow(Date.now(), 'manual').then((entry) => {
          toast.success(t('butler.cognition.dreamDone', {
            merged: entry.memoriesConsolidated,
            skills: entry.skillsEvolved,
          }));
        }).catch((err) => toast.error(err, t('butler.cognition.dreamFailed')));
      } else if (option.id === 'diff' && workspaceRoot && desktopRuntime) {
        setPortalOpen(false);
        setDiffOpen(true);
      } else if (option.id === 'terminal' && workspaceRoot && desktopRuntime) {
        setTerminalOpen((prev) => !prev);
      } else if (option.id === 'checkpoint' && workspaceRoot && desktopRuntime) {
        void createGitCheckpoint(workspaceRoot, t('agent.diff.manualCheckpointLabel', {
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        }), activeThreadId ?? 'manual').then((cp) => {
          toast.success(t('agent.diff.toast.checkpointSaved', { label: cp.label }));
          void refreshDiffSummary();
        }).catch((err) => toast.error(err, t('agent.diff.actionFailed')));
      } else if (option.id === 'worktree' && workspaceRoot && desktopRuntime) {
        setPortalOpen(false);
        setDiffOpen(true);
      } else if (option.id === 'clear') {
        setInput('');
        setImages([]);
      }
      requestAnimationFrame(() => textareaRef.current?.focus());
      return;
    }
    if (option.kind === 'skill') {
      const skillId = option.id.replace(/^skill:/, '');
      void useButlerSkills.getState().recordSkillRun(skillId).catch(() => {});
    }
    const { nextText, nextCursor } = applyComposerReplacement(input, composerToken, option.template ?? `/${option.command}`);
    setInput(nextText);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(nextCursor, nextCursor);
    });
  };

  const retryRequest = (failed: AgentComposerRequest): void => {
    const request = useAgentComposerDrafts.getState().begin(composerTarget, undefined, undefined, failed.id);
    if (request) void dispatchRequest(request);
  };

  const openInCodex = async (): Promise<void> => {
    try {
      if (isPi && workspaceRoot) {
        await revealDesktopPath(workspaceRoot);
        return;
      }
      if (activeThreadId) {
        const result = await handoffToCodex();
        if (result === 'unavailable') {
          await refreshFromCodex().catch(() => undefined);
          throw new Error(t('butler.codexNoResponse'));
        }
        return;
      }
      const result = workspaceRoot ? await openCodexNewThread('', workspaceRoot) : 'unavailable';
      if (result === 'unavailable') throw new Error(t('butler.codexNoResponse'));
    } catch (reason) {
      toast.error(reason, t(isPi ? 'butler.conversation.openWorkspaceFailed' : 'butler.conversation.openCodexFailed'));
    }
  };

  const refreshCodexThread = async (): Promise<void> => {
    if (refreshingFromCodex) return;
    setRefreshingFromCodex(true);
    try {
      const previousThreadId = activeThreadId;
      const added = await refreshFromCodex();
      const current = useCodexWorkspace.getState();
      if (current.status === 'external') {
        toast.info(t('butler.conversation.refreshExternalToast'));
      } else if (previousThreadId && current.activeThreadId !== previousThreadId) {
        toast.success(added > 0
          ? tp(added, 'butler.conversation.refreshBranchedWithCountOne', 'butler.conversation.refreshBranchedWithCountOther')
          : t('butler.conversation.refreshBranched'));
        requestAnimationFrame(() => textareaRef.current?.focus());
      } else {
        toast.success(added > 0
          ? tp(added, 'butler.conversation.refreshSyncedWithCountOne', 'butler.conversation.refreshSyncedWithCountOther')
          : t('butler.conversation.refreshSynced'));
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    } catch (reason) {
      toast.error(reason, t('butler.conversation.refreshFailed'));
    } finally {
      setRefreshingFromCodex(false);
    }
  };

  const suggestions = useMemo(() => [
    {
      title: t('butler.conversation.suggestion.clarifyTitle'),
      description: t('butler.conversation.suggestion.clarifyDesc'),
      prompt: t('butler.conversation.suggestion.clarifyPrompt'),
    },
    {
      title: t('butler.conversation.suggestion.changesTitle'),
      description: t('butler.conversation.suggestion.changesDesc'),
      prompt: t('butler.conversation.suggestion.changesPrompt'),
    },
    {
      title: t('butler.conversation.suggestion.notesTitle'),
      description: t('butler.conversation.suggestion.notesDesc'),
      prompt: t('butler.conversation.suggestion.notesPrompt'),
    },
  ], [t]);

  return (
    <div className={`butler-conversation-layout codex-native-workspace${butlerSidebarCollapsed ? ' sidebar-collapsed' : ''}${portalOpen ? ' has-portal' : ''} ${embedded ? 'bg-transparent' : 'bg-surface'}`}>
      {!butlerSidebarCollapsed ? <ButlerConversationHistory /> : null}
      {historyOpen ? (
        <div className="butler-conversation-mobile-drawer">
          <button type="button" tabIndex={-1} aria-label={t('butler.page.closeTaskListAria')} className="butler-conversation-mobile-backdrop" onClick={closeHistory} />
          <div ref={historyPanelRef} role="dialog" aria-modal="true" aria-label={t('butler.page.taskList')} className="butler-conversation-mobile-panel">
            <button ref={historyCloseRef} type="button" aria-label={t('butler.page.closeTaskListAria')} className="butler-conversation-mobile-close" onClick={closeHistory}>
              <X size={17} aria-hidden="true" />
            </button>
            <div className="h-full">
              <ButlerConversationHistory onNavigate={closeHistory} />
            </div>
          </div>
        </div>
      ) : null}

      <section className="butler-conversation-pane" aria-label={t('butler.conversation.paneAria')}>
        <header className="butler-conversation-header work-first-conversation-header rcx-glass-header bg-surface-3">
          <div className="flex items-center gap-2 min-w-0">
            {butlerSidebarCollapsed ? (
              <button
                type="button"
                onClick={toggleButlerSidebarCollapsed}
                title={t('butler.sidebar.expandTitle')}
                aria-label={t('butler.sidebar.expandAria')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
              >
                <PanelLeft size={16} />
              </button>
            ) : null}
            <h2 className="text-sm font-semibold text-ink truncate">{title}</h2>
            {linkedCard ? (
              <button
                type="button"
                onClick={() => {
                  setPortalTab('workcard');
                  setPortalOpen(true);
                }}
                className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary-light px-2 py-0.5 text-2xs font-medium text-primary hover:bg-primary/20 transition-colors shrink-0"
                title={t('butler.conversation.linkedWorkTitle')}
              >
                <span>{t('butler.conversation.linkedWork')}</span>
              </button>
            ) : null}
          </div>
          <div className="butler-conversation-header-actions">
            {workspaceRoot && desktopRuntime ? (
              <>
                <button
                  type="button"
                  aria-pressed={terminalOpen}
                  title={t('agent.terminal.buttonTitle')}
                  onClick={() => setTerminalOpen((current) => !current)}
                  className="codex-native-open-app"
                >
                  <Terminal size={14} aria-hidden="true" />
                  <span>{t('agent.terminal.buttonLabel')}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={diffOpen}
                  title={t('agent.diff.buttonTitle')}
                  onClick={() => {
                    setDiffOpen((current) => {
                      const next = !current;
                      if (next) setPortalOpen(false);
                      return next;
                    });
                  }}
                  className="codex-native-open-app"
                >
                  <GitCompare size={14} aria-hidden="true" />
                  <span>{t('agent.diff.buttonLabel')}</span>
                  {diffSummary && diffSummary.files > 0 ? (
                    <span className="ml-1 font-mono text-xs">
                      <span className="text-success">+{diffSummary.additions}</span>
                      /
                      <span className="text-danger">-{diffSummary.deletions}</span>
                    </span>
                  ) : null}
                </button>
              </>
            ) : null}
            <button type="button" className="codex-native-open-app" onClick={() => setButlerView('kanban')}>{t('butler.conversation.workBoard')} <ArrowUpRight size={14} aria-hidden="true" /></button>
            <PullAiToChatButton
              compact
              source="butler"
              agentKind="pi_butler"
              agentId="pi_butler"
              agentName={t('chat.aiParticipant.piButlerName')}
              threadId={activeThreadId ?? undefined}
              workspaceRoot={workspaceRoot?.trim() || undefined}
            />
            <button
              ref={historyButtonRef}
              type="button"
              aria-label={t('butler.page.openTaskListAria')}
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen(true)}
              className="butler-conversation-mobile-switcher"
            >
              <PanelLeft size={15} aria-hidden="true" />
              {t('butler.conversation.tasksMobileLabel')}
            </button>
            {activeThreadId && status === 'external' ? (
              <button
                type="button"
                aria-label={refreshLabel}
                title={t(running ? 'butler.conversation.refreshDisabledTitle' : 'butler.conversation.refreshTitle')}
                disabled={!desktopRuntime || running || refreshingFromCodex}
                onClick={() => void refreshCodexThread()}
                className="codex-native-refresh"
              >
                {refreshingFromCodex
                  ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <RefreshCw size={14} aria-hidden="true" />}
                {refreshingFromCodex ? t('butler.conversation.refreshing') : refreshLabel}
              </button>
            ) : null}
            <details className="work-first-conversation-actions">
              <summary aria-label={t('butler.conversation.moreActionsAria')}><MoreHorizontal size={16} aria-hidden="true" /></summary>
              <div>
              {workspaceRoot ? <p title={workspaceRoot}>{workspaceRoot === defaultWorkspaceRoot || workspaceRoot === butlerWorkspaceRoot ? t('butler.workspace.butlerSession') : workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)}</p> : null}
              {linkedBranch ? <p title={linkedBranch}><GitBranch size={12} aria-hidden="true" />{linkedBranch}</p> : null}
              {activeThreadId && status !== 'external' ? (
                <button
                  type="button"
                  disabled={!desktopRuntime || running || refreshingFromCodex}
                  onClick={() => void refreshCodexThread()}
                  className="codex-native-open-app"
                >
                  <RefreshCw size={14} aria-hidden="true" />{refreshLabel}
                </button>
              ) : null}
            <button
              type="button"
              disabled={!desktopRuntime || running || status === 'connecting' || (!isPi && status === 'external')}
              onClick={() => void openInCodex()}
              className="codex-native-open-app"
            >
              <ArrowUpRight size={14} aria-hidden="true" />
              {isPi ? t('butler.conversation.openFolder') : t(status === 'external' ? 'butler.conversation.handedToCodex' : 'butler.conversation.openInCodex')}
            </button>
              </div>
            </details>
            <button
              type="button"
              aria-label={t(portalOpen ? 'butler.conversation.collapsePortalAria' : 'butler.conversation.openPortalAria')}
              aria-pressed={portalOpen}
              onClick={() => setPortalOpen((current) => !current)}
              className="codex-native-open-app"
            >
              <PanelRight size={14} aria-hidden="true" />
              {t('butler.conversation.detailsAndResults')}
            </button>
          </div>
        </header>

        {workBrief}
        <main ref={scrollRef} onScroll={onScroll} className="codex-native-transcript">
          {!desktopRuntime ? (
            <div className="codex-native-landing">
              <span><Bot size={24} aria-hidden="true" /></span>
              <h1>{t('butler.conversation.webLandingTitle')}</h1>
              <p>{t('butler.conversation.webLandingDesc')}</p>
            </div>
          ) : !workspaceRoot ? (
            <div className="codex-native-landing">
              <span><FolderOpen size={24} aria-hidden="true" /></span>
              <h1>{t('butler.conversation.chooseWorkspaceTitle')}</h1>
              <p>{t('butler.conversation.chooseWorkspaceDesc')}</p>
              <button type="button" onClick={() => void chooseWorkspace().catch((reason) => toast.error(reason, t('butler.conversation.openWorkspaceToastError')))}>
                <FolderOpen size={15} aria-hidden="true" />
                {t('butler.conversation.chooseFolder')}
              </button>
            </div>
          ) : status === 'idle' && messages.length === 0 ? (
            <div className="codex-native-landing">
              <h1>{t('butler.conversation.idleTitle', { engineName })}</h1>
              <p>{t('butler.conversation.idleDesc')}</p>
              <button type="button" onClick={() => void connect().catch((reason) => toast.error(reason, t('butler.conversation.connectFailed')))}>{t('butler.conversation.connectExecutor')}</button>
            </div>
          ) : status === 'connecting' && messages.length === 0 ? (
            <div className="codex-native-landing">
              <Loader2 size={24} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <h1>{t('butler.conversation.connectingTitle', { engineName })}</h1>
              <p>{t('butler.conversation.connectingDesc')}</p>
              <button type="button" onClick={() => void reconnectRuntime().catch((reason) => toast.error(reason, t('butler.conversation.reconnectFailed')))}>{t('butler.conversation.reconnect')}</button>
            </div>
          ) : status === 'unavailable' && messages.length === 0 ? (
            <div className="flex h-full items-start justify-center overflow-y-auto p-6">
              <div className="w-full max-w-xl space-y-4">
                <section className="space-y-3 rounded-xl border border-line bg-surface-4 p-4">
                  <h1 className="font-semibold text-ink">{t('butler.conversation.unavailableTitle', { engineName })}</h1>
                  <p role="alert" className="whitespace-pre-wrap break-words text-sm text-ink-2">{error || t('butler.conversation.unavailableDesc')}</p>
                  <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-white" onClick={() => void reconnectRuntime().catch((reason) => toast.error(reason, t('butler.conversation.reconnectFailed')))}>{t('butler.conversation.retrySavedConfig')}</button>
                </section>
                {hasSavedPiConfig ? <details className="rounded-xl border border-line p-3">
                  <summary className="cursor-pointer text-sm text-ink-2">{t('butler.conversation.editModelConfig')}</summary>
                  <div className="mt-3"><PiQuickOnboardingCard /></div>
                </details> : <PiQuickOnboardingCard />}
              </div>
            </div>
          ) : messages.length === 0 && !running && status !== 'external' && status !== 'interrupted' ? (
            <div className="codex-native-landing work-first-welcome">
              <span><Bot size={22} aria-hidden="true" /></span>
              <h1>{t('butler.conversation.welcomeHeading')}</h1>
              <div className="codex-native-suggestions work-first-suggestions">
                {suggestions.map((suggestion) => (
                  <button key={suggestion.title} type="button" disabled={!canCompose || !draft.loaded || Boolean(draft.pending)} onClick={() => {
                    setInput(input.trim() ? `${input}\n${suggestion.prompt}` : suggestion.prompt);
                    textareaRef.current?.focus();
                  }}>
                    <span className="font-medium text-ink block mb-0.5">{suggestion.title}</span>
                    <span className="text-xs text-ink-3 block">{suggestion.description}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="codex-native-transcript-inner space-y-4 py-6">
              {status === 'connecting' || status === 'idle' || status === 'unavailable' ? (
                <div role={status === 'unavailable' ? 'alert' : 'status'} className="rounded-lg border border-line bg-surface-2 p-3 text-xs text-ink-2">
                  {t(status === 'connecting' ? 'butler.conversation.bannerConnecting' : 'butler.conversation.bannerDisconnected')}
                  {status !== 'connecting' ? <button type="button" className="ml-2 text-primary hover:underline" onClick={() => void connect().catch((reason) => toast.error(reason, t('butler.conversation.reconnectFailed')))}>{t('butler.conversation.reconnectExecutor')}</button> : null}
                </div>
              ) : null}
              {status === 'interrupted' ? (
                <section className="codex-native-interruption" role="alert" aria-label={t('butler.conversation.interruptedAria')}>
                  <div>
                    <h2>{t('butler.conversation.interruptedTitle')}</h2>
                    <p>{error || t('butler.conversation.interruptedDesc')}</p>
                  </div>
                  <button
                    type="button"
                    disabled={refreshingFromCodex}
                    onClick={() => void refreshCodexThread()}
                  >
                    {refreshingFromCodex
                      ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : <RefreshCw size={14} aria-hidden="true" />}
                    {refreshingFromCodex ? t('butler.conversation.refreshing') : refreshLabel}
                  </button>
                </section>
              ) : null}
              {status === 'external' ? (
                <section className="codex-native-interruption is-external" aria-label={t('butler.conversation.externalAria')}>
                  <div>
                    <h2>{t('butler.conversation.externalTitle')}</h2>
                    <p>{t('butler.conversation.externalDesc')}</p>
                  </div>
                  <button
                    type="button"
                    disabled={refreshingFromCodex}
                    onClick={() => void refreshCodexThread()}
                  >
                    {refreshingFromCodex
                      ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : <RefreshCw size={14} aria-hidden="true" />}
                    {refreshingFromCodex ? t('butler.conversation.refreshing') : refreshLabel}
                  </button>
                </section>
              ) : null}
              {visibleMessages.map((entry) => <ConversationMessage key={entry.id} entry={entry} renderLink={renderArtifactLink} />)}

              {events
                .map((event) => parseDelegationEvent(event))
                .filter((item): item is ParsedDelegationEvent => item !== null)
                .map((delegation) => (
                  <DelegationTreeCard key={`del-${delegation.eventId}`} delegation={delegation} />
                ))}

              {events.length > 0 ? (
                <details className="codex-native-activities" aria-label={t('butler.conversation.activityAria')}>
                  <summary>
                    <span>{activityStatus}</span>
                    <small className="codex-native-activity-latest">{latestActivity?.title}</small>
                    <small className="codex-native-activity-count">{tp(events.length, 'butler.conversation.activityCountOne', 'butler.conversation.activityCountOther')}</small>
                    <ChevronDown size={13} aria-hidden="true" />
                  </summary>
                  <div>
                    {events.map((event) => <Activity key={event.id} event={event} />)}
                  </div>
                </details>
              ) : null}

              {requests.map((request) => request.kind === 'approval'
                ? <ApprovalCard key={request.id} request={request} />
                : <InputCard key={request.id} request={request} />)}

              {activeAssistantMessage ? (
                <ConversationMessage
                  key="active-assistant"
                  entry={activeAssistantMessage}
                  renderLink={renderArtifactLink}
                  progressive
                  streaming={Boolean(streamingText)}
                />
              ) : null}

              {queuedMessages.length > 0 ? (
                <div className="codex-native-queue">
                  <strong>{t('butler.conversation.queuedCount', { count: queuedMessages.length })}</strong>
                  {queuedMessages.map((entry) => (
                    <span key={entry.id}>{entry.text || tp(entry.images.length, 'butler.conversation.imageCountOne', 'butler.conversation.imageCountOther')}</span>
                  ))}
                </div>
              ) : null}
              {error && status !== 'interrupted'
                ? <div className="codex-native-inline-error" role="alert">{error}</div>
                : null}
            </div>
          )}
        </main>

        {terminalOpen && workspaceRoot && desktopRuntime ? (
          <ButlerTerminalDrawer
            workspaceRoot={workspaceRoot}
            open={terminalOpen}
            onClose={() => setTerminalOpen(false)}
          />
        ) : null}
        <footer className="butler-conversation-footer codex-native-footer">
          <div
            className="codex-native-composer work-first-composer"
            onDragOver={(event) => {
              if (!canCompose) return;
              if (hasChatToButlerDrag(event.dataTransfer) || event.dataTransfer.types.includes('Files')) {
                event.preventDefault();
              }
            }}
            onDrop={(event) => {
              if (!canCompose) return;
              const chatPayload = readChatToButlerDrag(event.dataTransfer);
              if (chatPayload) {
                event.preventDefault();
                const quote = formatChatMessagesForButlerPrompt(chatPayload);
                setInput(input.trimEnd() ? `${input.trimEnd()}\n\n${quote}` : quote);
                return;
              }
              const dropped = Array.from(event.dataTransfer.files);
              if (!dropped.length) return;
              event.preventDefault();
              const imgFiles = dropped.filter((f) => f.type.startsWith('image/'));
              const otherFiles = dropped.filter((f) => !f.type.startsWith('image/'));
              if (imgFiles.length > 0 && !imageReadKeysRef.current.has(composerKey)) {
                setReadingImages(true);
                void appendCodexImages(images, imgFiles)
                  .then((nextImages) => setImages(nextImages))
                  .catch((err) => toast.error(err))
                  .finally(() => setReadingImages(false));
              }
              if (otherFiles.length > 0) {
                const refs = otherFiles.map((f) => `@${f.name}`).join(' ');
                setInput(input.trimEnd() ? `${input.trimEnd()} ${refs} ` : `${refs} `);
              }
            }}
          >
            <div className="work-first-composer-target" id="butler-composer-target">
              <Bot size={13} aria-hidden="true" />
              <span>{t('butler.conversation.sendToButler')}</span>
              <span aria-hidden="true">·</span>
              <strong>{activeThreadId ? linkedCard?.title || title : t('butler.conversation.newTaskTitle')}</strong>
              {planMode ? (
                <span className="ml-2 rounded-full bg-primary/15 px-2 py-0.5 text-2xs font-medium text-primary">
                  {t('agent.composer.planModeActiveBadge')}
                </span>
              ) : null}
            </div>
            {recalledMemories.length > 0 && !memoryPaused ? (
              <div className="mb-1.5 rounded-lg border border-line-soft bg-surface-3 px-2.5 py-1.5 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setRecalledExpanded((prev) => !prev)}
                    className="inline-flex items-center gap-1.5 font-medium text-ink-2 hover:text-primary"
                  >
                    <Brain size={12} className="text-primary" aria-hidden="true" />
                    <span>{t('butler.memoryRecall.chip', { count: recalledMemories.length })}</span>
                    <ChevronDown
                      size={11}
                      className={`transition-transform ${recalledExpanded ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                  </button>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => useUI.getState().setButlerView('assistant')}
                      className="rounded border border-line bg-surface-4 px-1.5 py-0.5 text-xs text-ink-3 hover:text-ink"
                    >
                      {t('butler.memoryRecall.openVault')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        useButlerMemory.getState().setMemoryPaused(true);
                        setRecalledMemories([]);
                        toast.info(t('butler.assistant.memoryPausedToast'));
                      }}
                      className="inline-flex items-center gap-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-xs text-warning"
                    >
                      <PauseCircle size={11} />
                      <span>{t('butler.memoryRecall.pause')}</span>
                    </button>
                  </div>
                </div>
                {recalledExpanded ? (
                  <ul className="mt-1.5 space-y-1 border-t border-line-soft pt-1.5">
                    {recalledMemories.map((mem) => (
                      <li key={mem.id} className="flex items-center justify-between gap-2 rounded bg-surface-4 px-2 py-1">
                        <div className="min-w-0 flex-1">
                          <span className="font-medium text-ink">{mem.title}</span>
                          <span className="ml-1.5 text-ink-3">{mem.content}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              void useButlerMemory.getState().togglePin(mem.id).then(() => {
                                setRecalledMemories((prev) => prev.map((m) => (m.id === mem.id ? { ...m, pinned: !m.pinned } : m)));
                              });
                            }}
                            title={mem.pinned ? t('butler.memoryRecall.unpin') : t('butler.memoryRecall.pin')}
                            className={`rounded p-1 ${mem.pinned ? 'text-warning' : 'text-ink-3 hover:text-ink'}`}
                          >
                            <Pin size={11} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              void useButlerMemory.getState().deleteMemory(mem.id).then(() => {
                                setRecalledMemories((prev) => prev.filter((m) => m.id !== mem.id));
                                toast.info(t('butler.memoryRecall.forgottenToast'));
                              });
                            }}
                            title={t('butler.memoryRecall.forget')}
                            className="rounded p-1 text-ink-3 hover:bg-danger/10 hover:text-danger"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
            {memoryCandidate && !memoryPaused ? (
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Brain size={12} className="shrink-0 text-primary" aria-hidden="true" />
                  <span className="font-medium text-ink">{t('butler.memoryRecall.candidatePrompt')}</span>
                  <span className="truncate text-ink-2">{memoryCandidate.content}</span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      const candidate = memoryCandidate;
                      setMemoryCandidate(null);
                      void useButlerMemory.getState().upsertMemory({
                        category: candidate.category,
                        title: candidate.title,
                        content: candidate.content,
                        tags: candidate.tags,
                        workspaceRoot: workspaceRoot?.trim() || null,
                        sourceKind: 'conversation',
                        enabled: true,
                      }).then(() => {
                        toast.success(t('butler.assistant.memorySaved'));
                      }).catch((err) => toast.error(err, t('butler.assistant.memorySaveFailed')));
                    }}
                    className="rounded bg-primary px-2 py-0.5 text-xs font-medium text-white hover:bg-primary-hover"
                  >
                    {t('butler.memoryRecall.saveCandidate')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMemoryCandidate(null)}
                    className="rounded px-1.5 py-0.5 text-xs text-ink-3 hover:text-ink"
                  >
                    {t('butler.memoryRecall.dismissCandidate')}
                  </button>
                </div>
              </div>
            ) : null}
            {unreadProactiveInsights.length > 0 ? (() => {
              const topInsight = unreadProactiveInsights[0];
              const topPayload = {
                kind: 'insight' as const,
                id: topInsight.id,
                insightKind: topInsight.kind,
                title: topInsight.title,
                summary: topInsight.summary,
                suggestedActions: topInsight.suggestedActions?.map((a) => a.label),
                ref: topInsight.ref,
              };
              return (
                <div
                  draggable
                  onDragStart={(e) => writeButlerShareDrag(e.dataTransfer, topPayload)}
                  className="mb-1.5 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-xs"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <Sparkles size={12} className="shrink-0 text-primary" aria-hidden="true" />
                    <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 font-medium text-primary">
                      {t('butler.cognition.conversationPillCount', { count: unreadProactiveInsights.length })}
                    </span>
                    <span className="truncate font-medium text-ink">{topInsight.title}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        markInsightFeedback(topInsight.id, 'acted');
                        const actionPrompt = topInsight.suggestedActions?.[0]?.prompt
                          ?? `${topInsight.title}\n\n${topInsight.summary}`;
                        useAgentComposerDrafts.getState().edit(composerKey, { text: actionPrompt });
                        textareaRef.current?.focus();
                      }}
                      className="rounded bg-primary px-2 py-0.5 text-xs font-medium text-white hover:bg-primary-hover"
                    >
                      {t('butler.cognition.handleInButler')}
                    </button>
                    <ShareToRoomButton compact payload={topPayload} />
                    <button
                      type="button"
                      onClick={() => useUI.getState().openButlerAssistant('cognition')}
                      className="rounded border border-line bg-surface-4 px-1.5 py-0.5 text-xs text-ink-2 hover:text-ink"
                    >
                      {t('butler.cognition.viewAllInsights')}
                    </button>
                    <button
                      type="button"
                      onClick={() => markInsightFeedback(topInsight.id, 'dismissed')}
                      className="rounded px-1.5 py-0.5 text-xs text-ink-3 hover:text-ink"
                    >
                      {t('butler.memoryRecall.dismissCandidate')}
                    </button>
                  </div>
                </div>
              );
            })() : null}
            <ButlerComposerFilePopover
              open={composerToken?.kind === 'file'}
              loading={pickerLoading}
              files={pickerFiles}
              activeIndex={pickerIndex}
              onSelect={applyFileSelection}
            />
            <ButlerComposerSlashPopover
              open={composerToken?.kind === 'slash'}
              commands={rankedSlashCommands}
              activeIndex={pickerIndex}
              onSelect={applySlashSelection}
            />
            <AgentComposerFeedback draft={draft} onRetry={retryRequest} />
            {readingImages ? <p role="status" className="text-xs text-ink-3">{t('butler.conversation.readingImagesNotice')}</p> : null}
            {status === 'external' ? (
              <div id="codex-external-composer-notice" className="codex-native-composer-notice" role="status">
                <CircleAlert size={14} aria-hidden="true" />
                <span>{t('butler.conversation.externalComposerNotice')}</span>
              </div>
            ) : null}
            <fieldset disabled={readingImages} className="m-0 border-0 p-0"><CodexImagePreviews images={images} onChange={setImages} /></fieldset>
            <textarea
              ref={textareaRef}
              data-work-composer="pi"
              data-work-session-id={activeThreadId ?? ''}
              value={input}
              onChange={(event) => {
                const value = event.target.value;
                const pos = event.target.selectionStart ?? value.length;
                setInput(value);
                setComposerToken(detectComposerTrigger(value, pos));
              }}
              onPaste={(event) => {
                if (imageReadKeysRef.current.has(composerKey) && event.clipboardData.files.length > 0) {
                  event.preventDefault();
                  return;
                }
                void pasteCodexImages(event, images, setImages, setReadingImages);
              }}
              onKeyDown={(event) => {
                if (composerToken) {
                  const listLen = composerToken.kind === 'file' ? pickerFiles.length : rankedSlashCommands.length;
                  if (event.key === 'ArrowDown' && listLen > 0) {
                    event.preventDefault();
                    setPickerIndex((i) => (i + 1) % listLen);
                    return;
                  }
                  if (event.key === 'ArrowUp' && listLen > 0) {
                    event.preventDefault();
                    setPickerIndex((i) => (i - 1 + listLen) % listLen);
                    return;
                  }
                  if ((event.key === 'Enter' || event.key === 'Tab') && listLen > 0 && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (composerToken.kind === 'file' && pickerFiles[pickerIndex]) {
                      applyFileSelection(pickerFiles[pickerIndex]);
                    } else if (composerToken.kind === 'slash' && rankedSlashCommands[pickerIndex]) {
                      applySlashSelection(rankedSlashCommands[pickerIndex]);
                    }
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setComposerToken(null);
                    return;
                  }
                }
                if (event.key === 'Escape' && running) {
                  event.preventDefault();
                  void interrupt();
                  return;
                }
                if (event.key !== 'Enter' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
                  event.preventDefault();
                  const opposite = followUpMode === 'steer' ? 'queue' : 'steer';
                  void submit(input, opposite);
                  return;
                }
                if (event.shiftKey) return;
                event.preventDefault();
                void submit();
              }}
              disabled={!canCompose}
              aria-label={t('butler.conversation.inputAria')}
              aria-describedby={`butler-composer-target${status === 'external' ? ' codex-external-composer-notice' : ''}`}
              placeholder={composerPlaceholder}
              rows={1}
            />
            <div className="codex-native-composer-bar">
              <div>
                <CodexImagePicker key={composerKey} images={images} onChange={setImages} disabled={!canCompose || readingImages} onReadingChange={setReadingImages} />
                <button
                  type="button"
                  aria-pressed={planMode}
                  title={t('agent.composer.planModeTitle')}
                  disabled={!canCompose}
                  onClick={() => setPlanMode((prev) => !prev)}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition ${
                    planMode
                      ? 'border-primary bg-primary/15 text-primary font-medium'
                      : 'border-line bg-surface-2 text-ink-3 hover:text-ink'
                  }`}
                >
                  <span>{t('agent.composer.planModeLabel')}</span>
                </button>
                <details className="work-first-composer-settings">
                  <summary><Settings size={14} aria-hidden="true" />{t('butler.conversation.chatSettings')}</summary>
                  <div className="work-first-composer-settings-content">
                <ComposerMenu
                  ariaLabel={t('butler.conversation.modelAria')}
                  label={formatModelLabel(selectedModel, t, activeModel?.displayName ?? (selectedModel || t('butler.conversation.modelAria')))}
                  value={selectedModel}
                  choices={modelChoices}
                  disabled={!canCompose}
                  onChange={(model) => void setModel(model).catch((reason) => toast.error(reason))}
                  footerAction={{
                    label: t('butler.conversation.configureModelAndKey'),
                    icon: <Settings size={13} aria-hidden="true" />,
                    onClick: () => setModule('settings'),
                  }}
                />
                {activeModel && activeModel.supportedReasoningEfforts && activeModel.supportedReasoningEfforts.length > 0 ? (
                  <ComposerMenu
                    ariaLabel={t('butler.conversation.reasoningAria')}
                    label={selectedEffort ? t('butler.conversation.thinkingWithValue', { value: effortLabel(selectedEffort, t) }) : t('butler.conversation.thinking')}
                    value={selectedEffort ?? ''}
                    choices={effortChoices}
                    disabled={!canCompose}
                    onChange={(effort) => void setEffort(effort || null).catch((reason) => toast.error(reason))}
                  />
                ) : null}
                <ComposerMenu
                  ariaLabel={t('butler.conversation.permissionAria')}
                  label={permissionLabel}
                  value={permissionPreset}
                  choices={permissionChoices}
                  disabled={!canCompose}
                  onChange={(preset) => void setPermissionPreset(preset as 'ask' | 'auto' | 'full').catch((reason) => toast.error(reason))}
                />
                  </div>
                </details>
                <details className="work-first-composer-voice" onToggle={(event) => setVoicePanelOpen(event.currentTarget.open)}>
                  <summary><Mic size={14} aria-hidden="true" /><span>{t('butler.conversation.voice')}</span></summary>
                  <div>
                    {voicePanelOpen && <LocalVoiceControls
                      targetKey={composerKey}
                      disabled={!canCompose || !draft.loaded || readingImages}
                      replyText={[...messages].reverse().find((message) => message.role === 'assistant' && !message.pending)?.text ?? ''}
                      onTranscript={(text) => {
                        const current = useAgentComposerDrafts.getState().drafts[composerKey]?.text ?? '';
                        useAgentComposerDrafts.getState().edit(composerKey, { text: [current, text].filter(Boolean).join('\n') });
                      }}
                    />}
                  </div>
                </details>
                {running ? (
                  <ComposerMenu
                    ariaLabel={t('butler.conversation.followUpModeAria')}
                    label={t(followUpMode === 'steer' ? 'butler.conversation.followUp.steerLabel' : 'butler.conversation.followUp.queueLabel')}
                    value={followUpMode}
                    choices={followUpChoices}
                    onChange={(mode) => setFollowUpMode(mode as CodexFollowUpMode)}
                  />
                ) : null}
              </div>
              <div>
                {running ? (
                  <button type="button" aria-label={t('butler.conversation.stopTaskAria')} className="codex-native-stop" onClick={() => void interrupt()}>
                    <Square size={13} fill="currentColor" aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={t(running ? 'butler.conversation.sendFollowUpAria' : 'butler.conversation.sendAria')}
                  title={t(running ? 'butler.conversation.sendFollowUpTitle' : 'butler.conversation.sendTitle')}
                  disabled={!canCompose || !draft.loaded || readingImages || Boolean(draft.pending) || (!input.trim() && images.length === 0)}
                  onClick={() => void submit()}
                >
                  <Send size={14} aria-hidden="true" />
                  <span>{t(running ? (followUpMode === 'steer' ? 'butler.conversation.followUp.steerLabel' : 'butler.conversation.sendFollowUpQueue') : 'butler.conversation.sendButton')}</span>
                </button>
              </div>
            </div>
          </div>
        </footer>
      </section>
      {diffOpen && workspaceRoot ? (
        <WorkDiffDrawer
          workspaceRoot={workspaceRoot}
          open={diffOpen}
          onClose={() => setDiffOpen(false)}
          defaultBranchName={linkedBranch ?? undefined}
          onWorkspaceChanged={() => void refreshDiffSummary()}
          onOpenWorktree={(worktreePath) => {
            void setWorkspaceRoot(worktreePath).then(() => connect()).catch((reason) => toast.error(reason));
          }}
        />
      ) : portalOpen ? (
        <ButlerWorkPortalDock
          onClose={() => {
            setPortalOpen(false);
            setSelectedArtifact(null);
          }}
          activeArtifact={selectedArtifact}
          activeThreadId={activeThreadId ?? null}
          artifactThreadId={artifactThreadId}
          activeWorkspaceRoot={workspaceRoot}
          currentRuntime="pi"
          onCloseArtifact={() => setSelectedArtifact(null)}
          events={events}
          initialTab={portalTab}
          onTabChange={setPortalTab}
        />
      ) : null}
    </div>
  );
}
