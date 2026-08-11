import {
  ArrowUpRight,
  Bot,
  Loader2,
  MessageSquarePlus,
  SendHorizontal,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { isTauriRuntime } from '../lib/client';
import {
  MAX_BUTLER_PANEL_WIDTH,
  MIN_BUTLER_PANEL_WIDTH,
  clampButlerPanelWidth,
} from '../lib/imLayout';
import { renderMarkdown } from '../lib/markdown';
import { useStickToBottom } from '../lib/stickToBottom';
import { useChat } from '../stores/chat';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useImLayout } from '../stores/imLayout';
import { useUI } from '../stores/ui';
import { toast } from '../stores/toast';
import ButlerSources from './ButlerSources';
import { CodexGeneratedImages, CodexImageAttachments } from './CodexImagePicker';

const ROOM_THREAD_STORAGE_KEY = 'rcx-room-codex-threads-v1';
const ROOM_MESSAGE_SEPARATOR = '\n\n<<<ROCKETX_ROOM_MESSAGE>>>\n';

function roomName(
  rid: string,
  subscription: { fname?: string; name?: string } | undefined,
  room: { fname?: string; name?: string } | undefined,
): string {
  return subscription?.fname || subscription?.name || room?.fname || room?.name || rid;
}

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

async function prepareRoomWorkspace(targetThreadId?: string): Promise<boolean> {
  const workspace = useCodexWorkspace.getState();
  const defaultRoot = workspace.defaultWorkspaceRoot || await workspace.ensureDefaultWorkspace();
  if (!defaultRoot) throw new Error('系统临时工作区尚未准备好');
  const latest = useCodexWorkspace.getState();
  const busy = Boolean(latest.activeTurnId)
    || latest.status === 'running'
    || latest.status === 'waiting-input';
  if (busy && (latest.workspaceRoot !== defaultRoot || latest.activeThreadId !== targetThreadId)) {
    if (latest.workspaceRoot === latest.butlerWorkspaceRoot) {
      throw new Error('AI 管家正在处理任务；完成后即可打开房间会话');
    }
    throw new Error('另一个 Codex 任务正在运行；它完成后再打开这个房间会话');
  }
  if (latest.workspaceRoot !== defaultRoot) {
    await latest.setWorkspaceRoot(defaultRoot, { reuseRuntime: true });
  }
  const current = useCodexWorkspace.getState();
  if (
    current.status === 'idle'
    || current.status === 'interrupted'
    || current.status === 'unavailable'
  ) {
    await current.connect({ refreshThreads: false });
    return true;
  }
  return false;
}

