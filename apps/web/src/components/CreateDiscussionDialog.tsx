import { useState } from 'react';
import { Loader2, MessagesSquare } from 'lucide-react';
import { slugifyRoomName, stripQuotePrefix } from '../stores/chat';
import type { RcMessage, RcRoom } from '@rcx/rc-client';
import Dialog from './Dialog';

/**
 * 创建讨论的通用弹窗。
 *
 * Rocket.Chat 的 `rooms.createDiscussion` 里 `pmid` 是可选的：既可以「从某条消息
 * 开讨论」（带 `pmid`），也可以「直接在房间里开讨论」（只带 `prid`）。后一种在
 * 群里一条消息都没有时是唯一可用的入口，所以弹窗必须同时服务两种来源。
 */
export default function CreateDiscussionDialog({
  message,
  roomName,
  defaultName,
  onCreate,
  onClose,
}: {
  /** 从消息创建时传入；直接在房间里创建时不传。 */
  message?: RcMessage;
  /** 父房间名字，只用于文案。 */
  roomName?: string;
  /** 无消息可参考时的默认讨论名（如房间名 + 日期）。 */
  defaultName?: string;
  onCreate: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(() => {
    const seed = message ? stripQuotePrefix(message.msg) : '';
    return (seed || defaultName || '').slice(0, 40);
  });
  const [busy, setBusy] = useState(false);
  // 服务端只接受 slug 字符集，消息原文里的空格/标点/中文都会被清洗（issue #392）。
  // 这里实时显示最终房间名，避免用户以为创建出来的名字和自己输入的不一样。
  const fallback = message ? stripQuotePrefix(message.msg) : defaultName ?? '';
  const finalName = slugifyRoomName(name.trim() || fallback || '讨论', 'discussion');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onCreate(finalName);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="创建讨论"
      hint={
        message
          ? '给这条消息创建一个可持续讨论的子会话。'
          : `在${roomName ? `「${roomName}」` : '当前房间'}里创建一个可持续讨论的子会话。`
      }
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
            disabled={busy || !name.trim()}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <MessagesSquare size={14} />}
            {busy ? '创建中…' : '创建讨论'}
          </button>
        </>
      }
    >
      <label className="block px-5 pb-4 text-sm text-ink-2">
        讨论名称
        <input
          autoFocus
          value={name}
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
          placeholder="不填则按来源自动生成"
          className="mt-1 h-9 w-full rounded-md border border-line bg-surface-4 px-3 outline-none focus:border-primary"
        />
        <span className="mt-1 block text-xs text-ink-3">
          {finalName === name.trim() ? `房间名 ${finalName}` : `房间名将创建为 ${finalName}`}
        </span>
      </label>
    </Dialog>
  );
}

/**
 * 可当讨论父房间的会话列表。
 *
 * Rocket.Chat **不允许嵌套讨论**：对讨论再调 `rooms.createDiscussion` 会返回
 * `error-nested-discussion`（8.6 实测）。所以候选默认排除讨论（`prid` 非空），
 * 只能挂在频道/群组下。
 */
export function discussionParents(
  rooms: Record<string, RcRoom>,
  subscriptions: Record<string, unknown>,
): Array<{ rid: string; label: string }> {
  return Object.values(rooms)
    .filter((room) => room.t === 'c' || room.t === 'p')
    .filter((room) => !room.prid)
    .filter((room) => !!subscriptions[room._id])
    .map((room) => ({ rid: room._id, label: room.fname || room.name || room._id }))
    .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}
