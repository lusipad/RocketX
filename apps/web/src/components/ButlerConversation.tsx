import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  FolderOpen,
  GitBranch,
  Loader2,
  Mic,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Send,
  Settings,
  Square,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openCodexNewThread } from '../agent/codexTransfer';
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
import { useStickToBottom } from '../lib/stickToBottom';
import { resolvePortalWorkContext } from '../lib/workContext';
import { useCodexStreamingView } from '../lib/useCodexStreamingText';
import type { CodexHostInput } from '../agent/codexHostInput';
import type { CodexImageInput } from '../lib/codexImages';
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
import { useWorkLedger } from '../stores/workLedger';
import ButlerConversationHistory from './ButlerConversationHistory';
import ButlerErrandInputCard from './ButlerErrandInputCard';
import ButlerWorkPortalDock, { type PortalTab } from './ButlerWorkPortalDock';
import { CodexArtifactLink } from './CodexArtifactPanel';
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
  const resolve = useCodexWorkspace((state) => state.resolveRequest);
  const decide = (action: 'accept' | 'accept-session' | 'decline'): void => {
    try {
      resolve(request.id, { action });
    } catch (reason) {
      toast.error(reason, '无法提交审批');
    }
  };
  return (
    <section className="codex-native-request" aria-label="Codex 请求审批">
      <header>
        <CircleAlert size={15} aria-hidden="true" />
        <strong>Codex 请求执行操作</strong>
      </header>
      <pre>{approvalSummary(request)}</pre>
      <footer>
        <button type="button" onClick={() => decide('decline')}>拒绝</button>
        <button type="button" onClick={() => decide('accept-session')}>本次任务允许</button>
        <button type="button" className="is-primary" onClick={() => decide('accept')}>允许一次</button>
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
      <div role="menu" aria-label={`${ariaLabel}选项`}>
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
  const isAssistant = entry.role === 'assistant';
  const engineName = 'Pi';
  return (
    <article data-speaker={entry.role} className={`codex-native-message${streaming ? ' is-streaming' : ''}`}>
      <div className="codex-native-speaker flex items-center gap-1.5 mb-1.5 text-xs font-semibold text-ink-2">
        {isAssistant ? (
          <>
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Bot size={13} />
            </span>
            <span>{engineName}</span>
          </>
        ) : (
          <span>你</span>
        )}
      </div>
      <div className="butler-conversation-markdown">
        {entry.text
          ? isAssistant
            ? progressive
              ? <StableStreamingMarkdown text={entry.text} renderLink={renderLink} />
              : renderMarkdownDoc(entry.text, undefined, renderLink)
            : entry.text
          : null}
        <CodexImageAttachments attachments={entry.attachments} />
        <CodexGeneratedImages images={entry.generatedImages} />
      </div>
    </article>
  );
}

const PERMISSION_CHOICES: readonly ComposerChoice[] = [
  {
    id: 'ask',
    label: '询问审批',
    description: '修改工作区外文件或使用网络时总是询问',
  },
  {
    id: 'auto',
    label: '替我审批',
    description: '只在检测到潜在危险时询问',
  },
  {
    id: 'full',
    label: '完全访问',
    description: '可访问网络与电脑上的任意文件',
  },
];

const FOLLOW_UP_CHOICES: readonly ComposerChoice[] = [
  { id: 'steer', label: '立即调整', description: '将消息加入当前任务' },
  { id: 'queue', label: '排队', description: '当前任务完成后发送' },
];

function effortLabel(effort: string): string {
  const map: Record<string, string> = {
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '超高',
    minimal: '极简',
    ultra: '极致',
    none: '关闭',
    off: '关闭',
  };
  return map[effort.toLowerCase()] ?? effort;
}