function roomPrompt(roomTitle: string, rid: string, question: string): string {
  return [
    `请在 Rocket.Chat 房间「${roomTitle}」（rid: ${rid}）的语境中回答。`,
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

/** 房间里的轻量 Codex 会话；普通聊天固定使用系统临时工作区。 */
export default function ButlerPanel() {
  const rid = useChat((state) => state.activeRid);
  const subscription = useChat((state) => (
    state.activeRid ? state.subscriptions[state.activeRid] : undefined
  ));
  const room = useChat((state) => (state.activeRid ? state.rooms[state.activeRid] : undefined));
  const setPanel = useChat((state) => state.setPanel);
  const scope = useCodexWorkspace((state) => state.scope);
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const activeThreadId = useCodexWorkspace((state) => state.activeThreadId);
  const status = useCodexWorkspace((state) => state.status);
  const messages = useCodexWorkspace((state) => state.messages);
  const streamingText = useCodexWorkspace((state) => state.streamingText);
  const pendingRequests = useCodexWorkspace((state) => state.pendingRequests);
  const error = useCodexWorkspace((state) => state.error);
  const savedWidth = useImLayout((state) => state.layout.butlerPanelWidth);
  const setButlerPanelWidth = useImLayout((state) => state.setButlerPanelWidth);
  const resetButlerPanelWidth = useImLayout((state) => state.resetButlerPanelWidth);
  const [input, setInput] = useState('');
  const [loadingRoom, setLoadingRoom] = useState(true);
  const [roomError, setRoomError] = useState<string>();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const resizeStart = useRef<{
    x: number;
    width: number;
    currentWidth: number;
    moved: boolean;
  } | null>(null);
  const panelWidth = dragWidth ?? savedWidth;
  const currentRoomName = useMemo(
    () => rid ? roomName(rid, subscription, room) : '',
    [rid, room, subscription],
  );
  const { scrollRef, onScroll, stickToBottom } = useStickToBottom([
    rid,
    messages,
    streamingText,
    pendingRequests,
  ]);
  const desktopRuntime = isTauriRuntime();
  const running = status === 'running' || status === 'waiting-input';
  const savedRoomThreadId = rid && scope ? roomThreadId(scope, rid) : undefined;
  const blockingRoomLoad = loadingRoom && (!savedRoomThreadId || activeThreadId !== savedRoomThreadId);
  const canCompose = desktopRuntime
    && !loadingRoom
    && !roomError
    && Boolean(workspaceRoot)
    && !['idle', 'connecting', 'interrupted', 'external', 'unavailable'].includes(status);

  useEffect(() => {
    if (!rid || !scope || !desktopRuntime) {
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
        const savedThreadId = roomThreadId(scope, rid);
        const runtimeReconnected = await prepareRoomWorkspace(savedThreadId);
        if (cancelled) return;
        if (savedThreadId) {
          const current = useCodexWorkspace.getState();
          if (runtimeReconnected || current.activeThreadId !== savedThreadId) {
            try {
              await current.resumeThread(savedThreadId);
            } catch (reason) {
              if (cancelled) return;
              const detail = reason instanceof Error ? reason.message : String(reason);
              if (!/not found|unknown thread|不存在|找不到/i.test(detail)) throw reason;
              setRoomThreadId(scope, rid);
              const threadId = await useCodexWorkspace.getState().startThread(`${currentRoomName} · 对话`);
              setRoomThreadId(scope, rid, threadId);
            }
          }
        } else {
          const threadId = await useCodexWorkspace.getState().startThread(`${currentRoomName} · 对话`);
          setRoomThreadId(scope, rid, threadId);
        }
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
  }, [currentRoomName, desktopRuntime, rid, scope, scrollRef, stickToBottom]);

  if (!rid) return null;

  const openTasks = (): void => {
    setPanel(null);
    useUI.getState().openButlerConversation();
  };

  const newConversation = async (): Promise<void> => {
    if (running) return;
    setLoadingRoom(true);
    setRoomError(undefined);
    try {
      await prepareRoomWorkspace();
      const threadId = await useCodexWorkspace.getState().startThread(`${currentRoomName} · 对话`);
      setRoomThreadId(scope, rid, threadId);
      setInput('');
      stickToBottom.current = true;
    } catch (reason) {
      setRoomError(reason instanceof Error ? reason.message : String(reason));
      toast.error(reason, '无法新建会话');
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
      let threadId = roomThreadId(scope, rid);
      const runtimeReconnected = await prepareRoomWorkspace(threadId);
      const workspace = useCodexWorkspace.getState();
      if (!threadId) {
        threadId = await workspace.startThread(`${currentRoomName} · 对话`);
        setRoomThreadId(scope, rid, threadId);
      } else if (runtimeReconnected || workspace.activeThreadId !== threadId) {
        await workspace.resumeThread(threadId);
      }
      const firstMessage = useCodexWorkspace.getState().messages.length === 0;
      await useCodexWorkspace.getState().send(
        firstMessage ? roomPrompt(currentRoomName, rid, question) : question,
      );
    } catch (reason) {
      setInput(question);
      setRoomError(reason instanceof Error ? reason.message : String(reason));
      toast.error(reason, '消息没有发出');
    }
  };

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    resizeStart.current = {
      x: event.clientX,
      width: panelWidth,
      currentWidth: panelWidth,
      moved: false,
    };
    setDragWidth(panelWidth);
  };

  const onResizePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const start = resizeStart.current;
    if (!start) return;
    const next = clampButlerPanelWidth(start.width + start.x - event.clientX);
    if (next !== start.width) start.moved = true;
    start.currentWidth = next;
    setDragWidth(next);
  };

  const finishResize = (): void => {
    const start = resizeStart.current;
    if (start?.moved) setButlerPanelWidth(start.currentWidth);
    resizeStart.current = null;
    setDragWidth(null);
  };

  return (
    <aside
      id="room-butler-panel"
      role="dialog"
      aria-modal="false"
      aria-label="房间 Codex 会话"
      style={{ width: `min(${panelWidth}px, calc(100% - 1.5rem))` }}
      className="absolute top-4 right-3 bottom-28 z-30 flex flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_24px_64px_-24px_rgba(0,0,0,0.78),0_8px_20px_-12px_rgba(0,0,0,0.55)]"
    >
      <div
        role="separator"
        aria-label="调整房间 Codex 会话宽度"
        aria-orientation="vertical"
        aria-valuemin={MIN_BUTLER_PANEL_WIDTH}
        aria-valuemax={MAX_BUTLER_PANEL_WIDTH}
        aria-valuenow={panelWidth}
        tabIndex={0}
        title="拖动调整宽度，双击恢复默认"
        onDoubleClick={resetButlerPanelWidth}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            setButlerPanelWidth(panelWidth + (event.key === 'ArrowLeft' ? 10 : -10));
          } else if (event.key === 'Home') {
            event.preventDefault();
            resetButlerPanelWidth();
          }
        }}
        style={{ touchAction: 'none' }}
        className="group absolute inset-y-0 left-0 z-10 flex w-2 cursor-col-resize items-stretch justify-center outline-none"
      >
        <span className="my-auto h-10 w-px rounded-full bg-line-strong transition-colors group-hover:bg-primary group-focus:bg-primary" />
      </div>

      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line-soft px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-light text-primary">
            <Bot size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">在 Codex 中处理</h2>
            <p className="truncate text-xs text-ink-3">{currentRoomName}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={loadingRoom || running}
            onClick={() => void newConversation()}
            aria-label="新建房间会话"
            title={running ? '当前任务完成后再新建会话' : '新会话，不带入当前上下文'}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MessageSquarePlus size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setPanel(null)}
            aria-label="关闭房间会话"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            <X size={17} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {blockingRoomLoad ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-ink-3">
            <Loader2 size={20} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
            正在接回房间会话
          </div>
        ) : !desktopRuntime ? (
          <div className="rounded-xl border border-line bg-fill-1 p-4 text-sm leading-6 text-ink-2">
            网页版可以继续使用聊天，但本地 Codex 会话需要 RocketX 桌面端。
          </div>
        ) : messages.length === 0 && !streamingText && !running ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-light text-primary">
              <Bot size={21} aria-hidden="true" />
            </span>
            <h3 className="mt-3 text-sm font-semibold text-ink">直接在这里继续</h3>
            <p className="mt-1 max-w-72 text-xs leading-5 text-ink-3">
              当前房间使用系统临时工作区。Codex 会在这个会话里保留上下文；需要清空时点击右上角的新会话按钮。
            </p>
          </div>
        ) : (
          <div className="codex-native-transcript-inner" aria-live="polite">
            {messages.map((entry) => (
              <article key={entry.id} data-speaker={entry.role} className="codex-native-message">
                <span>{entry.role === 'assistant' ? 'Codex' : '你'}</span>
                <div className="butler-conversation-markdown">
                  {entry.text
                    ? entry.role === 'assistant'
                      ? (
                          <ButlerSources sources={entry.sources} text={entry.text}>
                            {(renderLink) => renderMarkdown(entry.text, undefined, renderLink)}
                          </ButlerSources>
                        )
                      : visibleUserText(entry.text)
                    : null}
                  <CodexImageAttachments attachments={entry.attachments} />
                  <CodexGeneratedImages images={entry.generatedImages} />
                </div>
              </article>
            ))}
            {streamingText ? (
              <article data-speaker="assistant" className="codex-native-message is-streaming">
                <span>Codex</span>
                <div className="butler-conversation-markdown">{renderMarkdown(streamingText)}</div>
              </article>
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

      <div className="shrink-0 border-t border-line-soft bg-surface px-4 pt-3 pb-4">
        {pendingRequests.length > 0 ? (
          <button
            type="button"
            onClick={openTasks}
            className="mb-3 flex w-full items-center justify-between rounded-lg border border-warning/30 bg-warning-light px-3 py-2 text-left text-xs text-ink-2"
          >
            <span>Codex 正在等待你处理 {pendingRequests.length} 项确认</span>
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        ) : null}
        {roomError || error ? (
          <p className="mb-2 text-xs leading-5 text-danger" role="alert">{roomError || error}</p>
        ) : null}
        <div className="mb-2 flex items-center justify-between gap-3 text-xs text-ink-3">
          <span className="min-w-0 truncate" title={workspaceRoot || undefined}>
            {workspaceRoot ? `临时工作区：${workspaceRoot}` : '临时工作区尚未准备好'}
          </span>
          <button type="button" onClick={openTasks} className="shrink-0 text-primary hover:text-primary-hover">
            查看完整任务
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="rounded-xl border border-line bg-fill-2 p-2 shadow-sm"
        >
          <textarea
            data-composer-input
            value={input}
            disabled={!canCompose}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder={running ? '输入后续要求，立即调整当前任务' : '在这个会话里继续提问'}
            className="max-h-32 w-full resize-none bg-transparent px-1 py-1.5 text-sm leading-6 outline-none placeholder:text-ink-3 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!input.trim() || !canCompose}
              aria-label="发送到房间 Codex 会话"
              className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <SendHorizontal size={14} aria-hidden="true" />
              发送
            </button>
          </div>
        </form>
      </div>
    </aside>
  );
}
