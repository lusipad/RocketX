import { useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { tsMs, type RcMessage, type RcMessageAttachment } from '@rcx/rc-client';
import {
  Check,
  Copy,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Pin,
  Share2,
  SmilePlus,
  Star,
  Trash2,
} from 'lucide-react';
import { fmtTime } from '../lib/format';
import { emojiFromShortcode, type EmojiEntry } from '../lib/emoji';
import { renderMarkdown, LinkifiedText } from '../lib/markdown';
import { assetUrl } from '../lib/client';
import { useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import Avatar from './Avatar';
import EmojiPicker from './EmojiPicker';
import ContextMenu, { type MenuItem } from './ContextMenu';
import ForwardDialog from './ForwardDialog';
import UserCard from './UserCard';

/** 悬浮栏直达的快捷表情（飞书习惯） */
const QUICK_EMOJIS: EmojiEntry[] = [
  { code: 'thumbsup', char: '👍' },
  { code: 'white_check_mark', char: '✅' },
  { code: 'tada', char: '🎉' },
];

/** 站内相对路径（/file-upload 等）转为服务器绝对地址，桌面端直连需要 */
function resolveUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  return url.startsWith('/') ? assetUrl(url) : url;
}

/** 附件卡片：文件/图片上传与 ADO 集成消息的富文本载体 */
function AttachmentCard({ att }: { att: RcMessageAttachment }) {
  return (
    <div
      className="mt-1.5 max-w-md rounded-lg border border-line bg-white p-3"
      style={{ borderLeft: `3px solid ${att.color ?? '#3370ff'}` }}
    >
      {att.author_name && <div className="mb-1 text-xs text-ink-3">{att.author_name}</div>}
      {att.title &&
        (att.title_link ? (
          <a
            href={resolveUrl(att.title_link)}
            target="_blank"
            rel="noreferrer"
            className="block text-sm font-medium text-primary hover:underline"
          >
            {att.title}
          </a>
        ) : (
          <div className="text-sm font-medium text-ink">{att.title}</div>
        ))}
      {att.text && (
        <div className="mt-1 text-sm whitespace-pre-wrap text-ink-2">
          <LinkifiedText text={att.text} />
        </div>
      )}
      {att.fields && att.fields.length > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5">
          {att.fields.map((f, i) => (
            <div key={i} className={f.short === false ? 'col-span-2' : ''}>
              <div className="text-xs text-ink-3">{f.title}</div>
              <div className="text-sm text-ink">{f.value}</div>
            </div>
          ))}
        </div>
      )}
      {att.image_url && (
        <a href={resolveUrl(att.image_url)} target="_blank" rel="noreferrer">
          <img
            src={resolveUrl(att.image_url)}
            alt={att.title ?? ''}
            className="mt-2 max-h-64 max-w-full rounded-md"
          />
        </a>
      )}
    </div>
  );
}

function Reactions({ message }: { message: RcMessage }) {
  const toggleReaction = useChat((s) => s.toggleReaction);
  const myUsername = useAuth((s) => s.user?.username);
  if (!message.reactions) return null;
  const entries = Object.entries(message.reactions);
  if (entries.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.map(([code, { usernames }]) => {
        const reacted = !!myUsername && usernames.includes(myUsername);
        return (
          <button
            key={code}
            onClick={() => void toggleReaction(message._id, code)}
            title={usernames.join('、')}
            className={`flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition ${
              reacted
                ? 'border-primary bg-primary-light text-primary'
                : 'border-line bg-white text-ink-2 hover:border-primary'
            }`}
          >
            <span>{emojiFromShortcode(code)}</span>
            <span>{usernames.length}</span>
          </button>
        );
      })}
    </div>
  );
}

function ConfirmDeleteDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-80 rounded-xl bg-white p-5 shadow-2xl">
        <div className="text-[15px] font-semibold text-ink">删除消息</div>
        <div className="mt-2 text-sm text-ink-2">确定删除这条消息吗？删除后不可恢复。</div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="h-8 rounded-md border border-line px-4 text-sm text-ink-2 transition hover:bg-fill-hover"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="h-8 rounded-md bg-danger px-4 text-sm text-white transition hover:opacity-90"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

