import { tsMs, type RcMessage } from '@rcx/rc-client';
import { useChat, stripQuotePrefix } from '../stores/chat';
import { fmtConvTime } from '../lib/format';
import { highlightText } from '../lib/highlight';
import Avatar from './Avatar';

/**
 * 搜索 / 置顶 / 标记面板的消息条目：点击跳转到该消息并高亮。
 * 右侧可挂一个操作按钮（如取消置顶）。
 */
export default function MessageResultRow({
  message,
  action,
  highlight,
}: {
  message: RcMessage;
  action?: React.ReactNode;
  /** 命中的关键词，会被标黄 */
  highlight?: string;
}) {
  const jumpToMessage = useChat((s) => s.jumpToMessage);
  const text = stripQuotePrefix(message.msg ?? '') || message.attachments?.[0]?.title || '[卡片消息]';

  return (
    <div className="group relative mb-2 rounded-lg border border-line transition hover:border-primary">
      <button
        onClick={() => void jumpToMessage(message._id, message.rid)}
        className="w-full p-3 text-left"
        title="点击跳转到该消息"
      >
        <div className="flex items-center gap-2">
          <Avatar name={message.u.name || message.u.username} username={message.u.username} size={24} />
          <span className="text-xs font-medium text-ink">
            {message.u.name || message.u.username}
          </span>
          <span className="text-xs text-ink-3">{fmtConvTime(tsMs(message.ts))}</span>
        </div>
        <div className="mt-1.5 line-clamp-3 text-sm break-words text-ink-2">
          {highlightText(text, highlight)}
        </div>
      </button>
      {action && (
        <div className="absolute top-2.5 right-2.5 hidden group-hover:block">{action}</div>
      )}
    </div>
  );
}
