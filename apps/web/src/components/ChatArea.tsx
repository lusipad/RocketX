import { useState, type DragEvent } from 'react';
import {
  AtSign,
  Files,
  Info,
  MessageCircle,
  MoreHorizontal,
  Pin,
  Search,
  Star,
  Upload,
  Users,
  Video,
} from 'lucide-react';
import { useChat, type RightPanel } from '../stores/chat';
import { displayName, useAliases } from '../stores/aliases';
import Avatar from './Avatar';
import RoomInfoPanel from './RoomInfoPanel';
import MessageList from './MessageList';
import Composer from './Composer';
import ThreadPanel from './ThreadPanel';
import PinPanel from './PinPanel';
import StarredPanel from './StarredPanel';
import MembersPanel from './MembersPanel';
import MentionsPanel from './MentionsPanel';
import FilesPanel from './FilesPanel';
import SearchPanel from './SearchPanel';
import ContextMenu from './ContextMenu';

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

export default function ChatArea() {
  const activeRid = useChat((s) => s.activeRid);
  const rightPanel = useChat((s) => s.rightPanel);
  const setPanel = useChat((s) => s.setPanel);
  const requestUpload = useChat((s) => s.requestUpload);
  const sub = useChat((s) => (s.activeRid ? s.subscriptions[s.activeRid] : undefined));
  const room = useChat((s) => (s.activeRid ? s.rooms[s.activeRid] : undefined));
  const openRoom = useChat((s) => s.openRoom);
  const parentRoom = useChat((s) => {
    if (!s.activeRid) return undefined;
    const p = s.subscriptions[s.activeRid]?.prid ?? s.rooms[s.activeRid]?.prid;
    return p ? s.rooms[p] : undefined;
  });
  const aliases = useAliases((s) => s.aliases);
  const typingMap = useChat((s) => (s.activeRid ? s.typing[s.activeRid] : undefined));
  const typers = typingMap
    ? Object.entries(typingMap)
        .filter(([, expire]) => expire > Date.now())
        .map(([name]) => name)
    : [];
  const [dragging, setDragging] = useState(false);
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);

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

  const rawName = sub?.fname || sub?.name || room?.fname || room?.name || '会话';
  // 多人直聊也是「群」：它有成员数，也不该拿某个人的头像顶上
  const dmSize = room?.uids?.length ?? room?.usersCount;
  const isMultiDM = sub?.t === 'd' && (dmSize !== undefined ? dmSize > 2 : rawName.includes(','));
  const avatarUsername = sub?.t === 'd' && !isMultiDM ? sub.name : undefined;
  const name = displayName(aliases, { rid: activeRid, name: rawName, avatarUsername });
  const memberCount = sub?.t !== 'd' || isMultiDM ? room?.usersCount : undefined;
  const prid = sub?.prid ?? room?.prid;

  const togglePanel = (panel: Exclude<RightPanel, null>) => {
    setPanel(rightPanel?.kind === panel.kind ? null : panel);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) requestUpload(files);
  };

  return (
    <>
      <main
        className="relative flex min-w-0 flex-1 flex-col bg-surface-3"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
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
            <Avatar name={name} username={avatarUsername} size={36} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <button
                onClick={() => togglePanel({ kind: 'info' })}
                className="truncate text-[15px] font-semibold text-ink transition hover:text-primary"
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
            <HeaderButton icon={Video} label="视频会议（规划中）" />
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
        <MessageList rid={activeRid} />
        <Composer />

        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary bg-primary-light/60">
            <Upload size={32} className="text-primary" />
            <span className="text-sm font-medium text-primary">松开即可发送文件</span>
          </div>
        )}
      </main>

      {rightPanel?.kind === 'thread' && <ThreadPanel />}
      {rightPanel?.kind === 'pins' && <PinPanel />}
      {rightPanel?.kind === 'starred' && <StarredPanel />}
      {rightPanel?.kind === 'members' && <MembersPanel />}
      {rightPanel?.kind === 'search' && <SearchPanel />}
      {rightPanel?.kind === 'info' && <RoomInfoPanel />}
      {rightPanel?.kind === 'files' && <FilesPanel />}
      {rightPanel?.kind === 'mentions' && <MentionsPanel />}
    </>
  );
}
