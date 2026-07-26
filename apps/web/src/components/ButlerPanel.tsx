import { SendHorizontal, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { partitionButlerPaperErrands } from '../lib/butlerPaper';
import type { ButlerImageInput } from '../lib/butlerImages';
import { BUTLER_BOUNDARY_NOTE, BUTLER_SCENE_PROMPTS } from '../lib/butlerPrompts';
import { useAuth } from '../stores/auth';
import { useButler } from '../stores/butler';
import { useChat } from '../stores/chat';
import ButlerErrandRunCard, { ButlerErrandStatusLine } from './ButlerErrandRunCard';
import ButlerImagePicker, {
  ButlerImagePreviews,
  pasteButlerImages,
} from './ButlerImagePicker';
import ButlerInlineExchange from './ButlerInlineExchange';
import PanelShell from './PanelShell';

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
  const lines = useButler((state) => state.lines);
  const errands = useButler((state) => state.errands);
  const activity = useButler((state) => state.activity);
  const running = useButler((state) => state.running);
  const ask = useButler((state) => state.ask);
  const stop = useButler((state) => state.stop);
  const hydrate = useButler((state) => state.hydrate);
  const userId = useAuth((state) => state.user?._id);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<ButlerImageInput[]>([]);
  const sections = useMemo(() => partitionButlerPaperErrands(errands), [errands]);
  const hasConversation = lines.some((line) => line.role === 'user');

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
    await ask(text, { rid, roomName: roomName(rid, subscription, room) }, submittedImages);
  };

  return (
    <PanelShell title="AI" resizable>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-4">
        <ButlerErrandStatusLine sections={sections} />
        {errands.some((errand) => !errand.archivedAt) ? (
          <div className="mt-4">
            <ButlerErrandRunCard compact />
          </div>
        ) : null}

        {hasConversation ? (
          <div className="mt-5">
            <ButlerInlineExchange lines={lines} running={running} activity={activity} />
          </div>
        ) : errands.every((errand) => errand.archivedAt) ? (
          <div className="mt-7">
            <p className="text-sm leading-6 text-ink-3">问我当前房间的讨论，或跟我说件要办的事。</p>
            <div className="mt-3 flex flex-col gap-1">
              {BUTLER_SCENE_PROMPTS.map((item) => (
                <button
                  key={item.scene}
                  type="button"
                  onClick={() => setInput(item.prompt)}
                  className="px-2 py-1 text-left text-xs text-ink-2 hover:text-ink"
                >
                  <span className="mr-1.5 text-ink-3">{item.scene}</span>
                  {item.prompt}
                </button>
              ))}
            </div>
            <div className="mt-2.5 border-t border-line pt-2 text-xs text-ink-3">{BUTLER_BOUNDARY_NOTE}</div>
          </div>
        ) : null}
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="shrink-0 px-3 pb-3">
        <ButlerImagePreviews images={images} onChange={setImages} />
        <div className="flex items-end gap-2 border-b border-line px-1 focus-within:border-primary">
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
          {running ? (
            <button
              type="button"
              title="停止回答"
              onClick={() => void stop()}
              className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center text-ink hover:text-primary"
            >
              <Square size={12} />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="发送"
              disabled={!input.trim() && !images.length}
              className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center text-primary hover:text-primary-hover disabled:text-ink-3/40"
            >
              <SendHorizontal size={14} />
            </button>
          )}
        </div>
      </form>
    </PanelShell>
  );
}
