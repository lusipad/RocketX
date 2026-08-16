import {
  ArrowUpRight,
  CircleAlert,
  Copy,
  Loader2,
  MessageCircle,
  MessageSquarePlus,
  SendHorizontal,
  Settings,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { DshMessage } from '../agent/dsh/project';
import { getServerBase, isTauriRuntime } from '../lib/client';
import { renderMarkdownDoc, StableStreamingMarkdown } from '../lib/markdown';
import { useStickToBottom } from '../lib/stickToBottom';
import { useCoalescedStoreProjection } from '../lib/useCodexStreamingText';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { type CodexWorkspaceMessage, useCodexWorkspace } from '../stores/codexWorkspace';
import { privateRoomDshKey, usePrivateRoomDsh } from '../stores/privateRoomDsh';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import ButlerSources from './ButlerSources';
import { CodexGeneratedImages, CodexImageAttachments } from './CodexImagePicker';
import DshQuestionCard from './DshQuestionCard';
import PanelShell from './PanelShell';

const ROOM_THREAD_STORAGE_KEY = 'rcx-room-codex-threads-v1';
const ROOM_MESSAGE_SEPARATOR = '\n\n<<<ROCKETX_ROOM_MESSAGE>>>\n';

function roomThreadKey(scope: string, rid: string): string {
  return `${scope}:${rid}`;
}

function roomThreadId(scope: string, rid: string): string | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  try {
    const value = JSON.parse(localStorage.getItem(ROOM_THREAD_STORAGE_KEY) ?? '{}') as Record<string, unknown>;
    const threadId = value[roomThreadKey(scope, rid)];
    return typeof threadId === 'string' && threadId ? threadId : undefined;
  } catch {
    return undefined;
  }
}

function setRoomThreadId(scope: string, rid: string, threadId?: string): void {
  if (typeof localStorage === 'undefined') return;
  let value: Record<string, string> = {};
  try {
    value = JSON.parse(localStorage.getItem(ROOM_THREAD_STORAGE_KEY) ?? '{}') as Record<string, string>;
  } catch {
    value = {};
  }
  const key = roomThreadKey(scope, rid);
  if (threadId) value[key] = threadId;
  else delete value[key];
  localStorage.setItem(ROOM_THREAD_STORAGE_KEY, JSON.stringify(value));
}

export async function prepareRoomWorkspace(): Promise<boolean> {
  const workspace = useCodexWorkspace.getState();
  await workspace.ensureDefaultWorkspace();
  const latest = useCodexWorkspace.getState();
  const root = latest.butlerWorkspaceRoot || latest.defaultWorkspaceRoot;
  if (!root) throw new Error('系统管家工作区尚未准备好');
  if (latest.workspaceRoot !== root) {
    await latest.setWorkspaceRoot(root, { reuseRuntime: true });
  }
  const current = useCodexWorkspace.getState();
  if (['idle', 'interrupted', 'unavailable'].includes(current.status)) {
    await current.connect({ refreshThreads: false });
    return true;
  }
  return false;
}

function roomPrompt(roomTitle: string, rid: string, question: string): string {
  return [
    `请在 Rocket.Chat 房间「${roomTitle}」（rid: ${rid}）的语境中回答。`,
    '这是当前用户的私人房间 AI 会话。不要把回答发送到房间，也不要假设其他成员能看到本会话。',
    '需要房间数据时使用对应 Skill 或 App 获取真实内容，不要猜测。',
    '事实性结论后用 [来源](工具返回的原始 link 或 webUrl) 标注；工具没有返回链接时不要编造。',
    ROOM_MESSAGE_SEPARATOR,
    question,
  ].join('\n');
}

function visibleUserText(text: string): string {
  const marker = text.indexOf(ROOM_MESSAGE_SEPARATOR);
  return marker >= 0 ? text.slice(marker + ROOM_MESSAGE_SEPARATOR.length).trim() : text;
}

