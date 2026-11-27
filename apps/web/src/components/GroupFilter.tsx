import { useEffect, useMemo, useState } from 'react';
import {
  AtSign,
  ChevronDown,
  ChevronUp,
  Folder as FolderIcon,
  FolderPlus,
  Hash,
  EyeOff,
  MessageSquareText,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Star,
  RefreshCw,
  Trash2,
  User,
  Users,
  UsersRound,
  Wand2,
} from 'lucide-react';
import { buildConversations, useChat } from '../stores/chat';
import { useT, type MessageKey } from '../i18n';
import { inFolder, useFolders } from '../stores/folders';
import { useUI, type ConvFilter } from '../stores/ui';
import { toast } from '../stores/toast';
import ContextMenu, { type MenuItem } from './ContextMenu';
import { ConfirmDialog, useDialogBehavior } from './Dialog';
import FolderRulesDialog from './FolderRulesDialog';

const FILTERS: { key: ConvFilter; labelKey: MessageKey; icon: typeof AtSign }[] = [
  { key: 'all', labelKey: 'chat.filter.all', icon: MessageSquareText },
  { key: 'unread', labelKey: 'chat.filter.unread', icon: RefreshCw },
  { key: 'mentions', labelKey: 'chat.filter.mentions', icon: AtSign },
  // 图钉在本应用里已经代表「置顶」，收藏改用星标，两个概念别共用一个图标
  { key: 'favorites', labelKey: 'chat.filter.favorites', icon: Star },
  { key: 'dm', labelKey: 'chat.filter.dm', icon: User },
  { key: 'multi', labelKey: 'chat.filter.multi', icon: UsersRound },
  { key: 'groups', labelKey: 'chat.filter.groups', icon: Hash },
  { key: 'teams', labelKey: 'chat.filter.teams', icon: Users },
  { key: 'discussions', labelKey: 'chat.filter.discussions', icon: MessagesSquare },
  { key: 'hidden', labelKey: 'chat.filter.hidden', icon: EyeOff },
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
  const t = useT();
  const [name, setName] = useState(initial ?? '');
  const dialogRef = useDialogBehavior(onClose);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-xs"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="w-80 rounded-2xl border border-line bg-surface-4 p-5 shadow-pop"
      >
        <div className="mb-3 text-base font-semibold text-ink">{title}</div>
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
          placeholder={t('chat.groupFilter.folderPlaceholder')}
          maxLength={20}
          className="h-9 w-full rounded-md border border-line px-3 text-sm outline-none focus:border-primary"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 hover:bg-fill-hover"
          >
            {t('common.cancel')}
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
            {t('common.ok')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 飞书式「分组」栏：系统过滤器 + 自定义分组 */
export default function GroupFilter({
  collapsed,
  onCollapse,
}: {
  collapsed: boolean;
  onCollapse: () => void;
}) {
  const t = useT();
  const subscriptions = useChat((s) => s.subscriptions);
  const rooms = useChat((s) => s.rooms);
  const filter = useUI((s) => s.convFilter);
  const setFilter = useUI((s) => s.setConvFilter);
  const activeFolder = useUI((s) => s.activeFolder);
  const setActiveFolder = useUI((s) => s.setActiveFolder);
  const retainUnread = useUI((s) => s.retainUnread);
  const activeRid = useChat((s) => s.activeRid);

  const folders = useFolders((s) => s.folders);
  const create = useFolders((s) => s.create);
  const rename = useFolders((s) => s.rename);
  const remove = useFolders((s) => s.remove);
  const move = useFolders((s) => s.move);
  const addRoom = useFolders((s) => s.addRoom);
  const prune = useFolders((s) => s.prune);

  // 订阅变化后清理分组里已经不存在的会话，否则计数虚高、点进去是空的
  useEffect(() => {
    const rids = Object.keys(subscriptions);
    if (rids.length > 0) prune(new Set(rids));
  }, [subscriptions, prune]);

  const [dialog, setDialog] = useState<{ mode: 'create' | 'rename'; id?: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [rulesFor, setRulesFor] = useState<string | null>(null);

  const counts = useMemo(() => {
    const convs = buildConversations(subscriptions, rooms);
    const hidden = buildConversations(subscriptions, rooms, true).filter((c) => c.hidden);
    return {
      all: 0,
      unread: convs.filter((c) => c.unread > 0 || c.alert).length,
      mentions: convs.reduce((n, c) => n + c.userMentions, 0),
      favorites: convs.filter((c) => c.favorite).length,
      dm: convs.filter((c) => c.type === 'd' && !c.isMultiDM).length,
      multi: convs.filter((c) => c.isMultiDM).length,
      groups: convs.filter(
        (c) => (c.type === 'c' || c.type === 'p') && !c.isTeam && !c.isDiscussion,
      ).length,
      teams: convs.filter((c) => c.isTeam || !!c.teamId).length,
      discussions: convs.filter((c) => c.isDiscussion).length,
      hidden: hidden.length,
    } as Record<ConvFilter, number>;
  }, [subscriptions, rooms]);

  // 分组计数要按「实际会渲染出来的条数」算：手工拖入 + 规则命中，且会话确实存在
  const folderCounts = useMemo(() => {
    const convs = buildConversations(subscriptions, rooms);
    const out: Record<string, number> = {};
    for (const f of folders) out[f.id] = convs.filter((c) => inFolder(f, c)).length;
    return out;
  }, [subscriptions, rooms, folders]);

  const folderMenuItems = (id: string): MenuItem[] => [
    { label: t('chat.groupFilter.rename'), icon: Pencil, onClick: () => setDialog({ mode: 'rename', id }) },
    { label: t('chat.groupFilter.rules'), icon: Wand2, onClick: () => setRulesFor(id) },
    { label: t('chat.groupFilter.moveUp'), icon: ChevronUp, onClick: () => move(id, -1) },
    { label: t('chat.groupFilter.moveDown'), icon: ChevronDown, onClick: () => move(id, 1) },
    {
      label: t('chat.groupFilter.deleteFolder'),
      icon: Trash2,
      danger: true,
      onClick: () => setConfirmDelete(id),
    },
  ];

  const btnCls = (active: boolean) =>
    `flex h-8 items-center gap-2 rounded-xl px-2.5 text-xs transition ${
      active
        ? 'bg-surface-4 font-medium text-ink shadow-raise ring-1 ring-line/80'
        : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
    }`;

  const compactBtnCls = (active: boolean) =>
    `relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition ${
      active
        ? 'bg-surface-4 text-primary shadow-raise ring-1 ring-line/80'
        : 'text-ink-2 hover:bg-fill-hover hover:text-primary'
    }`;

  const selectFilter = (key: ConvFilter) => {
    setActiveFolder(null);
    if (key === 'unread' && activeRid) {
      const active = subscriptions[activeRid];
      retainUnread(active && (active.unread > 0 || active.alert) ? activeRid : null);
    }
    setFilter(key);
  };

  // 窄条只给未读/@ 这类需要注意的数字留角标，会话总数不展示。
  const compactCount = (count: number) =>
    count > 0 ? (
      <span
        className="absolute -right-1 -top-1 min-w-3.5 rounded-full bg-danger px-0.5 text-center text-2xs leading-3 text-surface-4"
      >
        {count > 9 ? '9+' : count}
      </span>
    ) : null;

  const renderFolderButton = (folder: (typeof folders)[number], compact: boolean) => {
    const active = activeFolder === folder.id;
    const isDragOver = dragOver === folder.id;
    const count = folderCounts[folder.id];
    const dragProps = {
      onDragOver: (event: React.DragEvent<HTMLButtonElement>) => {
        event.preventDefault();
        setDragOver(folder.id);
      },
      onDragLeave: () => setDragOver(null),
      onDrop: (event: React.DragEvent<HTMLButtonElement>) => {
        event.preventDefault();
        setDragOver(null);
        const rid = event.dataTransfer.getData('text/rcx-rid');
        if (rid) addRoom(folder.id, rid);
      },
    };

    if (compact) {
      return (
        <button
          key={folder.id}
          onClick={() => setActiveFolder(folder.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, id: folder.id });
          }}
          {...dragProps}
          title={folder.name}
          aria-label={t('chat.groupFilter.folderAriaLabel', { name: folder.name })}
          className={`${compactBtnCls(active)} ${isDragOver ? 'ring-2 ring-primary ring-inset' : ''}`}
        >
          <FolderIcon size={16} />
        </button>
      );
    }

    return (
      <button
        key={folder.id}
        onClick={() => setActiveFolder(folder.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, id: folder.id });
        }}
        {...dragProps}
        className={`${btnCls(active)} ${isDragOver ? 'ring-2 ring-primary ring-inset' : ''}`}
        title={t('chat.groupFilter.folderTooltip')}
      >
        <FolderIcon size={14} className={active ? 'text-primary' : ''} />
        <span className="min-w-0 truncate">{folder.name}</span>
        {folder.rules?.length ? <Wand2 size={12} className="shrink-0 text-ink-3" /> : null}
        {count > 0 && <span className="ml-auto text-xs text-ink-3">{count}</span>}
      </button>
    );
  };

  return (
    <aside className={`flex shrink-0 flex-col border-r border-line bg-surface-2 ${
      collapsed ? 'w-12 min-h-0 overflow-x-hidden p-2' : 'w-[156px] px-2.5 py-3'
    }`}>
      {collapsed ? (
        <>
          <div className="flex flex-col items-center gap-0.5">
            {FILTERS.map(({ key, labelKey, icon: Icon }) => {
              const label = t(labelKey);
              const active = !activeFolder && key === filter;
              const count = counts[key];
              const highlight = key === 'unread' || key === 'mentions';
              return (
                <button
                  key={key}
                  onClick={() => selectFilter(key)}
                  title={label}
                  aria-label={
                    highlight && count > 0
                      ? t('chat.groupFilter.unreadFilterAria', { label, count })
                      : label
                  }
                  className={compactBtnCls(active)}
                >
                  <Icon size={16} />
                  {highlight ? compactCount(count) : null}
                </button>
              );
            })}
          </div>

          <div className="mt-2 flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto border-t border-line pt-2">
            <div className="flex flex-col items-center gap-0.5">
              {folders.map((folder) => renderFolderButton(folder, true))}
            </div>
          </div>

          <div className="mt-auto flex flex-col items-center gap-1 border-t border-line pt-2">
            <button
              title={t('chat.groupFilter.expand')}
              aria-label={t('chat.groupFilter.expand')}
              onClick={onCollapse}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-3 transition hover:bg-fill-hover hover:text-primary"
            >
              <PanelLeftOpen size={16} />
            </button>
            <button
              title={t('chat.groupFilter.newFolder')}
              aria-label={t('chat.groupFilter.newFolder')}
              onClick={() => setDialog({ mode: 'create' })}
              className="flex h-8 w-8 items-center justify-center rounded-md text-ink-3 transition hover:bg-fill-hover hover:text-primary"
            >
              <FolderPlus size={16} />
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between px-2 pb-2">
            <span className="text-xs font-medium text-ink">{t('chat.groupFilter.title')}</span>
            <div className="flex items-center gap-0.5">
              <button
                title={t('chat.groupFilter.collapse')}
                aria-label={t('chat.groupFilter.collapse')}
                onClick={onCollapse}
                className="flex h-6 w-6 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
              >
                <PanelLeftClose size={14} />
              </button>
              <button
                title={t('chat.groupFilter.newFolder')}
                aria-label={t('chat.groupFilter.newFolder')}
                onClick={() => setDialog({ mode: 'create' })}
                className="flex h-6 w-6 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary"
              >
                <FolderPlus size={14} />
              </button>
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
            {FILTERS.map(({ key, labelKey, icon: Icon }) => {
              const label = t(labelKey);
              const active = !activeFolder && key === filter;
              const count = counts[key];
              const highlight = (key === 'unread' || key === 'mentions') && count > 0;
              return (
                <button key={key} onClick={() => selectFilter(key)} className={btnCls(active)}>
                  <Icon size={14} className={active ? 'text-primary' : ''} />
                  {label}
                  {count > 0 && (
                    <span className={`ml-auto text-xs ${
                      highlight ? 'font-medium text-danger' : 'text-ink-3'
                    }`}>
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                </button>
              );
            })}

            {/* 自定义分组：可拖拽会话进来 */}
            {folders.length > 0 && (
              <div className="mt-2 px-2 pb-1 text-xs text-ink-3">{t('chat.groupFilter.myFolders')}</div>
            )}
            {folders.map((folder) => renderFolderButton(folder, false))}

            {folders.length === 0 && (
              <div className="mt-2 px-2 text-xs text-ink-3">{t('chat.groupFilter.noCustomFolders')}</div>
            )}
          </div>
        </>
      )}

      {dialog && (
        <FolderDialog
          title={dialog.mode === 'create' ? t('chat.groupFilter.newFolder') : t('chat.groupFilter.renameFolder')}
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
      {rulesFor && folders.find((f) => f.id === rulesFor) && (
        <FolderRulesDialog
          folder={folders.find((f) => f.id === rulesFor)!}
          onClose={() => setRulesFor(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('chat.groupFilter.deleteFolder')}
          message={t('chat.groupFilter.deleteConfirm', {
            name: folders.find((f) => f.id === confirmDelete)?.name ?? '',
          })}
          confirmLabel={t('common.delete')}
          onConfirm={() => {
            remove(confirmDelete);
            if (activeFolder === confirmDelete) setActiveFolder(null);
            toast.success(t('chat.groupFilter.deletedToast'));
          }}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </aside>
  );
}