const MODERN_MODEL_LABELS: Record<string, string> = {
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro (推理)',
  'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro (推理)',
  'deepseek-reasoner': 'DeepSeek R1 (深度推理)',
  'deepseek/deepseek-reasoner': 'DeepSeek R1 (深度推理)',
  'deepseek-r1': 'DeepSeek R1 (深度推理)',
  'deepseek-chat': 'DeepSeek V3',
  'deepseek/deepseek-chat': 'DeepSeek V3',
  'claude-sonnet-5.5': 'Claude Sonnet 5.5',
  'anthropic/claude-sonnet-5.5': 'Claude Sonnet 5.5',
  'claude-opus-5.5': 'Claude Opus 5.5',
  'anthropic/claude-opus-5.5': 'Claude Opus 5.5',
  'claude-haiku-5.5': 'Claude Haiku 5.5',
  'anthropic/claude-haiku-5.5': 'Claude Haiku 5.5',
  'claude-3-7-sonnet-20250219': 'Claude 3.7 Sonnet',
  'anthropic/claude-3-7-sonnet-20250219': 'Claude 3.7 Sonnet',
  'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet',
  'gpt-6.1-sol': 'GPT-6.1 Sol (工程/代码)',
  'openai/gpt-6.1-sol': 'GPT-6.1 Sol (工程/代码)',
  'gpt-6-astra': 'GPT-6 Astra (多智能体)',
  'openai/gpt-6-astra': 'GPT-6 Astra (多智能体)',
  'gpt-6-luna': 'GPT-6 Luna (极速)',
  'openai/gpt-6-luna': 'GPT-6 Luna (极速)',
  'o3-mini': 'o3-mini (高速推理)',
  'openai/o3-mini': 'o3-mini (高速推理)',
  'gemini-4-argon': 'Gemini 4 Argon',
  'google/gemini-4-argon': 'Gemini 4 Argon',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'google/gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'google/gemini-2.5-pro': 'Gemini 2.5 Pro',
  'qwen3-coder': 'Qwen 3 Coder (本地编码)',
  'ollama/qwen3-coder': 'Qwen 3 Coder (本地编码)',
  'qwen3:8b': 'Qwen 3 8B',
  'qwen3.8-27b': 'Qwen 3.8 27B',
  'deepseek-r1:8b': 'DeepSeek R1 8B',
};