function useRoomCodexThreadProjection(threadId: string | undefined) {
  const select = useCallback((state: ReturnType<typeof useCodexWorkspace.getState>) => ({
    activeThreadId: state.activeThreadId,
    globalStatus: state.status,
    globalError: state.error,
    globalMessages: state.messages,
    thread: threadId ? state.threadStates[threadId] : undefined,
  }), [threadId]);
  const changed = useCallback((
    state: ReturnType<typeof useCodexWorkspace.getState>,
    previous: ReturnType<typeof useCodexWorkspace.getState>,
  ) => (
    state.activeThreadId !== previous.activeThreadId
    || state.status !== previous.status
    || state.error !== previous.error
    || state.messages !== previous.messages
    || (threadId ? state.threadStates[threadId] !== previous.threadStates[threadId] : false)
  ), [threadId]);
  const settled = useCallback((state: ReturnType<typeof useCodexWorkspace.getState>) => {
    const thread = threadId ? state.threadStates[threadId] : undefined;
    const status = thread?.status ?? (state.activeThreadId === threadId ? state.status : 'connecting');
    return !thread?.streamingText && status !== 'running' && status !== 'waiting-input';
  }, [threadId]);
  const immediate = useCallback((
    state: ReturnType<typeof useCodexWorkspace.getState>,
    previous: ReturnType<typeof useCodexWorkspace.getState>,
  ) => state.activeThreadId !== previous.activeThreadId, []);
  return useCoalescedStoreProjection(
    useCodexWorkspace,
    select,
    changed,
    settled,
    immediate,
  );
}

function usePrivateRoomDshProjection(key: string) {
  const select = useCallback(
    (state: ReturnType<typeof usePrivateRoomDsh.getState>) => state.sessions[key],
    [key],
  );
  const changed = useCallback((
    state: ReturnType<typeof usePrivateRoomDsh.getState>,
    previous: ReturnType<typeof usePrivateRoomDsh.getState>,
  ) => state.sessions[key] !== previous.sessions[key], [key]);
  const settled = useCallback((state: ReturnType<typeof usePrivateRoomDsh.getState>) => {
    const session = state.sessions[key];
    const streaming = session?.transcript.messages.some((entry) => entry.streaming) ?? false;
    return !streaming && session?.status !== 'running' && session?.status !== 'waiting-input';
  }, [key]);
  return useCoalescedStoreProjection(
    usePrivateRoomDsh,
    select,
    changed,
    settled,
  );
}

function PrivateNote() {
  return <p className="mt-2 text-xs text-ink-3">仅你可见，不会向当前房间发送消息。</p>;
}

function ConversationCopyButton({
  text,
  speaker,
  align,
}: {
  text: string;
  speaker: string;
  align: 'left' | 'right';
}) {
  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('系统剪贴板不可用');
      await navigator.clipboard.writeText(text);
      toast.success(`${speaker}消息已复制`);
    } catch (reason) {
      toast.error(reason, '复制失败');
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`复制${speaker}消息`}
      title={`复制${speaker}消息`}
      className={`absolute bottom-0 flex translate-y-full items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ink-3 opacity-0 transition-opacity hover:bg-fill-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${align === 'right' ? 'right-0' : 'left-0'}`}
    >
      <Copy size={11} aria-hidden="true" /> 复制
    </button>
  );
}

function CodexRoomMessage({
  entry,
  progressive = false,
  streaming = false,
}: {
  entry: CodexWorkspaceMessage;
  progressive?: boolean;
  streaming?: boolean;
}) {
  return (
    <article
      data-speaker={entry.role}
      className={`codex-native-message group relative${streaming ? ' is-streaming' : ''}`}
    >
      <span>{entry.role === 'assistant' ? 'Codex' : '你'}</span>
      <div className="butler-conversation-markdown">
        {entry.text
          ? entry.role === 'assistant'
            ? (
                <ButlerSources sources={entry.sources} text={entry.text}>
                  {(renderLink) => progressive
                    ? <StableStreamingMarkdown text={entry.text} renderLink={renderLink} />
                    : renderMarkdownDoc(entry.text, undefined, renderLink)}
                </ButlerSources>
              )
            : visibleUserText(entry.text)
          : null}
        <CodexImageAttachments attachments={entry.attachments} />
        <CodexGeneratedImages images={entry.generatedImages} />
      </div>
      {entry.text && !streaming ? (
        <ConversationCopyButton
          text={entry.role === 'user' ? visibleUserText(entry.text) : entry.text}
          speaker={entry.role === 'assistant' ? 'Codex' : '你的'}
          align={entry.role === 'user' ? 'right' : 'left'}
        />
      ) : null}
    </article>
  );
}

