import {
  ArrowUpRight,
  Bell,
  CircleAlert,
  Copy,
  Cpu,
  GripVertical,
  Loader2,
  MessageCircle,
  MessageSquarePlus,
  Radio,
  SendHorizontal,
  Settings,
  Share2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { t, useI18n, useT } from '../i18n';
import {
  formatChatMessagesForButlerPrompt,
  formatSharePayloadForChat,
  hasChatToButlerDrag,
  readChatToButlerDrag,
  writeButlerShareDrag,
  type ButlerSharePayload,
} from '../lib/butlerChatBridge';
import { getServerBase, isTauriRuntime } from '../lib/client';
import { renderMarkdownDoc, StableStreamingMarkdown } from '../lib/markdown';
import { useStickToBottom } from '../lib/stickToBottom';
import { useCoalescedStoreProjection } from '../lib/useCodexStreamingText';
import { useAcpAgents } from '../stores/acpAgents';
import { useAuth } from '../stores/auth';
import { useButlerCognition } from '../stores/butlerCognition';
import { useButlerRoomBindings } from '../stores/butlerRoomBindings';
import { useChat } from '../stores/chat';
import { type CodexWorkspaceMessage, useCodexWorkspace } from '../stores/codexWorkspace';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import ButlerSources from './ButlerSources';
import { CodexGeneratedImages, CodexImageAttachments } from './CodexImagePicker';
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
  if (!root) throw new Error(t('butler.workspaceNotReady'));
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
    t('butler.roomPanel.promptContext', { roomTitle, rid }),
    t('butler.roomPanel.promptPrivate'),
    t('butler.roomPanel.promptTool'),
    t('butler.roomPanel.promptCitation'),
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

function PrivateNote() {
  const t = useT();
  return <p className="mt-2 text-xs text-ink-3">{t('butler.roomPanel.privateNote')}</p>;
}

function ConversationCopyButton({
  text,
  role,
  align,
}: {
  text: string;
  role: 'user' | 'assistant';
  align: 'left' | 'right';
}) {
  const t = useT();
  const isAssistant = role === 'assistant';
  const copyAria = t(isAssistant ? 'butler.roomPanel.copyAriaAssistant' : 'butler.roomPanel.copyAriaUser');
  const copy = async (): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t('butler.roomPanel.clipboardUnavailable'));
      await navigator.clipboard.writeText(text);
      toast.success(t(isAssistant ? 'butler.roomPanel.copySuccessAssistant' : 'butler.roomPanel.copySuccessUser'));
    } catch (reason) {
      toast.error(reason, t('butler.roomPanel.copyFailed'));
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copyAria}
      title={copyAria}
      className={`absolute bottom-0 flex translate-y-full items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ink-3 opacity-0 transition-opacity hover:bg-fill-hover hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${align === 'right' ? 'right-0' : 'left-0'}`}
    >
      <Copy size={11} aria-hidden="true" /> {t('common.copy')}
    </button>
  );
}

function RoomReplyDraftButton({
  text,
  align,
}: {
  text: string;
  align: 'left' | 'right';
}) {
  const t = useT();
  const payload: ButlerSharePayload = {
    kind: 'reply',
    messageId: `room-reply:${text.slice(0, 24)}`,
    text,
  };
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => writeButlerShareDrag(e.dataTransfer, payload)}
      onClick={() => {
        useUI.getState().seedComposer(text.trim(), 'append');
        toast.info(t('chat.butlerBridge.draftInsertedToast'));
      }}
      title={t('butler.roomPanel.draftToChatTooltip')}
      aria-label={t('butler.roomPanel.draftToChatAria')}
      className={`absolute bottom-0 flex translate-y-full items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ink-3 opacity-0 transition-opacity hover:bg-fill-hover hover:text-primary focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 ${align === 'right' ? 'right-16' : 'left-16'}`}
    >
      <Share2 size={11} aria-hidden="true" /> {t('butler.roomPanel.draftToChatBtn')}
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
  const t = useT();
  return (
    <article
      data-speaker={entry.role}
      draggable={entry.role === 'assistant' && Boolean(entry.text) && !streaming}
      onDragStart={(e) => {
        if (entry.role !== 'assistant' || !entry.text) return;
        writeButlerShareDrag(e.dataTransfer, {
          kind: 'reply',
          messageId: entry.id,
          text: entry.text,
        });
      }}
      className={`codex-native-message group relative${streaming ? ' is-streaming' : ''}`}
    >
      <span>{entry.role === 'assistant' ? 'Pi' : t('butler.speaker.you')}</span>
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
        <>
          <ConversationCopyButton
            text={entry.role === 'user' ? visibleUserText(entry.text) : entry.text}
            role={entry.role}
            align={entry.role === 'user' ? 'right' : 'left'}
          />
          {entry.role === 'assistant' ? (
            <RoomReplyDraftButton text={entry.text} align="left" />
          ) : null}
        </>
      ) : null}
    </article>
  );
}

