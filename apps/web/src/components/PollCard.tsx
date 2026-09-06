import { useAuth } from '../stores/auth';
import { useChat } from '../stores/chat';
import { personName, useAliases } from '../stores/aliases';
import {
  digitCharAt,
  pollIsClosed,
  pollTally,
  type PollPayload,
} from '../lib/poll';
import type { RcMessage } from '@rcx/rc-client';
import { BarChart3, CheckCircle2, Lock } from 'lucide-react';

/**
 * 投票消息卡片。
 *
 * 票数直接读消息的数字表情回应——服务端推送消息更新时这里自然重算，
 * 实时性跟普通表情回应完全一致。官方 RC 客户端看到的则是正文里的
 * 题目 + 编号选项文本，他们用表情也能参与同一套计票。
 */
export default function PollCard({ message, poll }: { message: RcMessage; poll: PollPayload }) {
  const myUsername = useAuth((s) => s.user?.username);
  const votePoll = useChat((s) => s.votePoll);
  const closePoll = useChat((s) => s.closePoll);
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const tally = pollTally(poll, message, myUsername);
  const closed = pollIsClosed(poll, message);
  const isCreator = !!myUsername && message.u.username === myUsername;
  const maxCount = Math.max(1, ...tally.counts);

  return (
    <div
      data-poll-card
      className={`mt-1 w-full max-w-md rounded-xl border border-line bg-surface-4 p-3 ${
        closed ? 'opacity-80' : ''
      }`}
    >
      <div className="flex items-start gap-2">
        <BarChart3 size={16} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">{poll.question}</div>
          <div className="mt-0.5 text-xs text-ink-3">
            {poll.multi ? '可多选 · ' : '单选 · '}
            {tally.total > 0 ? `${tally.total} 票` : '还没有人投票'}
            {closed && ' · 已结束'}
          </div>
        </div>
        {isCreator && !closed && (
          <button
            title="结束投票"
            onClick={() => void closePoll(message.rid, message._id)}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-line px-2 text-xs text-ink-2 transition hover:bg-fill-hover hover:text-ink"
          >
            <Lock size={12} />
            结束
          </button>
        )}
      </div>

      <div className="mt-2 space-y-1.5">
        {poll.options.map((option, i) => {
          const count = tally.counts[i] ?? 0;
          const mine = tally.myVotes.includes(i);
          const voters = tally.voters[i] ?? [];
          const title = voters.length
            ? voters.map((u) => personName(aliases, u, u, nameFormat)).join('、')
            : '还没有人投';
          return (
            <button
              key={i}
              data-poll-option={i}
              disabled={closed}
              title={title}
              onClick={() => void votePoll(message, i)}
              className={`relative block w-full overflow-hidden rounded-lg border px-2.5 py-1.5 text-left transition ${
                mine
                  ? 'border-primary bg-primary-light'
                  : 'border-line bg-surface-2 hover:border-primary disabled:hover:border-line'
              } ${closed ? 'cursor-default' : ''}`}
            >
              {/* 计票进度条：绝对定位的底色，宽度按最高票归一 */}
              <span
                aria-hidden
                className={`absolute inset-y-0 left-0 transition-[width] duration-300 ${
                  mine ? 'bg-primary/25' : count > 0 && count === maxCount ? 'bg-fill-active' : 'bg-fill-1'
                }`}
                style={{ width: `${(count / maxCount) * 100}%` }}
              />
              <span className="relative flex items-center gap-2">
                <span className="shrink-0">{digitCharAt(i)}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{option}</span>
                {mine && <CheckCircle2 size={14} className="shrink-0 text-primary" />}
                <span className="shrink-0 text-xs font-medium text-ink-2">{count}</span>
              </span>
            </button>
          );
        })}
      </div>
      {closed && (
        <div className="mt-2 text-center text-xs text-ink-3">投票已结束，感谢参与</div>
      )}
    </div>
  );
}