function DshRoomMessage({
  entry,
  progressive = false,
}: {
  entry: DshMessage;
  progressive?: boolean;
}) {
  const streaming = Boolean(entry.streaming);
  return (
    <article
      data-speaker={entry.role}
      className={`codex-native-message group relative${streaming ? ' is-streaming' : ''}`}
    >
      <span>{entry.role === 'assistant' ? 'DeepSeek' : entry.role === 'user' ? '你' : '系统'}</span>
      <div className="butler-conversation-markdown">
        {entry.role === 'assistant'
          ? progressive
            ? <StableStreamingMarkdown text={entry.text} />
            : renderMarkdownDoc(entry.text)
          : entry.role === 'user'
            ? visibleUserText(entry.text)
            : entry.text}
      </div>
      {entry.text && !streaming && entry.role !== 'system' ? (
        <ConversationCopyButton
          text={entry.role === 'user' ? visibleUserText(entry.text) : entry.text}
          speaker={entry.role === 'assistant' ? 'DeepSeek' : '你的'}
          align={entry.role === 'user' ? 'right' : 'left'}
        />
      ) : null}
    </article>
  );
}

function CodexRoomConversation({ rid, roomName, scope }: { rid: string; roomName: string; scope: string }) {
  const desktopRuntime = isTauriRuntime();
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const butlerWorkspaceRoot = useCodexWorkspace((state) => state.butlerWorkspaceRoot);
  const models = useCodexWorkspace((state) => state.models);
  const selectedModel = useCodexWorkspace((state) => state.selectedModel);
  const [threadId, setThreadId] = useState(() => roomThreadId(scope, rid));
  const threadView = useRoomCodexThreadProjection(threadId);
  const thread = threadView.thread;
  const messages = thread?.messages ?? (threadView.activeThreadId === threadId ? threadView.globalMessages : []);
  const status = thread?.status ?? (threadView.activeThreadId === threadId ? threadView.globalStatus : 'connecting');
  const streamingText = thread?.streamingText ?? '';
  const pendingRequests = thread?.pendingRequests ?? [];
  const runtimeError = thread?.error ?? (threadView.activeThreadId === threadId ? threadView.globalError : null);
  const modelId = thread?.runtimeSelection?.model || selectedModel;
  const modelLabel = models.find((model) => model.model === modelId || model.id === modelId)?.displayName
    || modelId
    || 'Codex';
  const [input, setInput] = useState('');
  const [loadingRoom, setLoadingRoom] = useState(true);
  const [roomError, setRoomError] = useState<string>();
  const running = status === 'running' || status === 'waiting-input';
  const completedMessage = !running && messages.at(-1)?.role === 'assistant'
    ? messages.at(-1)
    : undefined;
  const visibleMessages = completedMessage ? messages.slice(0, -1) : messages;
  const activeAssistantMessage: CodexWorkspaceMessage | undefined = streamingText
    ? { id: 'active-room-assistant', role: 'assistant', text: streamingText, pending: true }
    : completedMessage;
  const { scrollRef, onScroll, stickToBottom } = useStickToBottom([
    rid,
    messages,
    streamingText,
    pendingRequests,
  ]);
  const canCompose = desktopRuntime
    && !loadingRoom
    && !roomError
    && Boolean(butlerWorkspaceRoot || workspaceRoot)
    && !['idle', 'connecting', 'interrupted', 'external', 'unavailable'].includes(status);

  useEffect(() => {
    setThreadId(roomThreadId(scope, rid));
    if (!scope || !desktopRuntime) {
      setLoadingRoom(false);
      return;
    }
    let cancelled = false;
    setLoadingRoom(true);
    setRoomError(undefined);
    setInput('');
    stickToBottom.current = true;

    void (async () => {
      try {
        let savedThreadId = roomThreadId(scope, rid);
        const runtimeReconnected = await prepareRoomWorkspace();
        if (cancelled) return;
        if (savedThreadId) {
          const current = useCodexWorkspace.getState();
          if (runtimeReconnected || current.activeThreadId !== savedThreadId) {
            try {
              await current.resumeThread(savedThreadId);
            } catch (reason) {
              const detail = reason instanceof Error ? reason.message : String(reason);
              if (!/not found|unknown thread|不存在|找不到/iu.test(detail)) throw reason;
              setRoomThreadId(scope, rid);
              savedThreadId = await useCodexWorkspace.getState().startThread(`${roomName} · 房间 AI`);
              setRoomThreadId(scope, rid, savedThreadId);
            }
          }
        } else {
          savedThreadId = await useCodexWorkspace.getState().startThread(`${roomName} · 房间 AI`);
          setRoomThreadId(scope, rid, savedThreadId);
        }
        if (!cancelled) setThreadId(savedThreadId);
      } catch (reason) {
        if (!cancelled) setRoomError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) {
          setLoadingRoom(false);
          stickToBottom.current = true;
          requestAnimationFrame(() => {
            const element = scrollRef.current;
            if (element) element.scrollTop = element.scrollHeight;
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [desktopRuntime, rid, roomName, scope, scrollRef, stickToBottom]);

  const openFullConversation = (): void => {
    useChat.getState().setPanel(null);
    useUI.getState().openButlerConversation();
  };

  const newConversation = async (): Promise<void> => {
    if (running) return;
    setLoadingRoom(true);
    setRoomError(undefined);
    try {
      await prepareRoomWorkspace();
      const nextThreadId = await useCodexWorkspace.getState().startThread(`${roomName} · 房间 AI`);
      setRoomThreadId(scope, rid, nextThreadId);
      setThreadId(nextThreadId);
      setInput('');
      stickToBottom.current = true;
    } catch (reason) {
      setRoomError(reason instanceof Error ? reason.message : String(reason));
      toast.error(reason, '无法新建私人房间 AI 会话');
    } finally {
      setLoadingRoom(false);
    }
  };

  const submit = async (): Promise<void> => {
    const question = input.trim();
    if (!question || !canCompose) return;
    setInput('');
    setRoomError(undefined);
    stickToBottom.current = true;
    try {
      let currentThreadId = roomThreadId(scope, rid);
      const runtimeReconnected = await prepareRoomWorkspace();
      const workspace = useCodexWorkspace.getState();
      if (!currentThreadId) {
        currentThreadId = await workspace.startThread(`${roomName} · 房间 AI`);
        setRoomThreadId(scope, rid, currentThreadId);
      } else if (runtimeReconnected || workspace.activeThreadId !== currentThreadId) {
        await workspace.resumeThread(currentThreadId);
      }
      setThreadId(currentThreadId);
      const currentMessages = useCodexWorkspace.getState().threadStates[currentThreadId]?.messages ?? [];
      await useCodexWorkspace.getState().send(
        currentMessages.length === 0 ? roomPrompt(roomName, rid, question) : question,
      );
    } catch (reason) {
      setInput(question);
      setRoomError(reason instanceof Error ? reason.message : String(reason));
      toast.error(reason, '私人房间 AI 消息没有发出');
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line-soft bg-fill-1 px-4 py-2.5 text-xs">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={openFullConversation}
              aria-label="设置 Codex 模型与权限"
              title="在 AI 管家中设置当前 Codex 会话的模型、推理强度和权限"
              className="flex min-w-0 max-w-40 items-center gap-1 rounded bg-surface px-2 py-0.5 text-ink-2 hover:bg-fill-hover"
            >
              <Settings size={11} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{modelLabel}</span>
            </button>
            <span className="shrink-0 whitespace-nowrap rounded bg-surface px-2 py-0.5 text-ink-2">私人会话</span>
          </div>
          <button
            type="button"
            disabled={loadingRoom || running}
            onClick={() => void newConversation()}
            aria-label="新建私人房间 AI 会话"
            title={running ? '当前回复完成后再新建会话' : '新建私人会话'}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface text-ink-2 hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="mt-1.5 truncate text-ink-3" title={butlerWorkspaceRoot || workspaceRoot}>
          {butlerWorkspaceRoot || workspaceRoot || '系统管家目录'}
        </div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loadingRoom ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-ink-3">
            <Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            正在接回私人房间会话
          </div>
        ) : !desktopRuntime ? (
          <div className="rounded-xl border border-line bg-fill-1 p-4 text-sm leading-6 text-ink-2">
            私人房间 AI 需要 RocketX 桌面端。
          </div>
        ) : messages.length === 0 && !streamingText && !running ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-light text-primary">
              <MessageCircle size={21} aria-hidden="true" />
            </span>
            <h3 className="mt-3 text-sm font-semibold text-ink">和房间 AI 私下聊聊</h3>
            <p className="mt-1 max-w-72 text-xs leading-5 text-ink-3">
              会话使用你的系统管家目录，其他房间成员看不到这里的内容。
            </p>
          </div>
        ) : (
          <div className="codex-native-transcript-inner" aria-live="polite">
            {visibleMessages.map((entry) => <CodexRoomMessage key={entry.id} entry={entry} />)}
            {activeAssistantMessage ? (
              <CodexRoomMessage
                key="active-room-assistant"
                entry={activeAssistantMessage}
                progressive
                streaming={Boolean(streamingText)}
              />
            ) : running ? (
              <article data-speaker="assistant" className="codex-native-message is-streaming" role="status">
                <span>Codex</span>
                <div className="flex items-center gap-2 text-ink-3">
                  <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  Codex 正在思考…
                </div>
              </article>
            ) : null}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-line-soft bg-surface px-4 py-3">
        {pendingRequests.length > 0 ? (
          <button
            type="button"
            onClick={openFullConversation}
            className="mb-3 flex w-full items-center justify-between rounded-lg border border-warning/30 bg-warning-light px-3 py-2 text-left text-xs text-ink-2"
          >
            <span>Codex 正在等待你处理 {pendingRequests.length} 项确认</span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        ) : null}
        {roomError || runtimeError ? (
          <p className="mb-2 text-xs leading-5 text-danger" role="alert">{roomError || runtimeError}</p>
        ) : null}
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="flex items-end gap-2 rounded-xl border border-line bg-fill-2 p-2 focus-within:border-primary">
            <textarea
              data-composer-input
              value={input}
              disabled={!canCompose}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void submit();
              }}
              aria-label="发送给私人房间 AI"
              placeholder={running ? '输入后续要求，调整当前回答…' : '给你的房间 AI 发消息…'}
              rows={1}
              autoFocus
              className="min-h-8 max-h-28 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm leading-5 text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={!canCompose || !input.trim()}
              aria-label="发送到私人房间 AI"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <SendHorizontal size={15} aria-hidden="true" />
            </button>
          </div>
          <PrivateNote />
        </form>
      </div>
    </div>
  );
}

function DeepSeekRoomConversation({ rid, roomName, scope }: { rid: string; roomName: string; scope: string }) {
  const desktopRuntime = isTauriRuntime();
  const ensureDefaultWorkspace = useCodexWorkspace((state) => state.ensureDefaultWorkspace);
  const butlerWorkspaceRoot = useCodexWorkspace((state) => state.butlerWorkspaceRoot);
  const defaultWorkspaceRoot = useCodexWorkspace((state) => state.defaultWorkspaceRoot);
  const key = privateRoomDshKey(scope, rid);
  const session = usePrivateRoomDshProjection(key);
  const openRoom = usePrivateRoomDsh((state) => state.openRoom);
  const newRoomSession = usePrivateRoomDsh((state) => state.newRoomSession);
  const prompt = usePrivateRoomDsh((state) => state.prompt);
  const cancel = usePrivateRoomDsh((state) => state.cancel);
  const respondApproval = usePrivateRoomDsh((state) => state.respondApproval);
  const respondQuestion = usePrivateRoomDsh((state) => state.respondQuestion);
  const [input, setInput] = useState('');
  const [opening, setOpening] = useState(true);
  const workspaceRoot = butlerWorkspaceRoot || defaultWorkspaceRoot;
  const running = session?.status === 'running' || session?.status === 'waiting-input';
  const transcriptMessages = session?.transcript.messages ?? [];
  const activeAssistantMessage = transcriptMessages.at(-1)?.role === 'assistant'
    ? transcriptMessages.at(-1)
    : undefined;
  const visibleMessages = activeAssistantMessage ? transcriptMessages.slice(0, -1) : transcriptMessages;
  const { scrollRef, onScroll, stickToBottom } = useStickToBottom([
    rid,
    session?.transcript.messages,
    session?.approvals,
    session?.questions,
    session?.status,
  ]);

  const prepare = async (): Promise<string> => {
    await ensureDefaultWorkspace();
    const latest = useCodexWorkspace.getState();
    const root = latest.butlerWorkspaceRoot || latest.defaultWorkspaceRoot;
    if (!root) throw new Error('系统管家工作区尚未准备好');
    return root;
  };

  useEffect(() => {
    if (!scope || !desktopRuntime) {
      setOpening(false);
      return;
    }
    let cancelled = false;
    setOpening(true);
    setInput('');
    void prepare()
      .then((root) => openRoom({ scope, rid, workspaceRoot: root }))
      .catch((reason) => {
        if (!cancelled) toast.error(reason, '无法打开私人 DeepSeek 会话');
      })
      .finally(() => {
        if (!cancelled) setOpening(false);
      });
    return () => {
      cancelled = true;
    };
  }, [desktopRuntime, openRoom, rid, scope]);

  const createConversation = async (): Promise<void> => {
    if (running) return;
    setOpening(true);
    try {
      const root = await prepare();
      await newRoomSession({ scope, rid, workspaceRoot: root });
      setInput('');
      stickToBottom.current = true;
    } catch (reason) {
      toast.error(reason, '无法新建私人 DeepSeek 会话');
    } finally {
      setOpening(false);
    }
  };

  const submit = async (): Promise<void> => {
    const question = input.trim();
    if (!question || !session?.dshSessionId || running) return;
    setInput('');
    stickToBottom.current = true;
    try {
      const firstMessage = session.transcript.messages.every((message) => message.role !== 'user');
      await prompt(key, firstMessage ? roomPrompt(roomName, rid, question) : question);
    } catch (reason) {
      setInput(question);
      toast.error(reason, '私人房间 AI 消息没有发出');
    }
  };

  const openNativeConversation = (): void => {
    if (!session?.dshSessionId) return;
    useChat.getState().setPanel(null);
    useUI.getState().openPersonalDshConversation(session.dshSessionId);
  };

  const retry = async (): Promise<void> => {
    setOpening(true);
    try {
      const root = await prepare();
      await openRoom({ scope, rid, workspaceRoot: root });
    } catch (reason) {
      toast.error(reason, '无法重新连接私人 DeepSeek 会话');
    } finally {
      setOpening(false);
    }
  };

  const activeActivity = session?.transcript.activities.find((activity) => activity.status === 'running');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line-soft bg-fill-1 px-4 py-2.5 text-xs">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              disabled={!session?.dshSessionId}
              onClick={openNativeConversation}
              aria-label="设置 DeepSeek 模型与 Agent"
              title="在 DSH 中设置当前私人会话的模型、Agent 和权限"
              className="flex min-w-0 items-center gap-1 rounded bg-surface px-2 py-0.5 text-ink-2 hover:bg-fill-hover disabled:opacity-40"
            >
              <Settings size={11} className="shrink-0" aria-hidden="true" /> DeepSeek
            </button>
            <span className="shrink-0 whitespace-nowrap rounded bg-surface px-2 py-0.5 text-ink-2">私人会话</span>
          </div>
          <button
            type="button"
            disabled={opening || running}
            onClick={() => void createConversation()}
            aria-label="新建私人 DeepSeek 会话"
            title={running ? '当前回复完成后再新建会话' : '新建私人会话'}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface text-ink-2 hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="mt-1.5 truncate text-ink-3" title={session?.workspaceRoot || workspaceRoot}>
          {session?.workspaceRoot || workspaceRoot || '系统管家目录'}
        </div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {opening || session?.status === 'connecting' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-ink-3">
            <Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            正在接回私人 DeepSeek 会话
          </div>
        ) : !desktopRuntime ? (
          <div className="rounded-xl border border-line bg-fill-1 p-4 text-sm leading-6 text-ink-2">
            私人房间 AI 需要 RocketX 桌面端。
          </div>
        ) : session?.status === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <CircleAlert size={22} className="text-danger" aria-hidden="true" />
            <h3 className="mt-3 text-sm font-semibold text-ink">私人 DeepSeek 会话连接失败</h3>
            <p className="mt-1 max-w-sm text-xs leading-5 text-danger">{session.error}</p>
            <button
              type="button"
              onClick={() => void retry()}
              className="mt-3 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 hover:bg-fill-hover"
            >
              重试
            </button>
          </div>
        ) : !session || transcriptMessages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-light text-primary">
              <MessageCircle size={21} aria-hidden="true" />
            </span>
            <h3 className="mt-3 text-sm font-semibold text-ink">和房间 AI 私下聊聊</h3>
            <p className="mt-1 max-w-72 text-xs leading-5 text-ink-3">
              使用 DSH 当前模型、Agent 和权限；其他房间成员看不到这里的内容。
            </p>
          </div>
        ) : (
          <div className="codex-native-transcript-inner" aria-live="polite">
            {visibleMessages.map((entry) => <DshRoomMessage key={entry.id} entry={entry} />)}
            {activeAssistantMessage ? (
              <DshRoomMessage
                key="active-room-assistant"
                entry={activeAssistantMessage}
                progressive
              />
            ) : running ? (
              <article data-speaker="assistant" className="codex-native-message is-streaming" role="status">
                <span>DeepSeek</span>
                <div className="flex items-center gap-2 text-ink-3">
                  <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  {activeActivity?.title || 'DeepSeek 正在思考…'}
                </div>
              </article>
            ) : null}
          </div>
        )}
      </div>

      {session?.status === 'waiting-input' ? (
        <>
          {session.approvals.map((approval) => (
            <div key={approval.approvalId} className="mx-4 mb-2 rounded-lg border border-warning/30 bg-warning-light p-3 text-xs text-ink-2">
              <strong className="block text-ink">DeepSeek 请求执行：{approval.toolName}</strong>
              {approval.reason ? <p className="mt-1 leading-5">{approval.reason}</p> : null}
              <div className="mt-2 flex justify-end gap-2">
                <button type="button" onClick={() => void respondApproval(key, approval.approvalId, false)} className="rounded border border-line px-2.5 py-1 hover:bg-fill-hover">拒绝</button>
                <button type="button" onClick={() => void respondApproval(key, approval.approvalId, true)} className="rounded bg-primary px-2.5 py-1 text-white hover:bg-primary-hover">允许</button>
              </div>
            </div>
          ))}
          {session.questions.map((question) => (
            <div key={question.rpcId} className="mx-4 mb-2">
              <DshQuestionCard
                question={question}
                respondQuestion={(answers) => respondQuestion(key, question.rpcId, answers)}
              />
            </div>
          ))}
        </>
      ) : null}

      <div className="shrink-0 border-t border-line-soft bg-surface px-4 py-3">
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="flex items-end gap-2 rounded-xl border border-line bg-fill-2 p-2 focus-within:border-primary">
            <textarea
              data-composer-input
              value={input}
              disabled={!session?.dshSessionId || session.status === 'connecting' || session.status === 'error' || running}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                void submit();
              }}
              aria-label="发送给私人房间 AI"
              placeholder={running ? 'DeepSeek 正在处理当前消息…' : '给你的房间 AI 发消息…'}
              rows={1}
              autoFocus
              className="min-h-8 max-h-28 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm leading-5 text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
            />
            {running && session?.status !== 'waiting-input' ? (
              <button
                type="button"
                onClick={() => void cancel(key).catch((reason) => toast.error(reason, '无法停止 DeepSeek'))}
                aria-label="停止私人房间 AI"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-danger text-white hover:opacity-90"
              >
                <Square size={13} fill="currentColor" aria-hidden="true" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!session?.dshSessionId || running || !input.trim()}
                aria-label="发送到私人房间 AI"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                <SendHorizontal size={15} aria-hidden="true" />
              </button>
            )}
          </div>
          <PrivateNote />
        </form>
      </div>
    </div>
  );
}

