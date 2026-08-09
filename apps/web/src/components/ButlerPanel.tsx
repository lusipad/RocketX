import { ArrowUpRight, Bot, SendHorizontal, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { handoffToCodexTask } from '../lib/codexTaskHandoff';
import { useChat } from '../stores/chat';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useUI } from '../stores/ui';
import { toast } from '../stores/toast';

function roomName(
  rid: string,
  subscription: { fname?: string; name?: string } | undefined,
  room: { fname?: string; name?: string } | undefined,
): string {
  return subscription?.fname || subscription?.name || room?.fname || room?.name || rid;
}

/**
 * 房间侧栏只是 Codex 任务入口。推理、会话、审批与 Memory 都留在唯一任务面中。
 */
export default function ButlerPanel() {
  const rid = useChat((state) => state.activeRid);
  const subscription = useChat((state) => (
    state.activeRid ? state.subscriptions[state.activeRid] : undefined
  ));
  const room = useChat((state) => (state.activeRid ? state.rooms[state.activeRid] : undefined));
  const setPanel = useChat((state) => state.setPanel);
  const workspaceRoot = useCodexWorkspace((state) => state.workspaceRoot);
  const [input, setInput] = useState('');
  const currentRoomName = useMemo(
    () => rid ? roomName(rid, subscription, room) : '',
    [rid, room, subscription],
  );

  if (!rid) return null;

  const openTasks = (): void => {
    setPanel(null);
    useUI.getState().openButlerConversation();
  };

  const submit = async (): Promise<void> => {
    const question = input.trim();
    if (!question) return;
    setInput('');
    setPanel(null);
    try {
      const result = await handoffToCodexTask(
        `请在 Rocket.Chat 房间「${currentRoomName}」（rid: ${rid}）的语境中处理以下任务。需要房间数据时使用对应 Skill 或 App 获取真实内容。\n\n${question}`,
        `${currentRoomName} · ${question}`,
      );
      if (result === 'drafted') toast.info('先选择工作区，再发送已经填好的任务。');
    } catch (error) {
      toast.error(error, '无法创建 Codex 任务');
    }
  };

  return (
    <aside
      id="room-butler-panel"
      role="dialog"
      aria-modal="false"
      aria-label="房间任务"
      className="absolute top-4 right-3 bottom-28 z-30 flex w-[min(420px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-[0_24px_64px_-24px_rgba(0,0,0,0.78),0_8px_20px_-12px_rgba(0,0,0,0.55)]"
    >
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
        <button
          type="button"
          onClick={() => setPanel(null)}
          aria-label="关闭房间任务"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink"
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col justify-between gap-6 p-5">
        <div>
          <p className="text-sm leading-6 text-ink-2">
            这里不再运行另一套“管家”。任务会进入同一个 Codex 工作区，由 Skills 和 Apps 读取真实协作数据；过程、审批和结果都留在任务中。
          </p>
          <button
            type="button"
            onClick={openTasks}
            className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary-hover"
          >
            查看任务
            <ArrowUpRight size={14} aria-hidden="true" />
          </button>
        </div>

        <div>
          <p className="mb-2 truncate text-xs text-ink-3" title={workspaceRoot || undefined}>
            {workspaceRoot ? `工作区：${workspaceRoot}` : '尚未选择 Codex 工作区'}
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            className="rounded-xl border border-line bg-fill-2 p-2 shadow-sm focus-within:border-primary"
          >
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
              rows={3}
              placeholder="例如：汇总今天的讨论并提取待办"
              className="max-h-40 w-full resize-none bg-transparent px-1 py-1.5 text-sm leading-6 outline-none placeholder:text-ink-3"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!input.trim()}
                aria-label="创建 Codex 任务"
                className="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                <SendHorizontal size={14} aria-hidden="true" />
                创建任务
              </button>
            </div>
          </form>
        </div>
      </div>
    </aside>
  );
}
