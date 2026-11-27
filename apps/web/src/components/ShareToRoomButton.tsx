import { Check, GripVertical, Link2, Radio, Search, Send, Share2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import {
  formatSharePayloadForChat,
  writeButlerShareDrag,
  type ButlerSharePayload,
} from '../lib/butlerChatBridge';
import {
  useButlerRoomBindings,
  type ButlerRoomBindingTargetKind,
} from '../stores/butlerRoomBindings';
import { buildConversations, useChat } from '../stores/chat';
import { toast } from '../stores/toast';
import { useUI } from '../stores/ui';

export interface ShareToRoomBindTarget {
  targetKind: ButlerRoomBindingTargetKind;
  targetId: string;
  label: string;
}

export default function ShareToRoomButton({
  payload,
  bindableTarget,
  compact = false,
  label,
  className = '',
}: {
  payload: ButlerSharePayload;
  bindableTarget?: ShareToRoomBindTarget;
  compact?: boolean;
  label?: string;
  className?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const activeRid = useChat((s) => s.activeRid);
  const openRoom = useChat((s) => s.openRoom);
  const sendMessage = useChat((s) => s.send);
  const setModule = useUI((s) => s.setModule);
  const seedComposer = useUI((s) => s.seedComposer);

  const bindings = useButlerRoomBindings((s) => s.bindings);
  const hydrateBindings = useButlerRoomBindings((s) => s.hydrate);
  const bindToRoom = useButlerRoomBindings((s) => s.bindToRoom);
  const unbind = useButlerRoomBindings((s) => s.unbind);

  useEffect(() => {
    hydrateBindings();
  }, [hydrateBindings]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const roomOptions = useMemo(() => {
    const convs = buildConversations(subscriptions, rooms).filter((c) => !c.hidden);
    const q = query.trim().toLowerCase();
    const filtered = q
      ? convs.filter((c) => (c.name || c.rid).toLowerCase().includes(q))
      : convs;
    return filtered.slice(0, 12);
  }, [query, rooms, subscriptions]);

  const targetBindings = useMemo(() => {
    if (!bindableTarget) return [];
    return bindings.filter(
      (b) =>
        b.enabled
        && b.targetKind === bindableTarget.targetKind
        && b.targetId === bindableTarget.targetId,
    );
  }, [bindableTarget, bindings]);

  const sendDraftToRoom = async (rid: string, roomName: string, immediate: boolean) => {
    const markdown = formatSharePayloadForChat(payload);
    setOpen(false);
    if (immediate) {
      try {
        await sendMessage(markdown, { rid });
        toast.success(t('butler.chatShare.sentToRoomToast', { room: roomName }));
      } catch (err) {
        toast.error(err, t('butler.chatShare.sendFailed'));
      }
      return;
    }
    setModule('messages');
    await openRoom(rid).catch(() => undefined);
    seedComposer(markdown, 'append');
    toast.info(t('butler.chatShare.draftedToRoomToast', { room: roomName }));
  };

  return (
    <div ref={rootRef} className="relative inline-flex items-center">
      <button
        type="button"
        draggable
        onDragStart={(e) => {
          writeButlerShareDrag(e.dataTransfer, payload);
        }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        title={t('butler.chatShare.dragOrClickTooltip')}
        aria-expanded={open}
        aria-label={label || t('butler.chatShare.buttonLabel')}
        className={`inline-flex items-center gap-1 rounded-lg border border-line bg-surface-3 text-ink-2 transition hover:border-primary/40 hover:text-primary cursor-grab active:cursor-grabbing ${
          compact ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs font-medium'
        } ${className}`}
      >
        <GripVertical size={11} className="text-ink-3" aria-hidden="true" />
        <Share2 size={11} aria-hidden="true" />
        <span>{label || t('butler.chatShare.buttonLabel')}</span>
        {targetBindings.length > 0 ? (
          <span className="inline-flex items-center gap-0.5 rounded-full bg-primary/15 px-1.5 py-0.5 text-2xs font-medium text-primary">
            <Radio size={9} aria-hidden="true" />
            {targetBindings.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label={t('butler.chatShare.pickerTitle')}
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-40 mt-1.5 w-72 rounded-xl border border-line bg-surface-4 p-2.5 shadow-pop"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-ink">
              {t('butler.chatShare.pickerTitle')}
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
          <label className="mb-2 flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs">
            <Search size={12} className="shrink-0 text-ink-3" aria-hidden="true" />
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('butler.chatShare.searchRoomsPlaceholder')}
              className="w-full bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
            />
          </label>

          {roomOptions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line p-3 text-center text-xs text-ink-3">
              {t('butler.chatShare.noRoomsAvailable')}
            </p>
          ) : (
            <div className="max-h-56 space-y-1 overflow-y-auto pr-0.5">
              {roomOptions.map((conv) => {
                const roomName = conv.name || conv.rid;
                const existingBinding = bindableTarget
                  ? targetBindings.find((b) => b.rid === conv.rid)
                  : undefined;
                return (
                  <div
                    key={conv.rid}
                    className={`rounded-lg border px-2 py-1.5 text-xs ${
                      conv.rid === activeRid
                        ? 'border-primary/35 bg-primary/5'
                        : 'border-line-soft bg-surface-3'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="truncate font-medium text-ink">{roomName}</span>
                      {conv.rid === activeRid ? (
                        <span className="shrink-0 rounded-full bg-primary/15 px-1.5 py-0.5 text-2xs font-medium text-primary">
                          {t('butler.chatShare.currentRoomTag')}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void sendDraftToRoom(conv.rid, roomName, false)}
                        className="rounded-md bg-primary px-2 py-0.5 text-xs font-medium text-white hover:bg-primary-hover"
                      >
                        {t('butler.chatShare.insertDraft')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void sendDraftToRoom(conv.rid, roomName, true)}
                        className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-4 px-2 py-0.5 text-xs text-ink-2 hover:text-ink"
                      >
                        <Send size={10} aria-hidden="true" />
                        <span>{t('butler.chatShare.sendNow')}</span>
                      </button>
                      {bindableTarget ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (existingBinding) {
                              unbind(existingBinding.id);
                              toast.info(t('butler.chatShare.unboundRoomToast', { room: roomName }));
                            } else {
                              bindToRoom({
                                targetKind: bindableTarget.targetKind,
                                targetId: bindableTarget.targetId,
                                label: bindableTarget.label,
                                rid: conv.rid,
                                roomName,
                                autoPost: true,
                              });
                              toast.success(t('butler.chatShare.boundRoomToast', { room: roomName }));
                            }
                          }}
                          className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition ${
                            existingBinding
                              ? 'border-primary/40 bg-primary/15 text-primary'
                              : 'border-line bg-surface-4 text-ink-3 hover:text-ink'
                          }`}
                        >
                          {existingBinding ? <Check size={10} aria-hidden="true" /> : <Link2 size={10} aria-hidden="true" />}
                          <span>{t(existingBinding ? 'butler.chatShare.boundLabel' : 'butler.chatShare.bindStream')}</span>
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-2 text-xs text-ink-3">{t('butler.chatShare.dragHintFooter')}</p>
        </div>
      ) : null}
    </div>
  );
}
