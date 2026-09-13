import { useState } from 'react';
import { MessageCircle, Settings, X } from 'lucide-react';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { useUI } from '../stores/ui';
import { rest } from '../lib/client';
import { personName, useAliases } from '../stores/aliases';
import Avatar from './Avatar';
import { useDialogBehavior } from './Dialog';

const STATUS_TEXT: Record<string, string> = {
  online: '在线',
  away: '离开',
  busy: '忙碌',
  offline: '离线',
};

export interface UserCardTarget {
  /** 用户 id：管理动作（停用/启用账号）需要它，光有 username 不够 */
  _id?: string;
  username: string;
  name?: string;
  status?: string;
  /** 账号是否启用（`users.info` 返回；undefined 表示未知） */
  active?: boolean;
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
  const setPanel = useChat((s) => s.setPanel);
  const setModule = useUI((s) => s.setModule);
  const me = useAuth((s) => s.user);
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogBehavior(onClose);
  const isSelf = user.username === me?.username;
  // 停用/启用账号需要 `edit-other-user-active-status`，全局管理员才有
  const canManageAccount = !!me?.roles?.includes('admin');
  // 备注名在个人卡片也要生效（issue #18.5）
  const shownName = personName(aliases, user.username, user.name || user.username, nameFormat);

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

  const editSelf = () => {
    setModule('settings');
    onClose();
  };

  const toggleActive = async () => {
    if (!user._id) return;
    setBusy(true);
    setError(null);
    try {
      await rest.setUserActiveStatus(user._id, !user.active);
      // 成员面板和会话列表都可能缓存了这个人，重拉一次当前房间的成员
      const rid = useChat.getState().activeRid;
      if (rid) await useChat.getState().refreshMembers(rid).catch(() => undefined);
      setPanel(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '账号状态更新失败');
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
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${shownName}的个人信息`}
        tabIndex={-1}
        className="w-80 overflow-hidden rounded-xl bg-surface-4 shadow-2xl"
      >
        <div className="relative h-20 bg-gradient-to-r from-[#3370ff] to-[#4e83fd]">
          <button
            onClick={onClose}
            aria-label="关闭个人信息"
            className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded text-white/90 hover:bg-white/20"
          >
            <X size={16} />
          </button>
        </div>
        <div className="-mt-8 px-5 pb-5">
          <div className="rounded-xl border-4 border-white" style={{ width: 'fit-content' }}>
            <Avatar name={shownName} username={user.username} size={64} status={user.status} />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-lg font-semibold text-ink">{shownName}</span>
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
          {isSelf ? (
            <button
              onClick={editSelf}
              className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm text-white transition hover:bg-primary-hover"
            >
              <Settings size={16} />
              编辑资料与状态
            </button>
          ) : (
            <>
              <button
                onClick={() => void doDM()}
                disabled={busy}
                className="mt-4 flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm text-white transition hover:bg-primary-hover disabled:opacity-50"
              >
                <MessageCircle size={16} />
                {busy ? '打开中…' : '发消息'}
              </button>
              {/* 停用账号：管理员动作，做成折叠项，避免误点 */}
              {canManageAccount && user._id && (
                <details className="mt-3 border-t border-line pt-3">
                  <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink-2">
                    账号管理（管理员）
                  </summary>
                  <div className="mt-2 space-y-2">
                    <div className="text-xs text-ink-3">
                      当前状态：{user.active === false ? '已停用' : '正常'}
                    </div>
                    <button
                      onClick={() => void toggleActive()}
                      disabled={busy}
                      className={`h-8 w-full rounded-md border px-3 text-xs transition disabled:opacity-50 ${
                        user.active === false
                          ? 'border-line text-ink-2 hover:bg-fill-hover'
                          : 'border-danger text-danger hover:bg-danger/10'
                      }`}
                    >
                      {user.active === false ? '启用账号' : '停用账号'}
                    </button>
                    <div className="text-xs leading-relaxed text-ink-3">
                      停用后该账号无法登录，但历史消息和成员关系保留（不是删除用户）。
                    </div>
                  </div>
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
