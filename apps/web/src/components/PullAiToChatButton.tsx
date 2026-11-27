import { Bot, Check, GripVertical, MessagesSquare, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import {
  formatAiDiscussionHandoffDraft,
  writeAiParticipantDrag,
  type AiParticipantDragPayload,
} from '../lib/butlerChatBridge';
import { buildConversations, useChat } from '../stores/chat';
import { useRoomAiParticipants, type RoomAiAgentKind } from '../stores/roomAiParticipants';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';
import CreateRoomDiscussionDialog from './CreateRoomDiscussionDialog';

export default function PullAiToChatButton({
  source,
  agentKind,
  agentId,
  agentName,
  threadId,
  acpSessionKey,
  workspaceRoot,
  summary,
  compact = false,
  className = '',
}: {
  source: 'butler' | 'acp_agent';
  agentKind: RoomAiAgentKind;
  agentId: string;
  agentName: string;
  threadId?: string;
  acpSessionKey?: string;
  workspaceRoot?: string;
  summary?: string;
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [createAiOpen, setCreateAiOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const openRoom = useChat((s) => s.openRoom);
  const setModule = useUI((s) => s.setModule);
  const seedComposer = useUI((s) => s.seedComposer);

  const participants = useRoomAiParticipants((s) => s.participants);
  const hydrateParticipants = useRoomAiParticipants((s) => s.hydrate);
  const enrollFromDrag = useRoomAiParticipants((s) => s.enrollFromDrag);

  useEffect(() => {
    hydrateParticipants();
  }, [hydrateParticipants]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const payload = useMemo<AiParticipantDragPayload>(
    () => ({
      source,
      agentKind,
      agentId,
      agentName,
      threadId,
      acpSessionKey,
      workspaceRoot,
      summary,
    }),
    [acpSessionKey, agentId, agentKind, agentName, source, summary, threadId, workspaceRoot],
  );

  const convs = useMemo(() => {
    const all = buildConversations(subscriptions, rooms).filter((c) => !c.hidden);
    const q = query.trim().toLowerCase();
    const list = q
      ? all.filter((c) => (c.name || '').toLowerCase().includes(q))
      : all;
    return list.slice(0, 20);
  }, [query, rooms, subscriptions]);

  const handleEnrollRoom = async (rid: string, roomLabel: string) => {
    const sub = subscriptions[rid] ?? rooms[rid];
    const isDiscussion = Boolean(sub?.prid);
    enrollFromDrag(rid, isDiscussion, payload);
    setOpen(false);
    setModule('messages');
    await openRoom(rid).catch(() => undefined);
    if (summary?.trim() && !isDiscussion) {
      seedComposer(formatAiDiscussionHandoffDraft(payload), 'append');
      toast.success(
        t('chat.aiParticipant.enrolledWithHandoffToast', { agent: agentName, room: roomLabel }),
      );
      return;
    }
    toast.success(t('chat.aiParticipant.enrolledToast', { agent: agentName, room: roomLabel }));
  };

  return (
    <div ref={rootRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          writeAiParticipantDrag(e.dataTransfer, payload);
        }}
        onClick={() => setOpen((v) => !v)}
        title={t('butler.pullToChat.dragOrClickTooltip')}
        className={
          compact
            ? 'inline-flex items-center gap-1 rounded-md border border-line-soft bg-surface-3 px-2 py-0.5 text-xs text-ink-3 transition hover:border-primary/40 hover:text-primary cursor-grab active:cursor-grabbing'
            : 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface-4 px-2.5 text-xs text-ink-2 transition hover:border-primary/40 hover:bg-fill-hover hover:text-primary cursor-grab active:cursor-grabbing'
        }
      >
        <GripVertical size={11} className="opacity-60" aria-hidden="true" />
        <Bot size={compact ? 11 : 13} aria-hidden="true" />
        <span>{t('butler.pullToChat.buttonLabel')}</span>
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-80 rounded-xl border border-line bg-surface-4 p-2.5 shadow-xl">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-ink">
              {t('butler.pullToChat.pickerTitle')}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded p-0.5 text-ink-3 hover:bg-fill-hover hover:text-ink"
              aria-label={t('common.close')}
            >
              <X size={13} />
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setCreateAiOpen(true);
            }}
            className="mb-2 flex w-full items-center gap-2 rounded-lg border border-primary/30 bg-primary-light/70 px-2.5 py-2 text-left text-xs font-medium text-primary transition hover:bg-primary-light"
          >
            <MessagesSquare size={14} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {t('butler.pullToChat.createAiDiscussionBtn')}
            </span>
            <Plus size={13} className="shrink-0" />
          </button>

          <div className="mb-1.5 text-xs font-medium text-ink-3">
            {t('butler.pullToChat.joinExistingTitle')}
          </div>

          <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1">
            <Search size={12} className="shrink-0 text-ink-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('butler.chatShare.searchRoomsPlaceholder')}
              className="w-full bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
              autoFocus
            />
          </div>

          <div className="max-h-52 space-y-1 overflow-y-auto pr-0.5">
            {convs.length === 0 ? (
              <div className="py-4 text-center text-xs text-ink-3">
                {t('butler.chatShare.noRoomsAvailable')}
              </div>
            ) : (
              convs.map((conv) => {
                const roomLabel = conv.name || conv.rid;
                const active = Boolean(participants[conv.rid]?.enabled);
                return (
                  <div
                    key={conv.rid}
                    className="flex items-center justify-between gap-2 rounded-lg border border-line-soft bg-surface-3 px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-xs text-ink" title={roomLabel}>
                      {roomLabel}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleEnrollRoom(conv.rid, roomLabel)}
                      className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium transition ${
                        active
                          ? 'border-primary/40 bg-primary-light text-primary'
                          : 'border-line bg-surface-4 text-ink-2 hover:border-primary/40 hover:text-primary'
                      }`}
                    >
                      {active ? <Check size={11} /> : <Plus size={11} />}
                      <span>
                        {active
                          ? t('butler.pullToChat.alreadyJoined')
                          : t('butler.pullToChat.joinBtn')}
                      </span>
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="mt-2 border-t border-line-soft pt-1.5 text-xs text-ink-3">
            {t('butler.pullToChat.dragHintFooter')}
          </div>
        </div>
      ) : null}

      {createAiOpen ? (
        <CreateRoomDiscussionDialog
          defaultAi
          defaultAgentId={agentKind === 'acp' ? agentId : 'pi_butler'}
          onClose={() => setCreateAiOpen(false)}
        />
      ) : null}
    </div>
  );
}
