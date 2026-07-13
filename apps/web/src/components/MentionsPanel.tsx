import { useEffect, useState } from 'react';
import type { RcMessage } from '@rcx/rc-client';
import { AlertCircle, AtSign } from 'lucide-react';
import { rest } from '../lib/client';
import { useChat } from '../stores/chat';
import { humanError } from '../stores/toast';
import PanelShell from './PanelShell';
import MessageResultRow from './MessageResultRow';
import { SkeletonRows } from './Skeleton';

/**
 * 「提及我的」面板：本会话里 @ 到我的消息。
 *
 * 注意跟侧栏那个「@我」筛选器不是一回事 —— 那个筛的是**会话**（哪些群里有人叫我），
 * 这个列的是**消息**（具体是哪几条）。群里几百条消息刷过去，光知道「这个群 @ 过我」没用。
 */
export default function MentionsPanel() {
  const rid = useChat((s) => s.activeRid);

  const [messages, setMessages] = useState<RcMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rid) return;
    setLoading(true);
    setError(null);
    rest
      .getMentionedMessages(rid)
      .then(setMessages)
      .catch((err: unknown) => {
        setMessages([]);
        setError(humanError(err, '无法获取提及消息'));
      })
      .finally(() => setLoading(false));
  }, [rid]);

  return (
    <PanelShell title={`提及我的${messages.length ? `（${messages.length}）` : ''}`}>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && <SkeletonRows rows={4} />}
        {!loading && error && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <AlertCircle size={22} className="text-danger" />
            <div className="max-w-xs text-xs break-words text-ink-3">{error}</div>
          </div>
        )}
        {/* 点一行就跳回原消息：MessageResultRow 自己接了 jumpToMessage */}
        {!loading && !error && messages.map((m) => <MessageResultRow key={m._id} message={m} />)}
        {!loading && !error && messages.length === 0 && (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <AtSign size={22} className="text-ink-3" />
            <div className="text-sm text-ink-3">这个会话里没人 @ 过你</div>
          </div>
        )}
      </div>
    </PanelShell>
  );
}
