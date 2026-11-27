import { useMemo, useRef, useState } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { useChat } from '../stores/chat';
import { useT } from '../i18n';
import { useHistoryCopy } from '../stores/historyCopyUi';
import { toast } from '../stores/toast';
import {
  COPY_LIMITS,
  COPY_ALL_CAP,
  limitForKey,
  type CopyLimitKey,
} from '../lib/historyCopy';
import Dialog from './Dialog';

interface RoomOption {
  rid: string;
  label: string;
}

/**
 * 把某个会话的聊天记录复制到另一个会话。
 *
 * 用途：Rocket.Chat 的私聊「加人」等于新建一个空会话，历史留在原处；这个弹窗让
 * 用户把原会话最近的消息（30 / 100 / 全部）转发进新会话。
 *
 * 注意语义：这是**复制**不是搬移 —— 发出去的是带引用块的转发消息，点引用能跳回
 * 原会话的原消息；原会话一条不少。受保护的文件跨会话不可访问，只复制文字与引用。
 */
export default function CopyHistoryDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const sourceRidProp = useHistoryCopy((s) => s.sourceRid);
  const targetRidProp = useHistoryCopy((s) => s.targetRid);
  const subscriptions = useChat((s) => s.subscriptions);
  const copyHistoryToRoom = useChat((s) => s.copyHistoryToRoom);

  const rooms = useMemo<RoomOption[]>(
    () =>
      Object.values(subscriptions).map((sub) => ({
        rid: sub.rid,
        label: sub.fname || sub.name || sub.rid,
      })),
    [subscriptions],
  );

  const [sourceRid, setSourceRid] = useState(sourceRidProp ?? rooms[0]?.rid ?? '');
  const [targetRid, setTargetRid] = useState(targetRidProp ?? '');
  const [limitKey, setLimitKey] = useState<CopyLimitKey>('recent');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ copied: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const label = (rid: string): string => rooms.find((room) => room.rid === rid)?.label ?? rid;
  const limit = limitForKey(limitKey);
  const canRun = !!sourceRid && !!targetRid && sourceRid !== targetRid && !busy;

  const run = async () => {
    if (!canRun) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setProgress({ copied: 0, total: 0 });
    const id = toast.loading(t('chat.historyCopy.copyingToast'));
    try {
      const result = await copyHistoryToRoom(sourceRid, targetRid, limit, {
        signal: controller.signal,
        onProgress: (copied, total) => setProgress({ copied, total }),
      });
      if (result.copied === 0) {
        toast.update(id, { kind: 'error', message: t('chat.historyCopy.emptyToast') });
      } else {
        toast.update(id, {
          kind: 'success',
          message:
            result.skipped > 0
              ? t('chat.historyCopy.doneWithSkipped', { copied: result.copied, target: label(targetRid), skipped: result.skipped })
              : t('chat.historyCopy.done', { copied: result.copied, target: label(targetRid) }),
        });
      }
      onClose();
    } catch (error) {
      toast.update(id, { kind: 'error', message: error instanceof Error ? error.message : t('chat.historyCopy.failed') });
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Dialog
      title={t('chat.historyCopy.title')}
      hint={t('chat.historyCopy.hint')}
      width={440}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          {busy && (
            <button
              onClick={() => abortRef.current?.abort()}
              className="mr-auto h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
            >
              {t('chat.historyCopy.stop')}
            </button>
          )}
          <button
            onClick={onClose}
            disabled={busy}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={() => void run()}
            disabled={!canRun}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
            {busy ? t('chat.historyCopy.copyingBtn', { copied: progress?.copied ?? 0, total: progress?.total || '…' }) : t('chat.historyCopy.startBtn')}
          </button>
        </>
      }
    >
      <div className="space-y-4 px-5 pb-4">
        <label className="block text-xs text-ink-3">
          {t('chat.historyCopy.sourceLabel')}
          <select
            value={sourceRid}
            disabled={busy}
            onChange={(event) => setSourceRid(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary disabled:opacity-60"
          >
            {rooms.length === 0 ? <option value="">{t('chat.historyCopy.noRooms')}</option> : null}
            {rooms.map((room) => (
              <option key={room.rid} value={room.rid}>
                {room.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-ink-3">
          {t('chat.historyCopy.targetLabel')}
          <select
            value={targetRid}
            disabled={busy}
            onChange={(event) => setTargetRid(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary disabled:opacity-60"
          >
            <option value="">{t('chat.historyCopy.selectTarget')}</option>
            {rooms
              .filter((room) => room.rid !== sourceRid)
              .map((room) => (
                <option key={room.rid} value={room.rid}>
                  {room.label}
                </option>
              ))}
          </select>
          {targetRid && targetRid === sourceRid && (
            <span className="mt-1 block text-danger">{t('chat.historyCopy.sameRoomError')}</span>
          )}
        </label>

        <div className="text-xs text-ink-3">
          {t('chat.historyCopy.limitLabel')}
          <div className="mt-1 flex gap-1.5">
            {COPY_LIMITS.map((option) => (
              <button
                key={option.key}
                type="button"
                disabled={busy}
                onClick={() => setLimitKey(option.key)}
                className={`h-8 flex-1 rounded-md border text-xs transition disabled:opacity-60 ${
                  limitKey === option.key
                    ? 'border-primary bg-primary-light text-primary'
                    : 'border-line text-ink-2 hover:bg-fill-hover'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span className="mt-1 block">
            {t('chat.historyCopy.note')}
            {limitKey === 'all' && ` ${t('chat.historyCopy.capNote', { cap: COPY_ALL_CAP })}`}
          </span>
        </div>
      </div>
    </Dialog>
  );
}

/** 挂在应用根部的宿主：任何地方 openHistoryCopy() 都能唤起弹窗。 */
export function HistoryCopyDialogHost() {
  const open = useHistoryCopy((s) => s.open);
  const close = useHistoryCopy((s) => s.close);
  if (!open) return null;
  return <CopyHistoryDialog onClose={close} />;
}
