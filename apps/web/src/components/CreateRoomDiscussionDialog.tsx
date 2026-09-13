import { useMemo, useState } from 'react';
import { Loader2, MessagesSquare } from 'lucide-react';
import { useChat } from '../stores/chat';
import { discussionParents } from './CreateDiscussionDialog';
import Dialog from './Dialog';

/**
 * 在房间里创建讨论（不带来源消息）。
 *
 * Rocket.Chat 的 `rooms.createDiscussion` 的 `pmid` 是可选的：原生客户端的房间
 * 「+」菜单里就允许不选中任何消息直接开讨论。此前 RocketX 只有「消息右键 → 创建
 * 讨论」一条路径，群里一条消息都没有时（空群/新群）根本开不了讨论。
 *
 * 传 `rid` 就是在当前房间直接开；不传则先选父房间。父房间只能是频道/群组 ——
 * Rocket.Chat 拒绝嵌套讨论（`error-nested-discussion`，8.6 实测）。
 */
export default function CreateRoomDiscussionDialog({
  rid,
  onClose,
}: {
  /** 指定父房间（从房间内打开时）；不传则让用户选 */
  rid?: string;
  onClose: () => void;
}) {
  const rooms = useChat((state) => state.rooms);
  const subscriptions = useChat((state) => state.subscriptions);
  const createDiscussionInRoom = useChat((state) => state.createDiscussionInRoom);

  const parents = useMemo(
    () => discussionParents(rooms, subscriptions),
    [rooms, subscriptions],
  );
  const [parentRid, setParentRid] = useState(rid ?? parents[0]?.rid ?? '');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const parent = rooms[parentRid];
  const parentLabel = parent?.fname || parent?.name || '';

  const submit = async () => {
    if (busy || !parentRid) return;
    setBusy(true);
    try {
      await createDiscussionInRoom(parentRid, name.trim() || undefined);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="创建讨论"
      hint="讨论是挂在房间下的子会话，适合把一条线索从主频道里拆出来单独聊。"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover disabled:opacity-50"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !parentRid}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <MessagesSquare size={14} />}
            {busy ? '创建中…' : '创建讨论'}
          </button>
        </>
      }
    >
      <div className="space-y-4 px-5 pb-4">
        {!rid && (
          <label className="block text-xs text-ink-3">
            所属房间
            <select
              value={parentRid}
              onChange={(event) => setParentRid(event.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
            >
              {parents.length === 0 ? <option value="">没有可创建讨论的房间</option> : null}
              {parents.map((item) => (
                <option key={item.rid} value={item.rid}>
                  {item.label}
                </option>
              ))}
            </select>
            {parents.length === 0 ? (
              <span className="mt-1 block text-danger">当前没有可创建讨论的频道或群组</span>
            ) : null}
          </label>
        )}
        {rid && parentLabel && (
          <div className="text-xs text-ink-3">
            所属房间<span className="mt-1 block text-sm text-ink">{parentLabel}</span>
          </div>
        )}
        <label className="block text-xs text-ink-3">
          讨论名称
          <input
            autoFocus
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
            placeholder={parentLabel ? `默认使用「${parentLabel}」` : '不填则用房间名'}
            className="mt-1 h-9 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink outline-none focus:border-primary"
          />
        </label>
      </div>
    </Dialog>
  );
}