function EditBox({ message, onDone }: { message: RcMessage; onDone: () => void }) {
  const editMessage = useChat((s) => s.editMessage);
  const [value, setValue] = useState(message.msg);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (value.trim() && value !== message.msg) void editMessage(message._id, value);
      onDone();
    } else if (e.key === 'Escape') {
      onDone();
    }
  };

  return (
    <div className="w-72">
      <textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={Math.min(6, Math.max(2, value.split('\n').length))}
        className="w-full resize-none rounded-md border border-primary bg-white px-2.5 py-1.5 text-sm outline-none"
      />
      <div className="mt-0.5 text-[11px] text-ink-3">Enter 保存 · Esc 取消</div>
    </div>
  );
}

export default function MessageItem({
  message,
  mine,
  grouped,
  inThread = false,
}: {
  message: RcMessage;
  mine: boolean;
  grouped: boolean;
  inThread?: boolean;
}) {
  const myUsername = useAuth((s) => s.user?.username);
  const myId = useAuth((s) => s.user?._id);
  const openThread = useChat((s) => s.openThread);
  const toggleReaction = useChat((s) => s.toggleReaction);
  const togglePin = useChat((s) => s.togglePin);
  const toggleStar = useChat((s) => s.toggleStar);
  const deleteMessage = useChat((s) => s.deleteMessage);

  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [forwarding, setForwarding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showCard, setShowCard] = useState(false);

  const displayName = message.u.name || message.u.username;
  const time = fmtTime(tsMs(message.ts));

  const copy = () => {
    void navigator.clipboard?.writeText(message.msg ?? '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const menuItems: MenuItem[] = [
    ...(!inThread
      ? [
          {
            label: '在话题中回复',
            icon: MessageSquareText,
            onClick: () => void openThread(message.tmid ?? message._id),
          },
        ]
      : []),
    { label: '转发', icon: Share2, onClick: () => setForwarding(true) },
    ...(message.msg ? [{ label: copied ? '已复制' : '复制', icon: Copy, onClick: copy }] : []),
    {
      label: message.pinned ? '取消置顶' : '置顶',
      icon: Pin,
      onClick: () => void togglePin(message),
    },
    {
      label: message.starred?.some((s) => s._id === myId) ? '取消标记' : '标记',
      icon: Star,
      onClick: () => void toggleStar(message),
    },
    ...(mine && message.msg
      ? [{ label: '编辑', icon: Pencil, onClick: () => setEditing(true) }]
      : []),
    ...(mine
      ? [{ label: '删除', icon: Trash2, danger: true, onClick: () => setConfirmDelete(true) }]
      : []),
  ];

  const onContextMenu = (e: ReactMouseEvent) => {
    // 附件卡片里的链接保持浏览器默认右键
    if ((e.target as HTMLElement).closest('a')) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const hoverBtn =
    'flex h-7 w-7 items-center justify-center rounded text-ink-2 transition hover:bg-fill-hover hover:text-ink';

  return (
    <div
      onContextMenu={onContextMenu}
      className={`group flex gap-2.5 px-1 ${grouped ? 'mt-0.5' : 'mt-3'} ${
        mine ? 'flex-row-reverse' : ''
      }`}
    >
      {/* 头像列：分组消息用占位保持对齐；点击弹个人卡片 */}
      <div className="w-9 shrink-0">
        {!grouped && (
          <button onClick={() => setShowCard(true)} className="block cursor-pointer">
            <Avatar name={displayName} username={message.u.username} size={36} />
          </button>
        )}
      </div>

      <div className={`flex max-w-[68%] min-w-0 flex-col ${mine ? 'items-end' : 'items-start'}`}>
        {!grouped && (
          <div className={`mb-1 flex items-baseline gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
            <span className="text-xs text-ink-2">{mine ? '' : displayName}</span>
            <span className="text-xs text-ink-3">{time}</span>
          </div>
        )}

        <div className={`relative flex items-end gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
          {/* 悬浮操作栏：快捷表情 + 回复/转发/更多 */}
          {!editing && (
            <div
              className={`absolute -top-8 z-10 hidden group-hover:flex ${
                mine ? 'right-0' : 'left-0'
              }`}
            >
              <div className="relative flex items-center gap-0.5 rounded-lg border border-line bg-white p-0.5 shadow-[0_2px_8px_rgba(31,35,41,0.1)]">
                {QUICK_EMOJIS.map((e) => (
                  <button
                    key={e.code}
                    title={`:${e.code}:`}
                    className="flex h-7 w-7 items-center justify-center rounded text-base transition hover:bg-fill-hover"
                    onClick={() => void toggleReaction(message._id, `:${e.code}:`)}
                  >
                    {e.char}
                  </button>
                ))}
                <button title="更多表情" className={hoverBtn} onClick={() => setPicker((v) => !v)}>
                  <SmilePlus size={15} />
                </button>
                <div className="mx-0.5 h-4 w-px bg-line" />
                {!inThread && (
                  <button
                    title="在话题中回复"
                    className={hoverBtn}
                    onClick={() => void openThread(message.tmid ?? message._id)}
                  >
                    <MessageSquareText size={15} />
                  </button>
                )}
                <button title="转发" className={hoverBtn} onClick={() => setForwarding(true)}>
                  <Share2 size={15} />
                </button>
                <button
                  title="更多"
                  className={hoverBtn}
                  onClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setMenu({ x: rect.left, y: rect.bottom + 4 });
                  }}
                >
                  {copied ? <Check size={15} className="text-success" /> : <MoreHorizontal size={15} />}
                </button>
                {picker && (
                  <EmojiPicker
                    onPick={(e) => {
                      setPicker(false);
                      void toggleReaction(message._id, `:${e.code}:`);
                    }}
                    onClose={() => setPicker(false)}
                    className={`absolute top-8 ${mine ? 'right-0' : 'left-0'}`}
                  />
                )}
              </div>
            </div>
          )}

          <div
            className={`rounded-lg px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap ${
              mine ? 'bg-primary-light text-ink' : 'bg-fill-1 text-ink'
            }`}
          >
            {editing ? (
              <EditBox message={message} onDone={() => setEditing(false)} />
            ) : (
              <>
                {message.pinned && (
                  <span className="mr-1 inline-flex items-center text-primary" title="已置顶">
                    <Pin size={12} />
                  </span>
                )}
                {message.starred?.some((s) => s._id === myId) && (
                  <span className="mr-1 inline-flex items-center text-[#ff8800]" title="已标记">
                    <Star size={12} fill="currentColor" />
                  </span>
                )}
                {message.msg ? renderMarkdown(message.msg, myUsername) : null}
                {!message.msg && !message.attachments?.length ? (
                  <span className="text-ink-3">[暂不支持的消息类型]</span>
                ) : null}
                {message.attachments?.map((att, i) => <AttachmentCard key={i} att={att} />)}
                {message.editedAt && <span className="ml-1 text-xs text-ink-3">(已编辑)</span>}
              </>
            )}
          </div>
          {grouped && (
            <span className="pb-0.5 text-[10px] text-ink-3 opacity-0 transition group-hover:opacity-100">
              {time}
            </span>
          )}
        </div>

        {!inThread && message.tcount ? (
          <button
            onClick={() => void openThread(message._id)}
            className="mt-1 flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <MessageSquareText size={13} />
            {message.tcount} 条回复
          </button>
        ) : null}

        <Reactions message={message} />
      </div>

      {/* 右侧留白，让长消息不顶满 */}
      <div className="w-10 shrink-0" />

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {forwarding && <ForwardDialog message={message} onClose={() => setForwarding(false)} />}
      {showCard && (
        <UserCard
          user={{ username: message.u.username, name: message.u.name }}
          onClose={() => setShowCard(false)}
        />
      )}
      {confirmDelete && (
        <ConfirmDeleteDialog
          onConfirm={() => {
            setConfirmDelete(false);
            void deleteMessage(message._id);
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