function DisabledRoomConversation() {
  const setModule = useUI((state) => state.setModule);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <CircleAlert size={23} className="text-ink-3" aria-hidden="true" />
      <h3 className="mt-3 text-sm font-semibold text-ink">当前未启用 AI</h3>
      <p className="mt-1 max-w-sm text-xs leading-5 text-ink-3">
        私人房间 AI 暂不可发送；已有 Codex 和 DSH 私人会话不会被删除，共享 AI 托管也不会因此变成私人会话。
      </p>
      <button
        type="button"
        onClick={() => {
          useChat.getState().setPanel(null);
          setModule('settings');
        }}
        className="mt-3 flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 hover:bg-fill-hover"
      >
        <Settings size={14} aria-hidden="true" /> AI 设置
      </button>
    </div>
  );
}

export default function ButlerPanel() {
  const rid = useChat((state) => state.activeRid);
  const room = useChat((state) => (state.activeRid ? state.rooms[state.activeRid] : undefined));
  const subscription = useChat((state) => (
    state.activeRid ? state.subscriptions[state.activeRid] : undefined
  ));
  const userId = useAuth((state) => state.user?._id);
  const runtimeScope = useCodexWorkspace((state) => state.scope);
  const provider = useUI((state) => state.aiRuntimeProvider);
  const scope = userId ? `${getServerBase() || 'same-origin'}:${userId}` : '';
  const name = rid
    ? subscription?.fname || subscription?.name || room?.fname || room?.name || rid
    : '';

  useEffect(() => {
    if (!scope || runtimeScope === scope) return;
    useCodexWorkspace.getState().hydrate(scope);
  }, [runtimeScope, scope]);

  if (!rid) return null;

  return (
    <div
      id="room-butler-panel"
      role="dialog"
      aria-modal="false"
      aria-label="私人房间 AI 对话"
      className="absolute top-4 right-3 bottom-28 left-3 z-30 flex justify-end overflow-hidden rounded-xl shadow-[0_24px_64px_-24px_rgba(0,0,0,0.78)]"
    >
      <PanelShell
        resizable
        title={(
          <span className="flex min-w-0 items-center gap-2">
            <MessageCircle size={17} className="shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">房间 AI · {name}</span>
          </span>
        )}
      >
        {!scope || provider === 'none' ? (
          <DisabledRoomConversation />
        ) : provider === 'deepseek' ? (
          <DeepSeekRoomConversation key={`deepseek:${scope}:${rid}`} rid={rid} roomName={name} scope={scope} />
        ) : (
          <CodexRoomConversation key={`codex:${scope}:${rid}`} rid={rid} roomName={name} scope={scope} />
        )}
      </PanelShell>
    </div>
  );
}