function formatModelLabel(id: string, defaultName?: string): string {
  if (MODERN_MODEL_LABELS[id]) return MODERN_MODEL_LABELS[id];
  const stripped = id.replace(/^(deepseek|anthropic|openai|google|ollama)\//i, '');
  if (MODERN_MODEL_LABELS[stripped]) return MODERN_MODEL_LABELS[stripped];
  if (defaultName && defaultName !== id) return defaultName;
  return stripped;
}

export default function ButlerConversation({ embedded = false, workBrief }: { embedded?: boolean; workBrief?: React.ReactNode }) {
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
    ? '正在工作'
    : status === 'interrupted' || error === 'Pi 本轮已中断' || error === 'Codex 本轮已中断'
      ? '已中断'
      : events.some((event) => event.status === 'failed')
        ? '未完成'
        : '已完成';
  const desktopRuntime = isTauriRuntime();
  let hasSavedPiConfig = false;
  try { hasSavedPiConfig = localStorage.getItem(PI_CONFIGURED_STORAGE_KEY) === '1'; } catch { /* Storage may be unavailable. */ }
  const canCompose = desktopRuntime
    && Boolean(workspaceRoot)
    && !['idle', 'connecting', 'interrupted', 'external', 'unavailable'].includes(status);
  const refreshLabel = status === 'external' ? '在 RocketX 继续' : '同步会话状态';
  const composerPlaceholder = status === 'external'
    ? '点击上方“在 RocketX 继续”'
    : running
      ? (followUpMode === 'steer' ? '输入指令，立即调整当前任务' : '输入后续消息，将在当前任务后执行')
      : activeThreadId ? '补充要求，或说说下一步想做什么…' : '告诉我你想完成什么，也可以粘贴资料或添加图片…';
  const title = activeThread?.name?.trim() || activeThread?.preview.trim() || '新事情';
  const modelChoices = useMemo<ComposerChoice[]>(() => models.map((model) => ({
    id: model.model,
    label: formatModelLabel(model.model, model.displayName),
    description: model.description,
  })), [models]);
  const effortChoices = useMemo<ComposerChoice[]>(() => (
    activeModel?.supportedReasoningEfforts.map((effort) => ({
      id: effort.reasoningEffort,
      label: effortLabel(effort.reasoningEffort),
      description: effort.description,
    })) ?? []
  ), [activeModel]);
  const permissionLabel = PERMISSION_CHOICES.find((choice) => choice.id === permissionPreset)?.label ?? '权限';

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
        setPortalOpen((current) => !current);
      } else if ((event.ctrlKey || event.metaKey) && (event.key === 'b' || event.key === 'B')) {
        event.preventDefault();
        toggleButlerSidebarCollapsed();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleButlerSidebarCollapsed]);

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
    if (!isTauriRuntime()) throw new Error('网页版没有本地 Pi 执行面，请使用 RocketX 桌面端');
    const path = await openDesktopDialog({ directory: true, multiple: false, title: '选择工作区' });
    if (typeof path !== 'string') return;
    await setWorkspaceRoot(path);
    await connect();
  };

  const dispatchRequest = async (request: AgentComposerRequest): Promise<void> => {
    let requestKey = composerKey;
    let submitted = false;
    stickToBottom.current = true;
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
    } catch (reason) {
      useAgentComposerDrafts.getState().finish(requestKey, request.id, reason, submitted);
    }
  };

  const submit = async (text = input, modeOverride?: CodexFollowUpMode): Promise<void> => {
    if (!canCompose || imageReadKeysRef.current.has(composerKey)) return;
    const request = useAgentComposerDrafts.getState().begin(composerTarget, { mode: modeOverride }, text);
    if (request) await dispatchRequest(request);
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
          throw new Error('Codex App 没有响应');
        }
        return;
      }
      const result = workspaceRoot ? await openCodexNewThread('', workspaceRoot) : 'unavailable';
      if (result === 'unavailable') throw new Error('Codex App 没有响应');
    } catch (reason) {
      toast.error(reason, isPi ? '无法打开工作区目录' : '无法打开 Codex App');
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
        toast.info('已同步最新内容，但当前 Codex Runtime 无法创建继续分支');
      } else if (previousThreadId && current.activeThreadId !== previousThreadId) {
        toast.success(added > 0
          ? `已同步 ${added} 个新步骤，并创建 RocketX 继续分支`
          : '已从最新内容创建 RocketX 继续分支');
        requestAnimationFrame(() => textareaRef.current?.focus());
      } else {
        toast.success(added > 0
          ? `已同步 ${added} 个新步骤`
          : '已同步并接回 RocketX');
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    } catch (reason) {
      toast.error(reason, '无法同步会话状态');
    } finally {
      setRefreshingFromCodex(false);
    }
  };

  const suggestions = useMemo(() => [
    { title: '梳理一件事', description: '从目标到下一步', prompt: '帮我梳理这件事的目标、已有信息和下一步：' },
    { title: '检查项目改动', description: '看清改了什么、哪里有问题', prompt: '检查当前项目的改动，说明已经完成什么、还有哪些问题需要处理。' },
    { title: '整理一份资料', description: '提炼重点，形成可用内容', prompt: '帮我整理下面的资料，提炼重点和需要跟进的事项：' },
  ], []);

  return (
    <div className={`butler-conversation-layout codex-native-workspace${butlerSidebarCollapsed ? ' sidebar-collapsed' : ''}${portalOpen ? ' has-portal' : ''} ${embedded ? 'bg-transparent' : 'bg-surface'}`}>
      {!butlerSidebarCollapsed ? <ButlerConversationHistory /> : null}
      {historyOpen ? (
        <div className="butler-conversation-mobile-drawer">
          <button type="button" tabIndex={-1} aria-label="关闭任务列表" className="butler-conversation-mobile-backdrop" onClick={closeHistory} />
          <div ref={historyPanelRef} role="dialog" aria-modal="true" aria-label="任务列表" className="butler-conversation-mobile-panel">
            <button ref={historyCloseRef} type="button" aria-label="关闭任务列表" className="butler-conversation-mobile-close" onClick={closeHistory}>
              <X size={17} aria-hidden="true" />
            </button>
            <div className="h-full">
              <ButlerConversationHistory onNavigate={closeHistory} />
            </div>
          </div>
        </div>
      ) : null}

      <section className="butler-conversation-pane" aria-label="Codex 任务">
        <header className="butler-conversation-header work-first-conversation-header rcx-glass-header bg-surface-3">
          <div className="flex items-center gap-2 min-w-0">
            {butlerSidebarCollapsed ? (
              <button
                type="button"
                onClick={toggleButlerSidebarCollapsed}
                title="展开会话列表 (Ctrl+B)"
                aria-label="展开会话列表"
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
                title="查看这件工作的详情与成果"
              >
                <span>关联工作</span>
              </button>
            ) : null}
          </div>
          <div className="butler-conversation-header-actions">
            <button type="button" className="codex-native-open-app" onClick={() => setButlerView('kanban')}>工作看板 <ArrowUpRight size={14} aria-hidden="true" /></button>
            <button
              ref={historyButtonRef}
              type="button"
              aria-label="打开任务列表"
              aria-expanded={historyOpen}
              onClick={() => setHistoryOpen(true)}
              className="butler-conversation-mobile-switcher"
            >
              <PanelLeft size={15} aria-hidden="true" />
              任务
            </button>
            {activeThreadId && status === 'external' ? (
              <button
                type="button"
                aria-label={refreshLabel}
                title={running
                  ? '任务运行中，完成后再刷新'
                  : '保留 Codex App 原任务，并从最新内容创建可编辑分支'}
                disabled={!desktopRuntime || running || refreshingFromCodex}
                onClick={() => void refreshCodexThread()}
                className="codex-native-refresh"
              >
                {refreshingFromCodex
                  ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <RefreshCw size={14} aria-hidden="true" />}
                {refreshingFromCodex ? '刷新中' : refreshLabel}
              </button>
            ) : null}
            <details className="work-first-conversation-actions">
              <summary aria-label="更多对话操作"><MoreHorizontal size={16} aria-hidden="true" /></summary>
              <div>
              {workspaceRoot ? <p title={workspaceRoot}>{workspaceRoot === defaultWorkspaceRoot || workspaceRoot === butlerWorkspaceRoot ? '管家会话' : workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)}</p> : null}
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
              {isPi ? '打开目录' : (status === 'external' ? '已交给 Codex' : '在 Codex 中打开')}
            </button>
              </div>
            </details>
            <button
              type="button"
              aria-label={portalOpen ? '收起任务工作台' : '打开任务工作台'}
              aria-pressed={portalOpen}
              onClick={() => setPortalOpen((current) => !current)}
              className="codex-native-open-app"
            >
              <PanelRight size={14} aria-hidden="true" />
              详情与成果
            </button>
          </div>
        </header>

        {workBrief}
        <main ref={scrollRef} onScroll={onScroll} className="codex-native-transcript">
          {!desktopRuntime ? (
            <div className="codex-native-landing">
              <span><Bot size={24} aria-hidden="true" /></span>
              <h1>在桌面端向管家交代事情</h1>
              <p>这里可以查看消息和已有工作。要处理本机文件、运行任务，请打开 RocketX 桌面端。</p>
            </div>
          ) : !workspaceRoot ? (
            <div className="codex-native-landing">
              <span><FolderOpen size={24} aria-hidden="true" /></span>
              <h1>先选择要处理的项目</h1>
              <p>选择文件夹后，管家才能查看和处理其中的文件。</p>
              <button type="button" onClick={() => void chooseWorkspace().catch((reason) => toast.error(reason, '无法打开工作区'))}>
                <FolderOpen size={15} aria-hidden="true" />
                选择文件夹
              </button>
            </div>
          ) : status === 'idle' && messages.length === 0 ? (
            <div className="codex-native-landing">
              <h1>尚未连接 {engineName}</h1>
              <p>连接后可读取会话与执行状态。</p>
              <button type="button" onClick={() => void connect().catch((reason) => toast.error(reason, '连接执行器失败'))}>连接执行器</button>
            </div>
          ) : status === 'connecting' && messages.length === 0 ? (
            <div className="codex-native-landing">
              <Loader2 size={24} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <h1>正在连接 {engineName}</h1>
              <p>正在启动本地引擎并加载模型。</p>
              <button type="button" onClick={() => void reconnectRuntime().catch((reason) => toast.error(reason, '重新连接失败'))}>重新连接</button>
            </div>
          ) : status === 'unavailable' && messages.length === 0 ? (
            <div className="flex h-full items-start justify-center overflow-y-auto p-6">
              <div className="w-full max-w-xl space-y-4">
                <section className="space-y-3 rounded-xl border border-line bg-surface-4 p-4">
                  <h1 className="font-semibold text-ink">{engineName} 连接未成功</h1>
                  <p role="alert" className="whitespace-pre-wrap break-words text-sm text-ink-2">{error || '本地引擎未能完成连接，请重试。'}</p>
                  <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-white" onClick={() => void reconnectRuntime().catch((reason) => toast.error(reason, '重新连接失败'))}>使用已保存配置重试</button>
                </section>
                {hasSavedPiConfig ? <details className="rounded-xl border border-line p-3">
                  <summary className="cursor-pointer text-sm text-ink-2">修改模型配置</summary>
                  <div className="mt-3"><PiQuickOnboardingCard /></div>
                </details> : <PiQuickOnboardingCard />}
              </div>
            </div>
          ) : messages.length === 0 && !running && status !== 'external' && status !== 'interrupted' ? (
            <div className="codex-native-landing work-first-welcome">
              <span><Bot size={22} aria-hidden="true" /></span>
              <h1>有什么事交给我？</h1>
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
                  {status === 'connecting' ? '正在连接执行器，当前保留已读取的历史记录。' : '执行器尚未连接，当前显示已读取的记录，最新状态未确认。'}
                  {status !== 'connecting' ? <button type="button" className="ml-2 text-primary hover:underline" onClick={() => void connect().catch((reason) => toast.error(reason, '重新连接失败'))}>重新连接执行器</button> : null}
                </div>
              ) : null}
              {status === 'interrupted' ? (
                <section className="codex-native-interruption" role="alert" aria-label="Pi 本轮已中断">
                  <div>
                    <h2>Pi 本轮已中断</h2>
                    <p>{error || '本地 Pi Runtime 已退出。已保留收到的部分结果。'}</p>
                  </div>
                  <button
                    type="button"
                    disabled={refreshingFromCodex}
                    onClick={() => void refreshCodexThread()}
                  >
                    {refreshingFromCodex
                      ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : <RefreshCw size={14} aria-hidden="true" />}
                    {refreshingFromCodex ? '刷新中' : refreshLabel}
                  </button>
                </section>
              ) : null}
              {status === 'external' ? (
                <section className="codex-native-interruption is-external" aria-label="会话已交给 Codex App">
                  <div>
                    <h2>会话已在 Codex App 中打开</h2>
                    <p>可从最新内容创建 RocketX 继续分支，不需要退出 Codex App；之后两边独立继续。</p>
                  </div>
                  <button
                    type="button"
                    disabled={refreshingFromCodex}
                    onClick={() => void refreshCodexThread()}
                  >
                    {refreshingFromCodex
                      ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                      : <RefreshCw size={14} aria-hidden="true" />}
                    {refreshingFromCodex ? '刷新中' : refreshLabel}
                  </button>
                </section>
              ) : null}
              {visibleMessages.map((entry) => <ConversationMessage key={entry.id} entry={entry} renderLink={renderArtifactLink} />)}

              {events.length > 0 ? (
                <details className="codex-native-activities" aria-label="任务过程">
                  <summary>
                    <span>{activityStatus}</span>
                    <small className="codex-native-activity-latest">{latestActivity?.title}</small>
                    <small className="codex-native-activity-count">{events.length} 项活动</small>
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
                  <strong>已排队 {queuedMessages.length} 条</strong>
                  {queuedMessages.map((entry) => (
                    <span key={entry.id}>{entry.text || `${entry.images.length} 张图片`}</span>
                  ))}
                </div>
              ) : null}
              {error && status !== 'interrupted'
                ? <div className="codex-native-inline-error" role="alert">{error}</div>
                : null}
            </div>
          )}
        </main>

        <footer className="butler-conversation-footer codex-native-footer">
          <div className="codex-native-composer work-first-composer">
            <div className="work-first-composer-target" id="butler-composer-target"><Bot size={13} aria-hidden="true" /><span>发给管家</span><span aria-hidden="true">·</span><strong>{activeThreadId ? linkedCard?.title || title : '新事情'}</strong></div>
            <AgentComposerFeedback draft={draft} onRetry={retryRequest} />
            {readingImages ? <p role="status" className="text-xs text-ink-3">正在读取图片，读取完成后可发送。</p> : null}
            {status === 'external' ? (
              <div id="codex-external-composer-notice" className="codex-native-composer-notice" role="status">
                <CircleAlert size={14} aria-hidden="true" />
                <span>Codex App 保留原任务；点击上方“在 RocketX 继续”会创建可编辑分支。</span>
              </div>
            ) : null}
            <fieldset disabled={readingImages} className="m-0 border-0 p-0"><CodexImagePreviews images={images} onChange={setImages} /></fieldset>
            <textarea
              ref={textareaRef}
              data-work-composer="pi"
              data-work-session-id={activeThreadId ?? ''}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onPaste={(event) => {
                if (imageReadKeysRef.current.has(composerKey) && event.clipboardData.files.length > 0) {
                  event.preventDefault();
                  return;
                }
                void pasteCodexImages(event, images, setImages, setReadingImages);
              }}
              onKeyDown={(event) => {
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
              aria-label="给管家的要求"
              aria-describedby={`butler-composer-target${status === 'external' ? ' codex-external-composer-notice' : ''}`}
              placeholder={composerPlaceholder}
              rows={1}
            />
            <div className="codex-native-composer-bar">
              <div>
                <CodexImagePicker key={composerKey} images={images} onChange={setImages} disabled={!canCompose || readingImages} onReadingChange={setReadingImages} />
                <details className="work-first-composer-settings">
                  <summary><Settings size={14} aria-hidden="true" />对话设置</summary>
                  <div className="work-first-composer-settings-content">
                <ComposerMenu
                  ariaLabel="模型"
                  label={formatModelLabel(selectedModel, activeModel?.displayName ?? (selectedModel || '模型'))}
                  value={selectedModel}
                  choices={modelChoices}
                  disabled={!canCompose}
                  onChange={(model) => void setModel(model).catch((reason) => toast.error(reason))}
                  footerAction={{
                    label: '配置模型与 API Key…',
                    icon: <Settings size={13} aria-hidden="true" />,
                    onClick: () => setModule('settings'),
                  }}
                />
                {activeModel && activeModel.supportedReasoningEfforts && activeModel.supportedReasoningEfforts.length > 0 ? (
                  <ComposerMenu
                    ariaLabel="推理强度"
                    label={selectedEffort ? `思考: ${effortLabel(selectedEffort)}` : '思考'}
                    value={selectedEffort ?? ''}
                    choices={effortChoices}
                    disabled={!canCompose}
                    onChange={(effort) => void setEffort(effort || null).catch((reason) => toast.error(reason))}
                  />
                ) : null}
                <ComposerMenu
                  ariaLabel="权限"
                  label={permissionLabel}
                  value={permissionPreset}
                  choices={PERMISSION_CHOICES}
                  disabled={!canCompose}
                  onChange={(preset) => void setPermissionPreset(preset as 'ask' | 'auto' | 'full').catch((reason) => toast.error(reason))}
                />
                  </div>
                </details>
                <details className="work-first-composer-voice" onToggle={(event) => setVoicePanelOpen(event.currentTarget.open)}>
                  <summary><Mic size={14} aria-hidden="true" /><span>语音</span></summary>
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
                    ariaLabel="后续消息处理方式"
                    label={followUpMode === 'steer' ? '立即调整' : '排队'}
                    value={followUpMode}
                    choices={FOLLOW_UP_CHOICES}
                    onChange={(mode) => setFollowUpMode(mode as CodexFollowUpMode)}
                  />
                ) : null}
              </div>
              <div>
                {running ? (
                  <button type="button" aria-label="停止任务" className="codex-native-stop" onClick={() => void interrupt()}>
                    <Square size={13} fill="currentColor" aria-hidden="true" />
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={running ? '发送后续消息' : '发送'}
                  title={running ? 'Enter 发送；Ctrl+Shift+Enter 使用另一种后续方式' : 'Enter 发送；Shift+Enter 换行'}
                  disabled={!canCompose || !draft.loaded || readingImages || Boolean(draft.pending) || (!input.trim() && images.length === 0)}
                  onClick={() => void submit()}
                >
                  <Send size={14} aria-hidden="true" />
                  <span>{running ? (followUpMode === 'steer' ? '立即调整' : '加入队列') : '发送'}</span>
                </button>
              </div>
            </div>
          </div>
        </footer>
      </section>
      {portalOpen ? (
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