function CodexRoomConversation({ rid, roomName, scope }: { rid: string; roomName: string; scope: string }) {
  const { t, tp } = useI18n();
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
  const [dragMessageHover, setDragMessageHover] = useState(false);

  const roomDraftSeed = useUI((s) => s.roomButlerDraftSeed);
  useEffect(() => {
    if (!roomDraftSeed || roomDraftSeed.rid !== rid) return;
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${roomDraftSeed.text}` : roomDraftSeed.text));
  }, [rid, roomDraftSeed]);

  const cognitionInsights = useButlerCognition((s) => s.insights);
  const hydrateCognition = useButlerCognition((s) => s.hydrate);
  const markInsightFeedback = useButlerCognition((s) => s.markInsightFeedback);
  const acpSessions = useAcpAgents((s) => s.sessions);
  const roomBindings = useButlerRoomBindings((s) => s.bindings);
  const hydrateBindings = useButlerRoomBindings((s) => s.hydrate);
  const bindToRoom = useButlerRoomBindings((s) => s.bindToRoom);
  const unbindRoom = useButlerRoomBindings((s) => s.unbind);

  useEffect(() => {
    hydrateCognition();
    hydrateBindings();
  }, [hydrateBindings, hydrateCognition]);

  const roomScopedInsights = useMemo(
    () =>
      cognitionInsights
        .filter(
          (ins) =>
            ins.status === 'unread'
            && ins.level !== 'silent_log'
            && (ins.ref?.rid === rid || ins.kind === 'decision'),
        )
        .slice(0, 3),
    [cognitionInsights, rid],
  );
  const liveAcpSessions = useMemo(
    () =>
      Object.values(acpSessions)
        .filter((s) => s.status !== 'stopped')
        .slice(0, 3),
    [acpSessions],
  );
  const activeBindingsForRoom = useMemo(
    () => roomBindings.filter((b) => b.enabled && b.rid === rid),
    [rid, roomBindings],
  );
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
              savedThreadId = await useCodexWorkspace.getState().startThread(t('butler.roomPanel.threadTitle', { roomName }));
              setRoomThreadId(scope, rid, savedThreadId);
            }
          }
        } else {
          savedThreadId = await useCodexWorkspace.getState().startThread(t('butler.roomPanel.threadTitle', { roomName }));
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
      const nextThreadId = await useCodexWorkspace.getState().startThread(t('butler.roomPanel.threadTitle', { roomName }));
      setRoomThreadId(scope, rid, nextThreadId);
      setThreadId(nextThreadId);
      setInput('');
      stickToBottom.current = true;
    } catch (reason) {
      setRoomError(reason instanceof Error ? reason.message : String(reason));
      toast.error(reason, t('butler.roomPanel.createFailed'));
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
        currentThreadId = await workspace.startThread(t('butler.roomPanel.threadTitle', { roomName }));
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
      toast.error(reason, t('butler.roomPanel.sendFailed'));
    }
  };

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col transition-colors ${dragMessageHover ? 'bg-primary-light/20' : ''}`}
      onDragOver={(event) => {
        if (!hasChatToButlerDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        setDragMessageHover(true);
      }}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          setDragMessageHover(false);
        }
      }}
      onDrop={(event) => {
        const payload = readChatToButlerDrag(event.dataTransfer);
        setDragMessageHover(false);
        if (!payload) return;
        event.preventDefault();
        event.stopPropagation();
        const promptText = formatChatMessagesForButlerPrompt(payload);
        setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${promptText}` : promptText));
      }}
    >
      <div className="shrink-0 border-b border-line-soft bg-fill-1 px-4 py-2.5 text-xs">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              onClick={openFullConversation}
              aria-label={t('butler.roomPanel.settingsAria')}
              title={t('butler.roomPanel.settingsTitle')}
              className="flex min-w-0 max-w-40 items-center gap-1 rounded bg-surface px-2 py-0.5 text-ink-2 hover:bg-fill-hover"
            >
              <Settings size={11} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{modelLabel}</span>
            </button>
            <span className="shrink-0 whitespace-nowrap rounded bg-surface px-2 py-0.5 text-ink-2">{t('butler.roomPanel.privateBadge')}</span>
          </div>
          <button
            type="button"
            disabled={loadingRoom || running}
            onClick={() => void newConversation()}
            aria-label={t('butler.roomPanel.newChatAria')}
            title={running ? t('butler.roomPanel.newChatDisabledTitle') : t('butler.roomPanel.newChatTitle')}
            className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface text-ink-2 hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MessageSquarePlus size={14} aria-hidden="true" />
          </button>
        </div>
        <div className="mt-1.5 truncate text-ink-3" title={butlerWorkspaceRoot || workspaceRoot}>
          {butlerWorkspaceRoot || workspaceRoot || t('butler.roomPanel.butlerDirFallback')}
        </div>
        {dragMessageHover ? (
          <div className="mt-2 rounded-lg border border-dashed border-primary bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary">
            {t('butler.roomPanel.dropMessageHint')}
          </div>
        ) : null}
        {(roomScopedInsights.length > 0 || liveAcpSessions.length > 0) ? (
          <div className="mt-2 space-y-1.5 border-t border-line-soft pt-2">
            <div className="flex items-center justify-between text-ink-3">
              <span className="flex items-center gap-1 font-medium text-ink-2">
                <Bell size={11} className="text-primary" aria-hidden="true" />
                {t('butler.roomPanel.collabBarTitle')}
              </span>
              <span>{t('butler.roomPanel.dragLeftHint')}</span>
            </div>
            {roomScopedInsights.map((ins) => {
              const payload: ButlerSharePayload = {
                kind: 'insight',
                id: ins.id,
                insightKind: ins.kind,
                title: ins.title,
                summary: ins.summary,
                suggestedActions: ins.suggestedActions?.map((a) => a.label),
                ref: ins.ref,
              };
              return (
                <div
                  key={ins.id}
                  draggable
                  onDragStart={(e) => writeButlerShareDrag(e.dataTransfer, payload)}
                  className="flex items-center justify-between gap-2 rounded-lg border border-primary/25 bg-surface px-2 py-1 cursor-grab active:cursor-grabbing"
                >
                  <span className="flex min-w-0 items-center gap-1 text-ink">
                    <GripVertical size={11} className="shrink-0 text-ink-3" aria-hidden="true" />
                    <span className="truncate font-medium">{ins.title}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      useUI.getState().seedComposer(formatSharePayloadForChat(payload), 'append');
                      markInsightFeedback(ins.id, 'acted');
                      toast.info(t('chat.butlerBridge.draftInsertedToast'));
                    }}
                    className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/25"
                  >
                    {t('butler.roomPanel.draftToChatBtn')}
                  </button>
                </div>
              );
            })}
            {liveAcpSessions.map((sess) => {
              const existingBinding = activeBindingsForRoom.find(
                (b) => b.targetKind === 'acp_session' && b.targetId === sess.sessionKey,
              );
              const payload: ButlerSharePayload = {
                kind: 'acp_session',
                sessionKey: sess.sessionKey,
                agentId: sess.agentId,
                agentName: sess.agentName,
                title: sess.title,
                status: sess.status,
                summary: [...sess.messages].reverse().find((m) => m.role === 'assistant')?.text.slice(0, 220) || sess.title,
                pendingApproval: sess.pendingPermissions[0]?.toolCall.title || sess.pendingPermissions[0]?.reason,
                workspaceRoot: sess.workspaceRoot,
              };
              return (
                <div
                  key={sess.sessionKey}
                  draggable
                  onDragStart={(e) => writeButlerShareDrag(e.dataTransfer, payload)}
                  className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2 py-1 cursor-grab active:cursor-grabbing"
                >
                  <span className="flex min-w-0 items-center gap-1 text-ink-2">
                    <Cpu size={11} className="shrink-0 text-primary" aria-hidden="true" />
                    <span className="truncate">{sess.agentName}: {sess.title}</span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (existingBinding) {
                          unbindRoom(existingBinding.id);
                          toast.info(t('butler.chatShare.unboundRoomToast', { room: roomName }));
                        } else {
                          bindToRoom({
                            targetKind: 'acp_session',
                            targetId: sess.sessionKey,
                            label: `${sess.agentName}: ${sess.title}`,
                            rid,
                            roomName,
                            autoPost: true,
                          });
                          toast.success(t('butler.chatShare.boundRoomToast', { room: roomName }));
                        }
                      }}
                      className={`inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs ${
                        existingBinding ? 'bg-primary text-white' : 'border border-line text-ink-3 hover:text-ink'
                      }`}
                    >
                      <Radio size={10} aria-hidden="true" />
                      {t(existingBinding ? 'butler.chatShare.boundLabel' : 'butler.chatShare.bindStream')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        useUI.getState().seedComposer(formatSharePayloadForChat(payload), 'append');
                        toast.info(t('chat.butlerBridge.draftInsertedToast'));
                      }}
                      className="rounded bg-fill-hover px-1.5 py-0.5 text-xs text-ink-2 hover:text-ink"
                    >
                      {t('butler.roomPanel.draftToChatBtn')}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loadingRoom ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-ink-3">
            <Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {t('butler.roomPanel.loading')}
          </div>
        ) : !desktopRuntime ? (
          <div className="rounded-xl border border-line bg-fill-1 p-4 text-sm leading-6 text-ink-2">
            {t('butler.roomPanel.desktopRequired')}
          </div>
        ) : messages.length === 0 && !streamingText && !running ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-light text-primary">
              <MessageCircle size={21} aria-hidden="true" />
            </span>
            <h3 className="mt-3 text-sm font-semibold text-ink">{t('butler.roomPanel.emptyTitle')}</h3>
            <p className="mt-1 max-w-72 text-xs leading-5 text-ink-3">
              {t('butler.roomPanel.emptyDesc')}
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
                  {t('butler.roomPanel.thinking')}
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
            <span>{tp(pendingRequests.length, 'butler.roomPanel.pendingApprovalOne', 'butler.roomPanel.pendingApprovalOther')}</span>
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
              aria-label={t('butler.roomPanel.inputAria')}
              placeholder={running ? t('butler.roomPanel.inputPlaceholderRunning') : t('butler.roomPanel.inputPlaceholder')}
              rows={1}
              autoFocus
              className="min-h-8 max-h-28 min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm leading-5 text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
            />
            <button
              type="submit"
              disabled={!canCompose || !input.trim()}
              aria-label={t('butler.roomPanel.sendAria')}
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

function DisabledRoomConversation() {
  const t = useT();
  const setModule = useUI((state) => state.setModule);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <CircleAlert size={23} className="text-ink-3" aria-hidden="true" />
      <h3 className="mt-3 text-sm font-semibold text-ink">{t('butler.roomPanel.disabledTitle')}</h3>
      <p className="mt-1 max-w-sm text-xs leading-5 text-ink-3">
        {t('butler.roomPanel.disabledDesc')}
      </p>
      <button
        type="button"
        onClick={() => {
          useChat.getState().setPanel(null);
          setModule('settings');
        }}
        className="mt-3 flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink-2 hover:bg-fill-hover"
      >
        <Settings size={14} aria-hidden="true" /> {t('butler.roomPanel.aiSettings')}
      </button>
    </div>
  );
}

export default function ButlerPanel() {
  const t = useT();
  const rid = useChat((state) => state.activeRid);
  const room = useChat((state) => (state.activeRid ? state.rooms[state.activeRid] : undefined));
  const subscription = useChat((state) => (
    state.activeRid ? state.subscriptions[state.activeRid] : undefined
  ));
  const userId = useAuth((state) => state.user?._id);
  const localMode = useAuth((state) => state.localMode);
  const runtimeScope = useCodexWorkspace((state) => state.scope);
  const provider = useUI((state) => state.aiRuntimeProvider);
  const scope = userId ? `${getServerBase() || 'same-origin'}:${userId}` : (localMode ? 'local:workspace' : '');
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
      aria-label={t('butler.roomPanel.dialogAria')}
      className="absolute inset-y-0 right-0 z-30 flex max-w-full justify-end overflow-hidden"
    >
      <PanelShell
        resizable
        title={(
          <span className="flex min-w-0 items-center gap-2">
            <MessageCircle size={17} className="shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">{t('butler.roomPanel.title', { name })}</span>
          </span>
        )}
      >
        {!scope || provider === 'none' ? (
          <DisabledRoomConversation />
        ) : (
          <CodexRoomConversation key={`codex:${scope}:${rid}`} rid={rid} roomName={name} scope={scope} />
        )}
      </PanelShell>
    </div>
  );
}
