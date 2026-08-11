import { open } from '@tauri-apps/plugin-dialog';
import {
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  FolderOpen,
  Loader2,
  PanelLeft,
  RefreshCw,
  Send,
  Square,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openCodexNewThread, openCodexThread } from '../agent/codexTransfer';
import {
  codexArtifactFromLink,
  codexArtifactsFromMarkdown,
  type CodexArtifact,
} from '../lib/codexArtifacts';
import { isTauriRuntime } from '../lib/client';
import { renderMarkdown, type MarkdownLinkRenderer } from '../lib/markdown';
import { useStickToBottom } from '../lib/stickToBottom';
import type { CodexHostInput } from '../agent/codexHostInput';
import type { CodexImageInput } from '../lib/codexImages';
import {
  useCodexWorkspace,
  type CodexFollowUpMode,
  type CodexPendingRequest,
  type CodexWorkspaceEvent,
  type CodexWorkspaceMessage,
} from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import ButlerConversationHistory from './ButlerConversationHistory';
import ButlerErrandInputCard from './ButlerErrandInputCard';
import CodexArtifactPanel, { CodexArtifactLink } from './CodexArtifactPanel';
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
}: {
  ariaLabel: string;
  label: string;
  value: string;
  choices: readonly ComposerChoice[];
  disabled?: boolean;
  onChange: (value: string) => void;
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
}: {
  entry: CodexWorkspaceMessage;
  renderLink: MarkdownLinkRenderer;
}) {
  return (
    <article data-speaker={entry.role} className="codex-native-message">
      <span>{entry.role === 'assistant' ? 'Codex' : '你'}</span>
      <div className="butler-conversation-markdown">
        {entry.text ? (entry.role === 'assistant' ? renderMarkdown(entry.text, undefined, renderLink) : entry.text) : null}
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
  return ({ low: '低', medium: '中', high: '高', xhigh: '超高' } as Record<string, string>)[effort] ?? effort;
}

export default function ButlerConversation({ embedded = false }: { embedded?: boolean }) {
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const defaultWorkspaceRoot = useCodexWorkspace((state) => state.defaultWorkspaceRoot);
  const butlerWorkspaceRoot = useCodexWorkspace((state) => state.butlerWorkspaceRoot);
  const status = useCodexWorkspace((state) => state.status);
  const error = useCodexWorkspace((state) => state.error);
  const threads = useCodexWorkspace((state) => state.threads);
  const activeThreadId = useCodexWorkspace((state) => state.activeThreadId);
  const messages = useCodexWorkspace((state) => state.messages);
  const streamingText = useCodexWorkspace((state) => state.streamingText);
  const events = useCodexWorkspace((state) => state.events);
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
  const refreshFromCodex = useCodexWorkspace((state) => state.refreshFromCodex);
  const handoffToCodex = useCodexWorkspace((state) => state.handoffToCodex);
  const send = useCodexWorkspace((state) => state.send);
  const interrupt = useCodexWorkspace((state) => state.interrupt);
  const setModel = useCodexWorkspace((state) => state.setModel);
  const setEffort = useCodexWorkspace((state) => state.setEffort);
  const setPermissionPreset = useCodexWorkspace((state) => state.setPermissionPreset);
  const setFollowUpMode = useCodexWorkspace((state) => state.setFollowUpMode);
  const clearComposerDraft = useCodexWorkspace((state) => state.clearComposerDraft);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<CodexImageInput[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<CodexArtifact | null>(null);
  const [refreshingFromCodex, setRefreshingFromCodex] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyCloseRef = useRef<HTMLButtonElement>(null);
  const historyPanelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoOpenedArtifactMessageRef = useRef<string>();
  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  const activeModel = models.find((model) => model.model === selectedModel || model.id === selectedModel);
  const running = status === 'running' || status === 'waiting-input';
  const latestActivity = events.at(-1);
  const completedMessage = !running && events.length > 0 && messages.at(-1)?.role === 'assistant'
    ? messages.at(-1)
    : undefined;
  const visibleMessages = completedMessage ? messages.slice(0, -1) : messages;
  const activityStatus = running
    ? '正在工作'
    : status === 'interrupted' || error === 'Codex 本轮已中断'
      ? '已中断'
      : events.some((event) => event.status === 'failed')
        ? '未完成'
        : '已完成';
  const desktopRuntime = isTauriRuntime();
  const canCompose = desktopRuntime
    && Boolean(workspaceRoot)
    && !['idle', 'connecting', 'interrupted', 'external', 'unavailable'].includes(status);
  const refreshLabel = status === 'external' ? '在 RocketX 继续' : '从 Codex 刷新';
  const composerPlaceholder = status === 'external'
    ? '点击上方“在 RocketX 继续”'
    : running
      ? (followUpMode === 'steer' ? '输入指令，立即调整当前任务' : '输入后续消息，将在当前任务后执行')
      : '给 Codex 一个任务';
  const title = activeThread?.name?.trim() || activeThread?.preview.trim() || '新任务';
  const modelChoices = useMemo<ComposerChoice[]>(() => models.map((model) => ({
    id: model.model,
    label: model.displayName,
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
      ? <CodexArtifactLink artifact={artifact} label={label} onOpen={setSelectedArtifact} />
      : undefined;
  }, [workspaceRoot]);

  const closeArtifact = useCallback((): void => setSelectedArtifact(null), []);

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
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')]
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
  }, [clearComposerDraft, composerDraft]);

  useEffect(() => {
    const latest = [...messages].reverse().find((entry) => entry.role === 'assistant' && entry.text);
    if (!latest || autoOpenedArtifactMessageRef.current === latest.id) return;
    autoOpenedArtifactMessageRef.current = latest.id;
    const artifacts = codexArtifactsFromMarkdown(latest.text, workspaceRoot);
    if (artifacts.length > 0) setSelectedArtifact(artifacts.at(-1) ?? null);
  }, [messages, workspaceRoot]);

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
  ]);

  const chooseWorkspace = async (): Promise<void> => {
    if (!isTauriRuntime()) throw new Error('网页版没有本地 Codex 执行面，请使用 RocketX 桌面端');
    const path = await open({ directory: true, multiple: false, title: '选择 Codex 工作区' });
    if (typeof path !== 'string') return;
    await setWorkspaceRoot(path);
    await connect();
  };

  const submit = async (text = input, modeOverride?: CodexFollowUpMode): Promise<void> => {
    const value = text.trim();
    if (!value && images.length === 0) return;
    const outgoingImages = images;
    setInput('');
    setImages([]);
    stickToBottom.current = true;
    try {
      await send(value, outgoingImages, modeOverride);
    } catch (reason) {
      setInput(value);
      setImages(outgoingImages);
      toast.error(reason, '任务没有发出');
    }
  };

  const openInCodex = async (): Promise<void> => {
    try {
      if (activeThreadId) {
        await handoffToCodex();
        const result = await openCodexThread(activeThreadId);
        if (result === 'unavailable') {
          await refreshFromCodex().catch(() => undefined);
          throw new Error('Codex App 没有响应');
        }
        return;
      }
      const result = workspaceRoot ? await openCodexNewThread('', workspaceRoot) : 'unavailable';
      if (result === 'unavailable') throw new Error('Codex App 没有响应');
    } catch (reason) {
      toast.error(reason, '无法打开 Codex App');
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
          ? `已从 Codex 同步 ${added} 个新步骤`
          : '已同步并接回 RocketX');
        requestAnimationFrame(() => textareaRef.current?.focus());
      }
    } catch (reason) {
      toast.error(reason, '无法从 Codex 刷新');
    } finally {
      setRefreshingFromCodex(false);
    }
  };

  const suggestions = useMemo(() => [
    '梳理这个工作区目前最需要处理的问题',
    '查看当前改动，并给出下一步建议',
    '帮我定位最近一次失败的原因',
  ], []);

  return (
    <div className={`butler-conversation-layout codex-native-workspace${selectedArtifact ? ' has-artifact' : ''} ${embedded ? 'bg-transparent' : 'bg-surface'}`}>
      <ButlerConversationHistory />
      {historyOpen ? (
        <div className="butler-conversation-mobile-drawer">
          <button type="button" tabIndex={-1} aria-label="关闭任务列表" className="butler-conversation-mobile-backdrop" onClick={closeHistory} />
          <div ref={historyPanelRef} role="dialog" aria-modal="true" aria-label="任务列表" className="butler-conversation-mobile-panel">
            <button ref={historyCloseRef} type="button" aria-label="关闭任务列表" className="butler-conversation-mobile-close" onClick={closeHistory}>
              <X size={17} aria-hidden="true" />
            </button>
            <div className="h-full" onClickCapture={(event) => {
              if ((event.target as HTMLElement).closest('button')) closeHistory();
            }}>
              <ButlerConversationHistory onNavigate={closeHistory} />
            </div>
          </div>
        </div>
      ) : null}

      <section className="butler-conversation-pane" aria-label="Codex 任务">
        <header className="butler-conversation-header">
          <div className="min-w-0">
            <span>{workspaceRoot
              ? workspaceRoot === defaultWorkspaceRoot
                ? '临时会话'
                : workspaceRoot === butlerWorkspaceRoot
                  ? '管家会话'
                  : workspaceRoot.split(/[\\/]/).filter(Boolean).at(-1)
              : 'Codex'}</span>
            <h2>{title}</h2>
            {workspaceRoot ? <p title={workspaceRoot}>{workspaceRoot}</p> : null}
          </div>
          <div className="butler-conversation-header-actions">
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
            {activeThreadId ? (
              <button
                type="button"
                aria-label={refreshLabel}
                title={running
                  ? '任务运行中，完成后再刷新'
                  : status === 'external'
                    ? '保留 Codex App 原任务，并从最新内容创建可编辑分支'
                    : '同步 Codex App 的最新内容'}
                disabled={!desktopRuntime || running || status === 'connecting' || refreshingFromCodex}
                onClick={() => void refreshCodexThread()}
                className="codex-native-refresh"
              >
                {refreshingFromCodex
                  ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <RefreshCw size={14} aria-hidden="true" />}
                {refreshingFromCodex ? '刷新中' : refreshLabel}
              </button>
            ) : null}
            <button
              type="button"
              disabled={!desktopRuntime || running || status === 'connecting' || status === 'external'}
              onClick={() => void openInCodex()}
              className="codex-native-open-app"
            >
              <ArrowUpRight size={14} aria-hidden="true" />
              {status === 'external' ? '已交给 Codex' : '在 Codex 中打开'}
            </button>
          </div>
        </header>

        <main ref={scrollRef} onScroll={onScroll} className="codex-native-transcript">
          {!desktopRuntime ? (
            <div className="codex-native-landing">
              <span><Bot size={24} aria-hidden="true" /></span>
              <h1>网页版没有本地 Codex 执行面</h1>
              <p>消息、工作台和确定性功能仍可使用；运行 Codex 任务、Skills、Memory 和审批请打开 RocketX 桌面端。</p>
            </div>
          ) : !workspaceRoot ? (
            <div className="codex-native-landing">
              <span><FolderOpen size={24} aria-hidden="true" /></span>
              <h1>选择一个工作区</h1>
              <p>Codex 会在这里读取代码、运行工具并维护任务记忆。</p>
              <button type="button" onClick={() => void chooseWorkspace().catch((reason) => toast.error(reason, '无法打开工作区'))}>
                <FolderOpen size={15} aria-hidden="true" />
                选择文件夹
              </button>
            </div>
          ) : status === 'connecting' || status === 'idle' ? (
            <div className="codex-native-landing">
              <Loader2 size={24} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <h1>正在连接 Codex</h1>
              <p>正在读取模型、权限、插件和任务。</p>
            </div>
          ) : status === 'unavailable' ? (
            <div className="codex-native-landing is-error">
              <CircleAlert size={24} aria-hidden="true" />
              <h1>Codex Runtime 不可用</h1>
              <p>{error || '当前运行时缺少必需能力，请升级 Codex 后重试。'}</p>
              <div>
                <button type="button" onClick={() => void connect().catch(() => undefined)}>重试</button>
                <button type="button" onClick={() => void chooseWorkspace().catch(() => undefined)}>更换工作区</button>
              </div>
            </div>
          ) : !activeThreadId && messages.length === 0 ? (
            <div className="codex-native-landing">
              <span><Bot size={24} aria-hidden="true" /></span>
              <h1>从一个任务开始</h1>
              <p>描述结果即可。Codex 会选择合适的 Skill、工具和步骤。</p>
              <div className="codex-native-suggestions">
                {suggestions.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => void submit(suggestion)}>{suggestion}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="codex-native-transcript-inner">
              {status === 'interrupted' ? (
                <section className="codex-native-interruption" role="alert" aria-label="Codex 本轮已中断">
                  <div>
                    <h2>Codex 本轮已中断</h2>
                    <p>{error || '本地 Codex Runtime 已退出。已保留收到的部分结果。'}</p>
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

              {completedMessage ? <ConversationMessage entry={completedMessage} renderLink={renderArtifactLink} /> : null}

              {streamingText ? (
                <article data-speaker="assistant" className="codex-native-message is-streaming">
                  <span>Codex</span>
                  <div className="butler-conversation-markdown">{streamingText}</div>
                </article>
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
          <div className="codex-native-composer">
            {status === 'external' ? (
              <div id="codex-external-composer-notice" className="codex-native-composer-notice" role="status">
                <CircleAlert size={14} aria-hidden="true" />
                <span>Codex App 保留原任务；点击上方“在 RocketX 继续”会创建可编辑分支。</span>
              </div>
            ) : null}
            <CodexImagePreviews images={images} onChange={setImages} />
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onPaste={(event) => void pasteCodexImages(event, images, setImages)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
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
              aria-label="给 Codex 的任务"
              aria-describedby={status === 'external' ? 'codex-external-composer-notice' : undefined}
              placeholder={composerPlaceholder}
              rows={1}
            />
            <div className="codex-native-composer-bar">
              <div>
                <CodexImagePicker images={images} onChange={setImages} disabled={!canCompose} />
                <ComposerMenu
                  ariaLabel="模型"
                  label={activeModel?.displayName ?? '模型'}
                  value={selectedModel}
                  choices={modelChoices}
                  disabled={!canCompose}
                  onChange={(model) => void setModel(model).catch((reason) => toast.error(reason))}
                />
                {activeModel && activeModel.supportedReasoningEfforts.length > 1 ? (
                  <ComposerMenu
                    ariaLabel="推理强度"
                    label={selectedEffort ? effortLabel(selectedEffort) : '推理'}
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
                  disabled={!canCompose || (!input.trim() && images.length === 0)}
                  onClick={() => void submit()}
                >
                  <Send size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </footer>
      </section>
      {selectedArtifact ? <CodexArtifactPanel artifact={selectedArtifact} onClose={closeArtifact} /> : null}
    </div>
  );
}
