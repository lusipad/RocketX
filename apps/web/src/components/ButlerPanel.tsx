import { ArrowUpRight, Bot, SendHorizontal, Square, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { partitionButlerPaperErrands } from '../lib/butlerPaper';
import type { ButlerImageInput } from '../lib/butlerImages';
import { useAuth } from '../stores/auth';
import { useButler, type ButlerLine } from '../stores/butler';
import { useChat } from '../stores/chat';
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
  const userId = useAuth((state) => state.user?._id);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<ButlerImageInput[]>([]);
  const roomContext = useMemo(
    () => (rid ? { rid, roomName: roomName(rid, subscription, room) } : null),
    [rid, room, subscription],
  );
  const roomLines = useMemo(
    () => (rid ? latestRoomExchange(butlerLines, rid) : []),
    [butlerLines, rid],
  );
  const roomErrands = useMemo(
    () => (rid ? butlerErrands.filter((errand) => errand.roomContext?.rid === rid) : []),
    [butlerErrands, rid],
  );
  const sections = useMemo(() => partitionButlerPaperErrands(roomErrands), [roomErrands]);
  const hasConversation = roomLines.some((line) => line.role === 'user');
  const roomRunning = running && !!rid && contextHasRoomSource(butlerContext, rid);

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

  return (
    <aside
      id="room-butler-panel"
      role="dialog"
      aria-modal="false"
      aria-label="房间管家"
      className="absolute top-4 right-3 bottom-28 z-30 flex w-[min(420px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_24px_64px_-24px_rgba(0,0,0,0.78),0_8px_20px_-12px_rgba(0,0,0,0.55)]"
    >
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
            onClick={() => {
              setPanel(null);
              useUI.getState().openButlerPaper();
            }}
            aria-label="查看全部管家事项"
            title="查看全部管家事项"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            <ArrowUpRight size={15} />
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
          <div className="mt-6">
            <ButlerInlineExchange
              lines={roomLines}
              running={roomRunning}
              activity={roomRunning ? activity : null}
            />
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

function latestRoomExchange(lines: readonly ButlerLine[], rid: string): ButlerLine[] {
  let relatedIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lineHasRoomSource(lines[index], rid)) {
      relatedIndex = index;
      break;
    }
  }
  if (relatedIndex < 0) return [];

  let start = relatedIndex;
  while (start > 0 && lines[start].role !== 'user') start -= 1;
  if (lines[start].role !== 'user') start = relatedIndex;

  let end = start + 1;
  while (end < lines.length && lines[end].role !== 'user') end += 1;
  return lines.slice(start, end).filter((line, index) => {
    if (index === 0 && line.role === 'user') return true;
    if (line.sources?.length) return lineHasRoomSource(line, rid);
    return line.role !== 'assistant' || !/^(?:📌|✅)/u.test(line.text.trim());
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
