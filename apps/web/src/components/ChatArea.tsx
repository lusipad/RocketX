import { useEffect, useState, type DragEvent } from 'react';
import {
  AtSign,
  Bot,
  Files,
  Info,
  MessageCircle,
  MoreHorizontal,
  ListRestart,
  Pin,
  Search,
  Star,
  Upload,
  Users,
} from 'lucide-react';
import { roomMembershipPolicy, useChat, type RightPanel } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { useSharedAgent } from '../stores/sharedAgent';
import { agentRoomSessionKey } from '../stores/agentEnvironments';
import { toast } from '../stores/toast';
import { autoHostEnvironmentId, startRoomAgentHosting } from '../lib/agentHosting';
import { displayName, useAliases } from '../stores/aliases';
import Avatar from './Avatar';
import MessageList from './MessageList';
import Composer from './Composer';
import ContextMenu from './ContextMenu';
import { useKernelContributions } from '../kernel/registry';

function HeaderButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof Pin;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition ${
        active
          ? 'bg-primary-light text-primary'
          : onClick
            ? 'text-ink-2 hover:bg-fill-hover'
            : 'cursor-not-allowed text-ink-2 opacity-60'
      }`}
    >
      <Icon size={17} />
    </button>
  );
}

export default function ChatArea({
  hasUnread,
  onNextUnread,
}: {
  hasUnread: boolean;
  onNextUnread: () => void;
}) {
  const activeRid = useChat((s) => s.activeRid);
  const rightPanel = useChat((s) => s.rightPanel);
  const registeredPanels = useKernelContributions('panel.right');
  const setPanel = useChat((s) => s.setPanel);
  const requestUpload = useChat((s) => s.requestUpload);
  const sub = useChat((s) => (s.activeRid ? s.subscriptions[s.activeRid] : undefined));
  const room = useChat((s) => (s.activeRid ? s.rooms[s.activeRid] : undefined));
  const agentSessionKey = activeRid ? agentRoomSessionKey(activeRid) : '';
  const localAgent = useSharedAgent((s) => (agentSessionKey ? s.sessions[agentSessionKey] : undefined));
  const remoteAgent = useSharedAgent((s) => (agentSessionKey ? s.remoteCards[agentSessionKey] : undefined));
  const endAgentSession = useSharedAgent((s) => s.endSession);
  const me = useAuth((s) => s.user);
  const openRoom = useChat((s) => s.openRoom);
  const joinRoom = useChat((s) => s.joinRoom);
  const parentRoom = useChat((s) => {
    if (!s.activeRid) return undefined;
    const p = s.subscriptions[s.activeRid]?.prid ?? s.rooms[s.activeRid]?.prid;
    return p ? s.rooms[p] : undefined;
  });
  const aliases = useAliases((s) => s.aliases);
  const nameFormat = useAliases((s) => s.nameFormat);
  const typingMap = useChat((s) => (s.activeRid ? s.typing[s.activeRid] : undefined));
  const typers = typingMap
    ? Object.entries(typingMap)
        .filter(([, expire]) => expire > Date.now())
        .map(([name]) => name)
    : [];
  const [dragging, setDragging] = useState(false);
  const [hosting, setHosting] = useState(false);
  const [stoppingHosting, setStoppingHosting] = useState(false);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const ActivePanel = rightPanel
    ? registeredPanels.find((candidate) => candidate.id === rightPanel.kind)?.render
    : undefined;

  const rawName = sub?.fname || sub?.name || room?.fname || room?.name || '会话';

  useEffect(() => {
    if (!activeRid) return;
    const sharedAgent = useSharedAgent.getState();
    const sessionKey = agentRoomSessionKey(activeRid);
    const local = sharedAgent.sessions[sessionKey];
    const remote = sharedAgent.remoteCards[sessionKey];
    if (local && local.status !== 'ended') return;
    if (remote && remote.status !== 'ended' && remote.leaseExpiresAt > Date.now()) return;
    const environmentId = autoHostEnvironmentId(activeRid);
    if (!environmentId) return;
    const chat = useChat.getState();
    const currentRoom = chat.rooms[activeRid];
    const currentSubscription = chat.subscriptions[activeRid];
    const title = currentSubscription?.fname || currentSubscription?.name || currentRoom?.fname || currentRoom?.name || '会话';
    void startRoomAgentHosting(activeRid, title, environmentId).catch((error) => {
      toast.error(error, '自动开启 AI 托管失败');
    });
  }, [activeRid]);

  useEffect(() => {
    if (!dragging) return;
    const clearDragging = () => setDragging(false);
    window.addEventListener('blur', clearDragging);
    window.addEventListener('dragend', clearDragging);
    window.addEventListener('drop', clearDragging);
    return () => {
      window.removeEventListener('blur', clearDragging);
      window.removeEventListener('dragend', clearDragging);
      window.removeEventListener('drop', clearDragging);
    };
  }, [dragging]);

  if (!activeRid) {
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-surface-3">
        <div className="flex h-24 w-24 items-center justify-center rounded-full bg-fill-1">
          <MessageCircle size={40} className="text-ink-3" />
        </div>
        <div className="text-sm text-ink-3">选择一个会话，开始高效沟通</div>
        <div className="text-xs text-ink-3">
          提示：<kbd className="rounded border border-line px-1.5 py-0.5">Ctrl</kbd> +{' '}
          <kbd className="rounded border border-line px-1.5 py-0.5">K</kbd> 快速切换会话
        </div>
      </main>
    );
  }

  // 多人直聊也是「群」：它有成员数，也不该拿某个人的头像顶上
  const dmSize = room?.uids?.length ?? room?.usersCount;
  const isMultiDM = sub?.t === 'd' && (dmSize !== undefined ? dmSize > 2 : rawName.includes(','));
  const avatarUsername = sub?.t === 'd' && !isMultiDM ? sub.name : undefined;
  const name = displayName(aliases, { rid: activeRid, name: rawName, avatarUsername }, nameFormat);
  const memberCount = sub?.t !== 'd' || isMultiDM ? room?.usersCount : undefined;
  const prid = sub?.prid ?? room?.prid;
  const { requiresJoin, canCompose } = roomMembershipPolicy(!!sub, room);
  const localAgentActive = localAgent && localAgent.status !== 'ended' ? localAgent : undefined;
  const remoteAgentActive = remoteAgent && remoteAgent.status !== 'ended' && remoteAgent.leaseExpiresAt > Date.now()
    ? remoteAgent
    : undefined;
  const agentPresence = localAgentActive
    ? {
        username: me?.username ?? localAgentActive.host.userId,
        environmentName: localAgentActive.environmentName,
        status: localAgentActive.status,
      }
    : remoteAgentActive
      ? {
          username: remoteAgentActive.hostUsername,
          environmentName: remoteAgentActive.environmentName,
          status: remoteAgentActive.status,
        }
      : undefined;
  const agentStatus = agentPresence?.status === 'running'
    ? '正在工作'
    : agentPresence?.status === 'waiting-approval'
      ? '等待审批'
      : agentPresence?.status === 'starting'
        ? '正在启动'
        : agentPresence?.status === 'interrupted'
          ? '已中断'
          : agentPresence?.status === 'ready'
            ? '待命'
            : '正在提供服务';
  const agentBusy = ['running', 'starting', 'waiting-approval', 'active'].includes(agentPresence?.status ?? '');

  const togglePanel = (panel: Exclude<RightPanel, null>) => {
    setPanel(rightPanel?.kind === panel.kind ? null : panel);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!canCompose) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) requestUpload(files);
  };

  const startHosting = async () => {
    if (hosting) return;
    setHosting(true);
    try {
      await startRoomAgentHosting(activeRid, rawName);
    } catch (error) {
      toast.error(error, '开启 AI 托管失败');
    } finally {
      setHosting(false);
    }
  };

  const stopHosting = async () => {
    if (!localAgentActive || stoppingHosting) return;
    setStoppingHosting(true);
    try {
      await endAgentSession(agentSessionKey);
    } catch (error) {
      toast.error(error, '退出 AI 托管失败');
    } finally {
      setStoppingHosting(false);
    }
  };

  return (
    <>
      <main
        className="relative flex min-w-0 flex-1 flex-col bg-surface-3"
        onDragOver={(e) => {
          if (canCompose && e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          const nextTarget = e.relatedTarget;
          if (!(nextTarget instanceof Node) || !e.currentTarget.contains(nextTarget)) {
            setDragging(false);
          }
        }}
        onDrop={onDrop}
      >
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
          {/* 头像点开群信息（飞书就是这个交互） */}
          <button
            onClick={() => togglePanel({ kind: 'info' })}
            className="mr-2.5 shrink-0 rounded-lg transition hover:opacity-80"
            title="查看群信息"
          >
            <Avatar
              name={name}
              username={avatarUsername}
              roomId={avatarUsername ? undefined : activeRid}
              size={36}
            />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <button
                onClick={() => togglePanel({ kind: 'info' })}
                className="min-w-0 truncate text-[15px] font-semibold text-ink transition hover:text-primary"
                title="查看群信息"
              >
                {name}
              </button>
              {memberCount ? (
                <button
                  onClick={() => togglePanel({ kind: 'members' })}
                  className={`flex items-center gap-0.5 rounded px-1 text-xs transition hover:bg-fill-hover ${
                    rightPanel?.kind === 'members' ? 'text-primary' : 'text-ink-3'
                  }`}
                  title="查看群成员"
                >
                  <Users size={13} />
                  {memberCount}
                </button>
              ) : null}
              {!agentPresence ? (
                <button
                  aria-label="开启 AI 托管"
                  title="让本机 AI 从当前会话继续提供服务"
                  disabled={hosting}
                  onClick={() => void startHosting()}
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-ink-2 transition hover:border-primary/40 hover:bg-primary-light hover:text-primary"
                >
                  <Bot size={13} />
                  {hosting ? '正在开启…' : 'AI 托管'}
                </button>
              ) : null}
              {agentPresence ? (
                <button
                  aria-label={localAgentActive ? '关闭 AI 托管' : `@${agentPresence.username} 的 AI ${agentStatus}`}
                  title={localAgentActive
                    ? `点击退出 AI 托管 · ${stoppingHosting ? '正在关闭' : agentStatus}${agentPresence.environmentName ? ` · ${agentPresence.environmentName}` : ''}`
                    : `@${agentPresence.username} 的 AI · ${agentStatus}${agentPresence.environmentName ? ` · ${agentPresence.environmentName}` : ''}`}
                  disabled={!localAgentActive || stoppingHosting}
                  onClick={() => void stopHosting()}
                  className="flex h-7 max-w-[300px] shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-gradient-to-r from-primary-light to-surface px-2.5 text-xs text-primary shadow-sm disabled:cursor-default"
                >
                  <span className="relative flex h-2 w-2 shrink-0">
                    {agentBusy ? <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-50" /> : null}
                    <span className={`relative inline-flex h-2 w-2 rounded-full ${agentPresence.status === 'interrupted' ? 'bg-ink-3' : agentPresence.status === 'waiting-approval' ? 'bg-warning' : 'bg-primary'}`} />
                  </span>
                  <Bot size={13} className="shrink-0" />
                  <span className="shrink-0 font-semibold">@{agentPresence.username} 的 AI</span>
                  <span className="h-3 w-px shrink-0 bg-primary/25" />
                  <span className="shrink-0 text-2xs font-medium">{stoppingHosting ? '正在关闭' : agentStatus}</span>
                  {agentPresence.environmentName ? (
                    <span className="hidden min-w-0 truncate border-l border-primary/20 pl-1.5 text-2xs text-ink-3 2xl:inline">
                      {agentPresence.environmentName}
                    </span>
                  ) : null}
                </button>
              ) : null}
            </div>
            {typers.length > 0 ? (
              <div className="truncate text-xs text-primary">
                {typers.slice(0, 3).join('、')} 正在输入…
              </div>
            ) : prid ? (
              <button
                onClick={() => void openRoom(prid)}
                className="flex items-center gap-1 truncate text-xs text-ink-3 hover:text-primary"
                title="回到主会话"
              >
                <span className="rounded bg-primary-light px-1 text-2xs text-primary">讨论</span>
                来自 {parentRoom?.fname || parentRoom?.name || '主会话'}
              </button>
            ) : (
              room?.topic && <div className="truncate text-xs text-ink-3">{room.topic}</div>
            )}
          </div>
          <div className="flex items-center gap-1">
            {hasUnread ? (
              <HeaderButton
                icon={ListRestart}
                label="下一条未读 (Ctrl+Shift+↓)"
                onClick={onNextUnread}
              />
            ) : null}
            <HeaderButton
              icon={Pin}
              label="置顶消息"
              active={rightPanel?.kind === 'pins'}
              onClick={() => togglePanel({ kind: 'pins' })}
            />
            <HeaderButton
              icon={Search}
              label="搜索聊天记录"
              active={rightPanel?.kind === 'search'}
              onClick={() => togglePanel({ kind: 'search' })}
            />
            <HeaderButton
              icon={Bot}
              label="AI"
              active={rightPanel?.kind === 'butler'}
              onClick={() => togglePanel({ kind: 'butler' })}
            />
            <HeaderButton
              icon={MoreHorizontal}
              label="更多"
              active={rightPanel?.kind === 'starred'}
              onClick={() => {
                setMoreMenu(null);
                const btn = document.activeElement as HTMLElement;
                const rect = btn?.getBoundingClientRect();
                setMoreMenu(rect ? { x: rect.right - 140, y: rect.bottom + 4 } : { x: 0, y: 0 });
              }}
            />
          </div>
        </header>
        {moreMenu && (
          <ContextMenu
            x={moreMenu.x}
            y={moreMenu.y}
            items={[
              {
                label: sub?.t === 'd' && !isMultiDM ? '联系人信息' : '群信息',
                icon: Info,
                onClick: () => togglePanel({ kind: 'info' }),
              },
              {
                label: '群成员',
                icon: Users,
                onClick: () => togglePanel({ kind: 'members' }),
              },
              {
                label: '标记消息',
                icon: Star,
                onClick: () => togglePanel({ kind: 'starred' }),
              },
              {
                label: '文件',
                icon: Files,
                onClick: () => togglePanel({ kind: 'files' }),
              },
              {
                label: '提及我的',
                icon: AtSign,
                onClick: () => togglePanel({ kind: 'mentions' }),
              },
            ]}
            onClose={() => setMoreMenu(null)}
          />
        )}
        <MessageList key={activeRid} rid={activeRid} />
        {/* 从讨论卡片/搜索进来但还没加入的公开房间：给出加入入口（issue #19-6）。
            不加入也能看历史，但收不到通知、不在会话列表里。 */}
        {requiresJoin && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line bg-primary-light/40 px-4 py-2.5">
            <span className="min-w-0 truncate text-sm text-ink-2">
              你还不是{prid ? '这个讨论' : '这个频道'}的成员，加入后才会收到新消息提醒
            </span>
            <button
              onClick={() => void joinRoom(activeRid)}
              className="h-7 shrink-0 rounded-md bg-primary px-3 text-xs text-white transition hover:bg-primary-hover"
            >
              加入{prid ? '讨论' : '频道'}
            </button>
          </div>
        )}
        {canCompose && <Composer />}

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary-light/60">
            <Upload size={32} className="text-primary" />
            <span className="text-sm font-medium text-primary">松开即可发送文件</span>
          </div>
        )}
      </main>

      {ActivePanel && <ActivePanel />}
    </>
  );
}
