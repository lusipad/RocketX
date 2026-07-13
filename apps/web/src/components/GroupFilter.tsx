import { useMemo, useState } from 'react';
import {
  AtSign,
  ChevronDown,
  ChevronUp,
  Folder as FolderIcon,
  FolderPlus,
  Hash,
  MessageSquareText,
  MessagesSquare,
  Pencil,
  Pin,
  RefreshCw,
  Trash2,
  User,
  Users,
} from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import { useFolders } from '../stores/folders';
import { useUI, type ConvFilter } from '../stores/ui';
import { toast } from '../stores/toast';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { ConfirmDialog } from './Dialog';

const FILTERS: { key: ConvFilter; label: string; icon: typeof AtSign }[] = [
  { key: 'all', label: '消息', icon: MessageSquareText },
  { key: 'unread', label: '未读', icon: RefreshCw },
  { key: 'mentions', label: '@我', icon: AtSign },
  { key: 'favorites', label: '收藏', icon: Pin },
  { key: 'dm', label: '单聊', icon: User },
  { key: 'groups', label: '群组', icon: Hash },
  { key: 'teams', label: '团队', icon: Users },
  { key: 'discussions', label: '讨论', icon: MessagesSquare },
];

/** 新建 / 重命名分组弹窗 */
function FolderDialog({
  title,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  initial?: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial ?? '');
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-80 rounded-xl bg-surface-4 p-5 shadow-2xl">
        <div className="mb-3 text-[15px] font-semibold text-ink">{title}</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) {
              onSubmit(name);
              onClose();
            } else if (e.key === 'Escape') onClose();
          }}
          placeholder="分组名称，如「核心项目」"
          maxLength={20}
          className="h-9 w-full rounded-md border border-line px-3 text-sm outline-none focus:border-primary"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={() => {
              if (name.trim()) {
                onSubmit(name);
                onClose();
              }
            }}
            disabled={!name.trim()}
            className="h-8 rounded-md bg-primary px-4 text-sm text-white hover:bg-primary-hover disabled:opacity-40"
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}

/** 飞书式「分组」栏：系统过滤器 + 自定义分组 */
export default function GroupFilter() {
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const filter = useUI((s) => s.convFilter);
  const setFilter = useUI((s) => s.setConvFilter);
  const activeFolder = useUI((s) => s.activeFolder);
  const setActiveFolder = useUI((s) => s.setActiveFolder);

  const folders = useFolders((s) => s.folders);
  const create = useFolders((s) => s.create);
  const rename = useFolders((s) => s.rename);
  const remove = useFolders((s) => s.remove);
  const move = useFolders((s) => s.move);
  const addRoom = useFolders((s) => s.addRoom);

  const [dialog, setDialog] = useState<{ mode: 'create' | 'rename'; id?: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const counts = useMemo(() => {
    const convs = buildConversations(subscriptions, rooms);
    return {
      all: 0,
      unread: convs.filter((c) => c.unread > 0 || c.alert).length,
      mentions: convs.reduce((n, c) => n + c.userMentions, 0),
      favorites: convs.filter((c) => c.favorite).length,
      dm: convs.filter((c) => c.type === 'd').length,
      groups: convs.filter(
        (c) => (c.type === 'c' || c.type === 'p') && !c.isTeam && !c.isDiscussion,
      ).length,
      teams: convs.filter((c) => c.isTeam || !!c.teamId).length,
      discussions: convs.filter((c) => c.isDiscussion).length,
    } as Record<ConvFilter, number>;
  }, [subscriptions, rooms]);

  const folderMenuItems = (id: string): MenuItem[] => [
    { label: '重命名', icon: Pencil, onClick: () => setDialog({ mode: 'rename', id }) },
    { label: '上移', icon: ChevronUp, onClick: () => move(id, -1) },
    { label: '下移', icon: ChevronDown, onClick: () => move(id, 1) },
    {
      label: '删除分组',
      icon: Trash2,
      danger: true,
      onClick: () => setConfirmDelete(id),
    },
  ];

  const btnCls = (active: boolean) =>
    `flex h-8 items-center gap-2 rounded-md px-2 text-[13px] transition ${
      active ? 'bg-fill-active font-medium text-ink' : 'text-ink-2 hover:bg-fill-hover'
    }`;

  return (
    <aside className="flex w-[150px] shrink-0 flex-col border-r border-line bg-surface-2 px-2 py-3">
      <div className="flex items-center justify-between px-2 pb-2">
        <span className="text-[13px] font-medium text-ink">分组</span>
        <button
          title="新建分组"
          onClick={() => setDialog({ mode: 'create' })}
          className="flex h-6 w-6 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
        >
          <FolderPlus size={13} />
        </button>
      </div>

      <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {FILTERS.map(({ key, label, icon: Icon }) => {
          const active = !activeFolder && key === filter;
          const count = counts[key];
          const highlight = (key === 'unread' || key === 'mentions') && count > 0;
          return (
            <button
              key={key}
              onClick={() => {
                setActiveFolder(null);
                setFilter(key);
              }}
              className={btnCls(active)}
            >
              <Icon size={14} className={active ? 'text-primary' : ''} />
              {label}
              {count > 0 && (
                <span
                  className={`ml-auto text-[11px] ${
                    highlight ? 'font-medium text-danger' : 'text-ink-3'
                  }`}
                >
                  {count > 99 ? '99+' : count}
                </span>
              )}
            </button>
          );
        })}

        {/* 自定义分组：可拖拽会话进来 */}
        {folders.length > 0 && (
          <div className="mt-2 px-2 pb-1 text-[11px] text-ink-3">我的分组</div>
        )}
        {folders.map((f) => {
          const active = activeFolder === f.id;
          const isDragOver = dragOver === f.id;
          return (
            <button
              key={f.id}
              onClick={() => setActiveFolder(f.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, id: f.id });
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(f.id);
              }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const rid = e.dataTransfer.getData('text/rcx-rid');
                if (rid) addRoom(f.id, rid);
              }}
              className={`${btnCls(active)} ${
                isDragOver ? 'ring-2 ring-primary ring-inset' : ''
              }`}
              title="把会话拖到这里加入分组；右键管理"
            >
              <FolderIcon size={14} className={active ? 'text-primary' : ''} />
              <span className="min-w-0 truncate">{f.name}</span>
              {f.rids.length > 0 && (
                <span className="ml-auto text-[11px] text-ink-3">{f.rids.length}</span>
              )}
            </button>
          );
        })}

        {folders.length === 0 && (
          <div className="mt-2 px-2 text-[11px] leading-relaxed text-ink-3">
            点右上角 <FolderPlus size={11} className="inline" /> 新建分组，
            把会话拖进来分类
          </div>
        )}
      </div>

      {dialog && (
        <FolderDialog
          title={dialog.mode === 'create' ? '新建分组' : '重命名分组'}
          initial={dialog.mode === 'rename' ? folders.find((f) => f.id === dialog.id)?.name : ''}
          onSubmit={(name) => {
            if (dialog.mode === 'create') {
              const id = create(name);
              setActiveFolder(id);
            } else if (dialog.id) {
              rename(dialog.id, name);
            }
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={folderMenuItems(menu.id)}
          onClose={() => setMenu(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="删除分组"
          message={`确定删除分组「${folders.find((f) => f.id === confirmDelete)?.name}」吗？分组里的会话不会被删除，只是不再归入该分组。`}
          confirmLabel="删除"
          onConfirm={() => {
            remove(confirmDelete);
            if (activeFolder === confirmDelete) setActiveFolder(null);
            toast.success('分组已删除');
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </aside>
  );
}
