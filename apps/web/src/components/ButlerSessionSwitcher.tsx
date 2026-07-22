import { Check, ChevronDown, MessageSquarePlus, Pencil, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useButler } from '../stores/butler';

export default function ButlerSessionSwitcher({
  compact = false,
  label,
}: {
  compact?: boolean;
  label?: ReactNode;
}) {
  const sessions = useButler((state) => state.sessions);
  const activeSessionId = useButler((state) => state.activeSessionId);
  const running = useButler((state) => state.running);
  const switchSession = useButler((state) => state.switchSession);
  const renameSession = useButler((state) => state.renameSession);
  const newConversation = useButler((state) => state.newConversation);
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(activeSession?.title ?? '');

  useEffect(() => {
    setEditing(false);
    setDraftTitle(activeSession?.title ?? '');
  }, [activeSession?.id, activeSession?.title]);

  const selectCls = compact
    ? 'h-8 max-w-[11rem] pr-7 pl-2 text-xs'
    : 'h-8 min-w-[12rem] max-w-[16rem] pr-8 pl-3 text-xs';
  const buttonCls = compact
    ? 'flex h-8 w-8 items-center justify-center rounded-md border border-line bg-surface text-ink font-normal hover:bg-fill-hover disabled:opacity-50'
    : 'flex items-center gap-1.5 rounded-md border border-line bg-surface px-3 py-1.5 text-xs text-ink font-normal hover:bg-fill-hover disabled:opacity-50';
  const inputCls = compact
    ? 'h-8 w-32 rounded-md border border-line bg-surface px-2 text-xs text-ink font-normal outline-none focus:border-primary'
    : 'h-8 w-44 rounded-md border border-line bg-surface px-3 text-xs text-ink font-normal outline-none focus:border-primary';

  const submitRename = async () => {
    if (!activeSession) return;
    const nextTitle = draftTitle.trim();
    if (!nextTitle) return;
    await renameSession(activeSession.id, nextTitle);
    setEditing(false);
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      {label ? <span className="shrink-0 text-inherit">{label}</span> : null}
      {editing && activeSession ? (
        <>
          <input
            value={draftTitle}
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submitRename();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
                setDraftTitle(activeSession.title);
              }
            }}
            disabled={running}
            aria-label="会话名称"
            className={inputCls}
          />
          <button
            type="button"
            onClick={() => void submitRename()}
            disabled={running || !draftTitle.trim()}
            aria-label="保存会话名称"
            title="保存会话名称"
            className={buttonCls}
          >
            <Check size={compact ? 14 : 15} />
            {compact ? null : '保存'}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraftTitle(activeSession.title);
            }}
            aria-label="取消重命名"
            title="取消重命名"
            className={buttonCls}
          >
            <X size={compact ? 14 : 15} />
            {compact ? null : '取消'}
          </button>
        </>
      ) : (
        <>
          <div className="relative min-w-0">
            <select
              value={activeSession?.id ?? ''}
              onChange={(event) => void switchSession(event.target.value)}
              disabled={running || sessions.length === 0}
              aria-label="管家会话"
              className={`appearance-none rounded-md border border-line bg-surface text-ink font-normal outline-none focus:border-primary disabled:opacity-50 ${selectCls}`}
            >
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
            </select>
            <ChevronDown
              size={compact ? 13 : 14}
              className={`pointer-events-none absolute text-ink-3 ${compact ? 'right-2 top-2.5' : 'right-3 top-3'}`}
            />
          </div>
          <button
            type="button"
            onClick={() => void newConversation()}
            disabled={running}
            aria-label="新对话"
            title="新对话"
            className={buttonCls}
          >
            <MessageSquarePlus size={compact ? 14 : 15} />
            {compact ? null : '新对话'}
          </button>
          <button
            type="button"
            onClick={() => {
              if (!activeSession) return;
              setDraftTitle(activeSession.title);
              setEditing(true);
            }}
            disabled={running || !activeSession}
            aria-label="重命名会话"
            title="重命名会话"
            className={buttonCls}
          >
            <Pencil size={compact ? 14 : 15} />
            {compact ? null : '重命名'}
          </button>
        </>
      )}
    </div>
  );
}
