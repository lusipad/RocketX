import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bot, Loader2, MessageSquarePlus, SendHorizontal, Square } from 'lucide-react';
import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { useButler } from '../stores/butler';
import { renderMarkdown } from '../lib/markdown';
import ButlerProcess from './ButlerProcess';
import PanelShell from './PanelShell';

function roomName(
  rid: string,
  subscription: { fname?: string; name?: string } | undefined,
  room: { fname?: string; name?: string } | undefined,
): string {
  return subscription?.fname || subscription?.name || room?.fname || room?.name || rid;
}

function routineDaysLabel(days?: number[]): string {
  if (!days?.length) return '每天';
  return days.map((day) => `周${'日一二三四五六'[day] ?? day}`).join('、');
}

export default function ButlerPanel() {
  const rid = useChat((state) => state.activeRid);
  const subscription = useChat((state) => (state.activeRid ? state.subscriptions[state.activeRid] : undefined));
  const room = useChat((state) => (state.activeRid ? state.rooms[state.activeRid] : undefined));
  const lines = useButler((state) => state.lines);
  const activity = useButler((state) => state.activity);
  const running = useButler((state) => state.running);
  const error = useButler((state) => state.error);
  const routineDraft = useButler((state) => state.routineDraft);
  const steps = useButler((state) => state.steps);
  const ask = useButler((state) => state.ask);
  const stop = useButler((state) => state.stop);
  const newConversation = useButler((state) => state.newConversation);
  const confirmRoutineDraft = useButler((state) => state.confirmRoutineDraft);
  const dismissRoutineDraft = useButler((state) => state.dismissRoutineDraft);
  const hydrate = useButler((state) => state.hydrate);
  const userId = useAuth((state) => state.user?._id);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasConversation = lines.some((line) => line.role === 'user');

  // 恢复本账号保存的对话记录（与管家桌面对话共用同一份）
  useEffect(() => {
    if (userId) void hydrate();
  }, [hydrate, userId]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [lines, activity, error, routineDraft]);

  if (!rid) return null;

  const submit = async () => {
    const text = input.trim();
    if (!text || running) return;
    setInput('');
    await ask(text, { rid, roomName: roomName(rid, subscription, room) });
  };

  return (
    <PanelShell
      title={
        <span className="flex items-center gap-2">
          AI
          <button
            title="新对话：清空并开启全新上下文"
            onClick={() => void newConversation()}
            disabled={running}
            className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-fill-hover hover:text-ink disabled:opacity-50"
          >
            <MessageSquarePlus size={14} />
          </button>
        </span>
      }
      resizable
    >
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
        {hasConversation ? lines.map((line) => (
          <div key={line.id} className={`mb-3 flex gap-2 ${line.role === 'user' ? 'justify-end' : ''}`}>
            {line.role === 'assistant' ? (
              <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary-light text-primary">
                <Bot size={14} />
              </div>
            ) : null}
            <div className={`max-w-[84%] rounded-xl px-3 py-2 text-sm leading-6 ${
              line.role === 'user' ? 'bg-primary text-white' : 'bg-fill-1 text-ink'
            }`}>
              {line.role === 'assistant' && !line.text.startsWith('📌') ? renderMarkdown(line.text) : line.text}
            </div>
          </div>
        )) : <div className="py-10 text-center text-sm leading-6 text-ink-3">问我当前房间的讨论，或任何消息、待办、日程、工作项。</div>}

        <ButlerProcess steps={steps} running={running} className="mt-2" />
        {error ? <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</div> : null}
        {activity || running ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-ink-3">
            <Loader2 size={15} className="animate-spin" />{activity ?? '正在处理请求…'}
          </div>
        ) : null}

        {routineDraft ? (
          <div className="mt-3 rounded-lg border border-primary/30 bg-primary-light/40 p-3">
            <div className="text-xs font-medium text-primary">例行事务草案</div>
            <div className="mt-1 font-medium text-ink">{routineDraft.name}</div>
            <div className="mt-1 text-xs text-ink-2">{routineDraft.time} · {routineDaysLabel(routineDraft.days)} · 技能：{routineDraft.skillName}</div>
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={dismissRoutineDraft} className="rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-ink hover:bg-fill-hover">取消</button>
              <button onClick={confirmRoutineDraft} className="rounded-md bg-primary px-2.5 py-1 text-xs text-white hover:bg-primary-hover">确认启用</button>
            </div>
          </div>
        ) : null}
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="shrink-0 border-t border-line p-3">
        <div className="flex items-end gap-2 rounded-md border border-line px-2 focus-within:border-primary">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
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
              className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-line text-ink hover:bg-fill-hover"
            >
              <Square size={12} />
            </button>
          ) : (
            <button type="submit" disabled={!input.trim()} className="mb-1 flex h-7 w-7 shrink-0 items-center justify-center rounded bg-primary text-white hover:bg-primary-hover disabled:opacity-40">
              <SendHorizontal size={14} />
            </button>
          )}
        </div>
      </form>
    </PanelShell>
  );
}
