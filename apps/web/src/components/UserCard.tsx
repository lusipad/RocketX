import { useState } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { useUI } from '../stores/ui';
import Avatar from './Avatar';

const STATUS_TEXT: Record<string, string> = {
  online: '在线',
  away: '离开',
  busy: '忙碌',
  offline: '离线',
};

export interface UserCardTarget {
  username: string;
  name?: string;
  status?: string;
}

/** 个人卡片（点头像弹出）：飞书交互，带「发消息」直达 */
export default function UserCard({
  user,
  onClose,
}: {
  user: UserCardTarget;
  onClose: () => void;
}) {
  const startDM = useChat((s) => s.startDM);
  const setModule = useUI((s) => s.setModule);
  const me = useAuth((s) => s.user?.username);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSelf = user.username === me;

  const doDM = async () => {
    setBusy(true);
    setError(null);
    try {
      await startDM(user.username);
      setModule('messages');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发起会话失败');
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-80 overflow-hidden rounded-xl bg-surface-4 shadow-2xl">
        <div className="relative h-20 bg-gradient-to-r from-[#3370ff] to-[#4e83fd]">
          <button
            onClick={onClose}
            className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded text-white/90 hover:bg-white/20"
          >
            <X size={16} />
          </button>
        </div>
        <div className="-mt-8 px-5 pb-5">
          <div className="rounded-xl border-4 border-white" style={{ width: 'fit-content' }}>
            <Avatar name={user.name || user.username} username={user.username} size={64} />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-lg font-semibold text-ink">{user.name || user.username}</span>
            {user.status && (
              <span className="flex items-center gap-1 text-xs text-ink-3">
                <span
                  className={`h-2 w-2 rounded-full ${
                    user.status === 'online'
                      ? 'bg-success'
                      : user.status === 'away'
                        ? 'bg-[#ff8800]'
                        : user.status === 'busy'
                          ? 'bg-danger'
                          : 'bg-line'
                  }`}
                />
                {STATUS_TEXT[user.status] ?? user.status}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-sm text-ink-3">@{user.username}</div>
          {error && <div className="mt-2 text-xs text-danger">{error}</div>}
          {!isSelf && (
            <button
              onClick={() => void doDM()}
              disabled={busy}
              className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm text-white transition hover:bg-primary-hover disabled:opacity-50"
            >
              <MessageCircle size={16} />
              {busy ? '打开中…' : '发消息'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
