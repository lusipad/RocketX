import { tsMs, type RcMessage } from '@rcx/rc-client';
import { ChevronRight, MessagesSquare } from 'lucide-react';
import { useChat } from '../stores/chat';
import { fmtConvTime } from '../lib/format';
import Avatar from './Avatar';

/**
 * 父频道里的「讨论」卡片。
 *
 * 建讨论后 RC 会往父频道发一条 t='discussion-created' 的消息，`msg` 是讨论名、
 * `drid` 是讨论房间 id。我们之前没认这个类型，它掉进了系统消息的兜底分支，
 * 被渲染成一行灰字（「admin discussion-created 讨论名」），点也点不动。
 */
export default function DiscussionCard({ message }: { message: RcMessage }) {
  const openDiscussion = useChat((s) => s.openDiscussion);
  // 讨论房间如果已经在我们的会话列表里，就能顺带显示人数和最后活跃时间
  const room = useChat((s) => (message.drid ? s.rooms[message.drid] : undefined));

  const name = message.msg || room?.fname || room?.name || '讨论';
  const author = message.u?.name || message.u?.username || '';
  const count = message.dcount ?? 0;
  const lastMs = tsMs(message.dlm ?? room?.lm);

  const meta = [
    count > 0 ? `${count} 条消息` : '还没有人发言',
    lastMs ? fmtConvTime(lastMs) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="px-4 py-1.5">
      <button
        onClick={() => message.drid && void openDiscussion(message.drid)}
        className="group flex w-full max-w-md items-center gap-3 rounded-lg border border-line bg-surface-4 px-3 py-2.5 text-left transition hover:border-primary hover:bg-fill-hover"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-light text-primary">
          <MessagesSquare size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="shrink-0 rounded bg-primary-light px-1 py-px text-2xs text-primary">
              讨论
            </span>
            <span className="truncate text-sm font-medium text-ink">{name}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-xs text-ink-3">
            {author && <Avatar name={author} username={message.u?.username} size={14} />}
            <span className="truncate">
              {author} 发起 {meta && `· ${meta}`}
            </span>
          </span>
        </span>
        <ChevronRight
          size={16}
          className="shrink-0 text-ink-3 transition group-hover:text-primary"
        />
      </button>
    </div>
  );
}
