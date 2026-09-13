import { useMemo, useRef, useState } from 'react';
import { Copy, Loader2 } from 'lucide-react';
import { useChat } from '../stores/chat';
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
    const id = toast.loading('正在复制聊天记录…');
    try {
      const result = await copyHistoryToRoom(sourceRid, targetRid, limit, {
        signal: controller.signal,
        onProgress: (copied, total) => setProgress({ copied, total }),
      });
      if (result.copied === 0) {
        toast.update(id, { kind: 'error', message: '没有可复制的消息（原会话可能是空的）' });
      } else {
        toast.update(id, {
          kind: 'success',
          message:
            result.skipped > 0
              ? `已复制 ${result.copied} 条到「${label(targetRid)}」，${result.skipped} 条失败`
              : `已复制 ${result.copied} 条到「${label(targetRid)}」`,
        });
      }
      onClose();
    } catch (error) {
      toast.update(id, { kind: 'error', message: error instanceof Error ? error.message : '复制失败' });
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <Dialog
      title="复制聊天记录"
      hint="把原会话的消息转发到目标会话里。点引用可以跳回原消息，原会话的记录不会被删除。"
      width={440}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          {busy && (
            <button
              onClick={() => abortRef.current?.abort()}
              className="mr-auto h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
            >
              停止
            </button>
          )}
          <button
            onClick={onClose}
            disabled={busy}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={() => void run()}
            disabled={!canRun}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
            {busy ? `复制中 ${progress?.copied ?? 0}/${progress?.total || '…'}` : '开始复制'}
          </button>
        </>
      }
    >
      <div className="space-y-4 px-5 pb-4">
        <label className="block text-xs text-ink-3">
          从哪个会话复制
          <select
            value={sourceRid}
            disabled={busy}
            onChange={(event) => setSourceRid(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary disabled:opacity-60"
          >
            {rooms.length === 0 ? <option value="">没有可选会话</option> : null}
            {rooms.map((room) => (
              <option key={room.rid} value={room.rid}>
                {room.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-ink-3">
          复制到哪个会话
          <select
            value={targetRid}
            disabled={busy}
            onChange={(event) => setTargetRid(event.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary disabled:opacity-60"
          >
            <option value="">选择目标会话</option>
            {rooms
              .filter((room) => room.rid !== sourceRid)
              .map((room) => (
                <option key={room.rid} value={room.rid}>
                  {room.label}
                </option>
              ))}
          </select>
          {targetRid && targetRid === sourceRid && (
            <span className="mt-1 block text-danger">目标不能和来源是同一个会话</span>
          )}
        </label>

        <div className="text-xs text-ink-3">
          复制多少
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
            说明：这是转发副本（每条带引用块、显示原作者）。原会话记录不会删除；
            受保护的文件跨会话打不开，只复制文字与引用。
            {limitKey === 'all' && ` 超过 ${COPY_ALL_CAP} 条时只复制最近 ${COPY_ALL_CAP} 条。`}
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
