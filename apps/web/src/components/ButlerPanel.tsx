import { Bot, Maximize2, SendHorizontal, Square, X } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  MAX_BUTLER_PANEL_WIDTH,
  MIN_BUTLER_PANEL_WIDTH,
  clampButlerPanelWidth,
} from '../lib/imLayout';
import type { ButlerSurfaceContext } from '../lib/butlerContext';
import { partitionButlerPaperErrands } from '../lib/butlerPaper';
import type { ButlerImageInput } from '../lib/butlerImages';
import { useAuth } from '../stores/auth';
import { useButler, type ButlerLine } from '../stores/butler';
import { useChat } from '../stores/chat';
import { useImLayout } from '../stores/imLayout';
import { useUI } from '../stores/ui';
import ButlerErrandRunCard, { ButlerErrandStatusLine } from './ButlerErrandRunCard';
import ButlerImagePicker, {
  ButlerImagePreviews,
  pasteButlerImages,
} from './ButlerImagePicker';
import ButlerInlineExchange from './ButlerInlineExchange';

function roomName(
  rid: string,
  subscription: { fname?: string; name?: string } | undefined,
  room: { fname?: string; name?: string } | undefined,
): string {
  return subscription?.fname || subscription?.name || room?.fname || room?.name || rid;
}

export default function ButlerPanel() {
  const rid = useChat((state) => state.activeRid);
  const subscription = useChat((state) => (state.activeRid ? state.subscriptions[state.activeRid] : undefined));
  const room = useChat((state) => (state.activeRid ? state.rooms[state.activeRid] : undefined));
  const activity = useButler((state) => state.activity);
  const butlerContext = useButler((state) => state.context);
  const butlerLines = useButler((state) => state.lines);
  const butlerErrands = useButler((state) => state.errands);
  const running = useButler((state) => state.running);
  const ask = useButler((state) => state.ask);
  const stop = useButler((state) => state.stop);
  const hydrate = useButler((state) => state.hydrate);
  const setPanel = useChat((state) => state.setPanel);
  const savedWidth = useImLayout((state) => state.layout.butlerPanelWidth);
  const setButlerPanelWidth = useImLayout((state) => state.setButlerPanelWidth);
  const resetButlerPanelWidth = useImLayout((state) => state.resetButlerPanelWidth);
  const userId = useAuth((state) => state.user?._id);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<ButlerImageInput[]>([]);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const resizeStart = useRef<{
    x: number;
    width: number;
    currentWidth: number;
    moved: boolean;
  } | null>(null);
  const panelWidth = dragWidth ?? savedWidth;
  const roomContext = useMemo<{ rid: string; roomName: string } | null>(
    () => (rid ? { rid, roomName: roomName(rid, subscription, room) } : null),
    [rid, room, subscription],
  );
  const roomExchanges = useMemo(
    () => (rid ? roomConversationExchanges(butlerLines, rid) : []),
    [butlerLines, rid],
  );
  const roomErrands = useMemo(
    () => (rid ? butlerErrands.filter((errand) => errand.roomContext?.rid === rid) : []),
    [butlerErrands, rid],
  );
  const sections = useMemo(() => partitionButlerPaperErrands(roomErrands), [roomErrands]);
  const hasConversation = roomExchanges.some((exchange) => exchange.some((line) => line.role === 'user'));
  const roomRunning = running && !!rid && contextHasRoomSource(butlerContext, rid);
  const openFullConversation = (): void => {
    const context: ButlerSurfaceContext | null = roomContext
      ? {
        kind: 'room',
        label: roomContext.roomName,
        detail: '当前 Rocket.Chat 房间',
        sources: [{ kind: 'room', id: roomContext.rid, rid: roomContext.rid, label: roomContext.roomName }],
      }
      : null;
    setPanel(null);
    useUI.getState().openButlerConversation();
    // 模块切换会触发完整对话的挂载与会话恢复；最后写入房间上下文，
    // 保证全屏页不会被恢复过程覆盖成普通管家入口。
    if (context) useButler.getState().setContext(context);
  };

  useEffect(() => {
    if (userId) void hydrate();
  }, [hydrate, userId]);

  if (!rid) return null;

  const submit = async (): Promise<void> => {
    const text = input.trim();
    if ((!text && !images.length) || running) return;
    const submittedImages = images;
    setInput('');
    setImages([]);
    await ask(text, roomContext ?? { rid, roomName: roomName(rid, subscription, room) }, submittedImages);
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
      aria-label="房间管家"
      style={{ width: `min(${panelWidth}px, calc(100% - 1.5rem))` }}
      className="absolute top-4 right-3 bottom-28 z-30 flex flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_24px_64px_-24px_rgba(0,0,0,0.78),0_8px_20px_-12px_rgba(0,0,0,0.55)]"
    >
      <div
        role="separator"
        aria-label="调整房间管家宽度"
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

      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line-soft bg-surface px-4 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-light text-primary">
            <Bot size={18} />
          </span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-ink">房间管家</h2>
            <p className="truncate text-xs text-ink-3">
              只看 {roomContext?.roomName ?? '这个房间'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={openFullConversation}
            aria-label="全屏打开完整对话"
            title="全屏打开完整对话"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            <Maximize2 size={15} />
          </button>
          <button
            type="button"
            onClick={() => setPanel(null)}
            aria-label="关闭房间管家"
            title="关闭"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            <X size={17} />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface px-4 py-4">
        {sections.approvals.length > 0 || sections.active.length > 0 ? (
          <div>
            <ButlerErrandStatusLine sections={sections} />
          </div>
        ) : null}
        {roomErrands.some((errand) => !errand.archivedAt) ? (
          <div className="mt-5">
            <ButlerErrandRunCard runs={roomErrands} compact />
          </div>
        ) : null}

        {hasConversation ? (
          <div className="mt-6 space-y-5">
            {roomExchanges.map((exchange, index) => (
              <ButlerInlineExchange
                key={exchange[0]?.id ?? index}
                lines={exchange}
                running={roomRunning && index === roomExchanges.length - 1}
                activity={roomRunning && index === roomExchanges.length - 1 ? activity : null}
              />
            ))}
          </div>
        ) : roomErrands.every((errand) => errand.archivedAt) ? (
          <div className="mt-6 border-l border-line pl-3">
            <p className="text-sm leading-6 text-ink-3">
              这个房间还没有管家记录。有事直接在下面说。
            </p>
          </div>
        ) : null}
      </div>

      <form
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
        className="shrink-0 border-t border-line-soft bg-surface p-3"
      >
        <ButlerImagePreviews images={images} onChange={setImages} />
        <div className="flex items-end gap-2 rounded-xl border border-line bg-fill-2 px-2 shadow-sm transition-colors focus-within:border-primary">
          <ButlerImagePicker images={images} onChange={setImages} disabled={running} compact />
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onPaste={(event) => void pasteButlerImages(event, images, setImages)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={1}
            placeholder="问问这个房间的讨论…"
            className="max-h-28 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-ink-3"
          />
          {roomRunning ? (
            <button
              type="button"
              aria-label="停止回答"
              title="停止回答"
              onClick={() => void stop()}
              className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center text-ink hover:text-primary"
            >
              <Square size={12} />
            </button>
          ) : (
            <button
              type="submit"
              aria-label={running ? '管家正在处理其他内容' : '发送'}
              title={running ? '管家正在处理其他内容' : '发送'}
              disabled={running || (!input.trim() && !images.length)}
              className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center text-primary hover:text-primary-hover disabled:text-ink-3/40"
            >
              <SendHorizontal size={14} />
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

function lineHasRoomSource(line: ButlerLine, rid: string): boolean {
  return line.sources?.some((source) => source.rid === rid || (source.kind === 'room' && source.id === rid)) ?? false;
}

function roomConversationExchanges(lines: readonly ButlerLine[], rid: string): ButlerLine[][] {
  const exchanges: ButlerLine[][] = [];
  let exchange: ButlerLine[] = [];

  for (const line of lines) {
    if (line.role === 'user' && exchange.length) {
      exchanges.push(exchange);
      exchange = [];
    }
    exchange.push(line);
  }
  if (exchange.length) exchanges.push(exchange);

  return exchanges.flatMap((candidate) => {
    const relatedIndex = candidate.findIndex((line) => lineHasRoomSource(line, rid));
    if (relatedIndex < 0) return [];
    const userIndex = candidate.findIndex((line) => line.role === 'user');
    const start = userIndex >= 0 && userIndex <= relatedIndex ? userIndex : relatedIndex;
    const related = candidate.slice(start).filter((line, index) => {
      if (index === 0 && line.role === 'user') return true;
      if (line.sources?.length) return lineHasRoomSource(line, rid);
      return line.role !== 'assistant' || !/^(?:📌|✅)/u.test(line.text.trim());
    });
    return related.some((line) => line.role === 'user') ? [related] : [];
  });
}

function contextHasRoomSource(
  context: ReturnType<typeof useButler.getState>['context'],
  rid: string,
): boolean {
  return context?.sources.some(
    (source) => source.rid === rid || (source.kind === 'room' && source.id === rid),
  ) ?? false;
}
