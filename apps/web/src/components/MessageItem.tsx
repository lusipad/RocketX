import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { tsMs, type RcMessage, type RcMessageAttachment } from '@rcx/rc-client';
import {
  AlertCircle,
  Check,
  Copy,
  Link2,
  Download,
  File as FileIcon,
  Image as ImageIcon,
  ListTodo,
  Loader2,
  MessageSquareText,
  MessagesSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  Reply,
  Share2,
  SmilePlus,
  Star,
  Trash2,
} from 'lucide-react';
import AuthImage from './AuthImage';
import FilePreview, { canPreview } from './FilePreview';
import { saveFile } from '../lib/download';
import { toast } from '../stores/toast';
import ImageLightbox from './ImageLightbox';
import Emoji from './Emoji';
import { fmtSize, fmtTime } from '../lib/format';
import type { EmojiEntry } from '../lib/emoji';
import { renderMarkdown, LinkifiedText } from '../lib/markdown';
import { assetUrl } from '../lib/client';
import { permalinkOf, stripQuotePrefix, useChat } from '../stores/chat';
import { useAuth } from '../stores/auth';
import { usePrefs } from '../stores/prefs';
import { useTodos } from '../stores/todos';
import { useUI } from '../stores/ui';
import Avatar from './Avatar';
import EmojiPicker from './EmojiPicker';
import ContextMenu, { type MenuItem } from './ContextMenu';
import ForwardDialog from './ForwardDialog';
import TodoDialog from './TodoDialog';
import UserCard from './UserCard';

/** 悬浮栏直达的快捷表情（飞书习惯） */
const QUICK_EMOJIS: EmojiEntry[] = [
  { code: 'thumbsup', char: '👍' },
  { code: 'white_check_mark', char: '✅' },
  { code: 'tada', char: '🎉' },
];

/**
 * 图片附件：列表显示缩略图（image_url），点击后灯箱加载原图（title_link）。
 * Rocket.Chat 会为大图生成独立 fileId 的缩略图，两者 URL 不同。
 * autoImageLoad 关闭时先显示占位，点击才加载（省流量）。
 */
function ImageAttachment({
  thumbPath,
  fullPath,
  name,
}: {
  thumbPath: string;
  fullPath: string;
  name: string;
}) {
  const autoLoad = usePrefs((s) => s.prefs.autoImageLoad);
  const [lightbox, setLightbox] = useState(false);
  const [manualLoad, setManualLoad] = useState(false);
  const show = autoLoad || manualLoad;

  if (!show) {
    return (
      <button
        onClick={() => setManualLoad(true)}
        className="mt-1.5 flex w-56 items-center gap-2 rounded-lg border border-line bg-surface-4 px-3 py-2.5 text-left transition hover:border-primary"
      >
        <ImageIcon size={16} className="shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{name}</span>
        <span className="shrink-0 text-xs text-primary">点击加载</span>
      </button>
    );
  }

  return (
    <>
      <button onClick={() => setLightbox(true)} className="mt-1.5 block cursor-zoom-in">
        <AuthImage
          path={thumbPath}
          alt={name}
          className="max-h-72 max-w-[360px] rounded-lg object-contain"
          fallback={<span className="text-xs text-ink-3">[图片加载失败：{name}]</span>}
        />
      </button>
      {lightbox && (
        <ImageLightbox path={fullPath} fileName={name} onClose={() => setLightbox(false)} />
      )}
    </>
  );
}

/**
 * 文件附件卡片。
 * 文本/代码/Markdown/PDF 点一下直接预览（飞书就是这个行为，不必先下载再找），
 * 其余类型点击即下载。下载按钮永远在，两种类型都能存到本地。
 */
function FileAttachment({
  att,
  name: fileName,
  size,
}: {
  att: RcMessageAttachment;
  name?: string;
  size?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  // 优先用 file.name（原始文件名），attachment.title 在旧数据里可能是编码过的
  const name = fileName ?? att.title ?? '文件';
  const path = att.title_link ?? '';
  const previewable = canPreview(name);

  const download = async () => {
    if (!path || busy) return;
    setBusy(true);
    try {
      await saveFile(path, name);
    } catch (err) {
      toast.error(err, '下载失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mt-1.5 flex w-64 items-center gap-3 rounded-lg border border-line bg-surface-4 p-3 transition hover:border-primary">
        <button
          onClick={() => (previewable ? setPreview(true) : void download())}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          title={previewable ? '点击预览' : '点击下载'}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-light text-primary">
            <FileIcon size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{name}</span>
            <span className="block text-xs text-ink-3">
              {busy ? '下载中…' : `${fmtSize(size)}${previewable ? ' · 点击预览' : ''}`.trim() ||
                (previewable ? '点击预览' : '点击下载')}
            </span>
          </span>
        </button>
        <button
          onClick={() => void download()}
          disabled={busy}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-3 transition hover:bg-fill-hover hover:text-primary disabled:opacity-50"
          title="下载"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={15} />}
        </button>
      </div>
      {preview && (
        <FilePreview
          path={path}
          fileName={name}
          size={size}
          onClose={() => setPreview(false)}
        />
      )}
    </>
  );
}

/** 引用回复的原消息：点击跳转并高亮原消息（飞书交互） */
function QuoteCard({ att }: { att: RcMessageAttachment }) {
  const jumpToMessage = useChat((s) => s.jumpToMessage);
  // message_link 形如 .../channel/xx?msg=<id>
  const mid = att.message_link?.match(/[?&]msg=([^&]+)/)?.[1];

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (mid) jumpToMessage(mid);
      }}
      disabled={!mid}
      className="mt-1 mb-0.5 block max-w-md rounded-r-md border-l-2 border-primary/40 bg-fill-1 px-2.5 py-1.5 text-left transition enabled:hover:bg-fill-hover"
      title={mid ? '点击跳转到原消息' : undefined}
    >
      <div className="text-xs font-medium text-ink-2">{att.author_name}</div>
      <div className="line-clamp-2 text-xs break-words text-ink-3">{att.text}</div>
    </button>
  );
}

/** 链接卡片预览（服务端 OEmbed 解析结果） */
function UrlPreviewCard({ url, meta }: { url: string; meta: Record<string, string> }) {
  const title = meta.ogTitle ?? meta.pageTitle ?? meta.oembedTitle;
  const desc = meta.ogDescription ?? meta.description ?? meta.oembedProviderName;
  const image = meta.ogImage ?? meta.oembedThumbnailUrl;
  if (!title) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-1.5 flex max-w-md gap-3 rounded-lg border border-line bg-surface-4 p-3 transition hover:border-primary"
    >
      <span className="min-w-0 flex-1">
        <span className="line-clamp-1 text-sm font-medium text-primary">{title}</span>
        {desc && <span className="mt-0.5 line-clamp-2 text-xs text-ink-3">{desc}</span>}
      </span>
      {image && (
        <img
          src={image}
          alt=""
          className="h-14 w-14 shrink-0 rounded-md object-cover"
          onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
        />
      )}
    </a>
  );
}

/** 附件卡片：ADO 集成等富文本消息载体 */
function AttachmentCard({ att, message }: { att: RcMessageAttachment; message: RcMessage }) {
  // 引用回复
  if (att.message_link) {
    return <QuoteCard att={att} />;
  }
  // 图片附件（上传的图片）：缩略图给列表，原图给灯箱
  if (att.image_url) {
    const name = message.file?.name ?? att.title ?? '图片';
    return (
      <ImageAttachment
        thumbPath={att.image_url}
        fullPath={att.title_link ?? att.image_url}
        name={name}
      />
    );
  }
  // 文件附件（上传的文件）
  if (att.title_link_download && att.title_link) {
    return (
      <FileAttachment att={att} name={message.file?.name} size={message.file?.size} />
    );
  }
  // 富文本卡片（ADO 事件等）
  return (
    <div
      className="mt-1.5 max-w-md rounded-lg border border-line bg-surface-4 p-3"
      style={{ borderLeft: `3px solid ${att.color ?? '#3370ff'}` }}
    >
      {att.author_name && <div className="mb-1 text-xs text-ink-3">{att.author_name}</div>}
      {att.title &&
        (att.title_link ? (
          <a
            href={att.title_link.startsWith('/') ? assetUrl(att.title_link) : att.title_link}
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
                : 'border-line bg-surface-4 text-ink-2 hover:border-primary'
            }`}
          >
            <Emoji code={code} size={14} />
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
      <div className="w-80 rounded-xl bg-surface-4 p-5 shadow-2xl">
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
  // 只编辑可见文本；引用链接前缀保存时原样带回
  const prefix = (message.msg ?? '').slice(
    0,
    (message.msg ?? '').length - stripQuotePrefix(message.msg ?? '').length,
  );
  const [value, setValue] = useState(stripQuotePrefix(message.msg ?? ''));

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const next = prefix + value;
      if (value.trim() && next !== message.msg) void editMessage(message._id, next);
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
        className="w-full resize-none rounded-md border border-primary bg-surface-4 px-2.5 py-1.5 text-sm outline-none"
      />
      <div className="mt-0.5 text-2xs text-ink-3">Enter 保存 · Esc 取消</div>
    </div>
  );
}

type MessageItemProps = {
  message: RcMessage;
  mine: boolean;
  grouped: boolean;
  inThread?: boolean;
};

function MessageItem({ message, mine, grouped, inThread = false }: MessageItemProps) {
  const myUsername = useAuth((s) => s.user?.username);
  const myId = useAuth((s) => s.user?._id);
  const openThread = useChat((s) => s.openThread);
  const toggleReaction = useChat((s) => s.toggleReaction);
  const togglePin = useChat((s) => s.togglePin);
  const toggleStar = useChat((s) => s.toggleStar);
  const deleteMessage = useChat((s) => s.deleteMessage);
  const createDiscussionFrom = useChat((s) => s.createDiscussionFrom);
  const setReplyTo = useChat((s) => s.setReplyTo);
  const resendMessage = useChat((s) => s.resendMessage);
  const discardMessage = useChat((s) => s.discardMessage);
  const receipt = useChat((s) => s.readReceipts[message.rid]);
  const roomType = useChat((s) => s.subscriptions[message.rid]?.t);
  const showAvatars = usePrefs((s) => s.prefs.displayAvatars);
  const highlighted = useChat((s) => s.highlightMid === message._id);
  const rootRef = useRef<HTMLDivElement>(null);

  // 被跳转定位时滚动到视野中央
  useEffect(() => {
    if (highlighted) {
      rootRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [highlighted]);

  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [forwarding, setForwarding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [todoOpen, setTodoOpen] = useState(false);

  const inTodo = useTodos((s) => s.todos.some((t) => t.mid === message._id && !t.done));
  const setModule = useUI((s) => s.setModule);
  const roomName = useChat(
    (s) => s.subscriptions[message.rid]?.fname || s.subscriptions[message.rid]?.name || '会话',
  );

  const displayName = message.u.name || message.u.username;
  const time = fmtTime(tsMs(message.ts));
  // 纯媒体消息（只有图片/文件，没有文字与其他卡片）→ 不套气泡
  const visibleText = stripQuotePrefix(message.msg ?? '');
  const bareMedia =
    !visibleText &&
    !message.pinned &&
    !!message.attachments?.length &&
    message.attachments.every((a) => !!a.image_url || !!a.title_link_download);

  const copy = () => {
    void navigator.clipboard?.writeText(stripQuotePrefix(message.msg ?? ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const copyLink = () => {
    void navigator.clipboard?.writeText(permalinkOf(message.rid, message._id));
    toast.success('消息链接已复制');
  };

  // 2 分钟内显示「撤回」，之后是「删除」（行为一致：消息被移除）
  const deleteLabel = Date.now() - tsMs(message.ts) < 2 * 60 * 1000 ? '撤回' : '删除';

  const menuItems: MenuItem[] = [
    { label: '回复', icon: Reply, onClick: () => setReplyTo(message) },
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
    ...(!inThread
      ? [
          {
            label: '创建讨论',
            icon: MessagesSquare,
            onClick: () => void createDiscussionFrom(message),
          },
        ]
      : []),
    ...(message.msg ? [{ label: copied ? '已复制' : '复制', icon: Copy, onClick: copy }] : []),
    { label: '复制消息链接', icon: Link2, onClick: copyLink },
    {
      label: inTodo ? '已在待办中' : '标记为待办',
      icon: ListTodo,
      onClick: () => {
        if (inTodo) setModule('todos');
        else setTodoOpen(true);
      },
    },
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
      ? [{ label: deleteLabel, icon: Trash2, danger: true, onClick: () => setConfirmDelete(true) }]
      : []),
  ];

  const onContextMenu = (e: ReactMouseEvent) => {
    // 附件卡片里的链接保持浏览器默认右键；发送中/失败的消息无菜单
    if ((e.target as HTMLElement).closest('a')) return;
    if (message.pending || message.failed) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  };

  const hoverBtn =
    'flex h-7 w-7 items-center justify-center rounded text-ink-2 transition hover:bg-fill-hover hover:text-ink';

  return (
    <div
      ref={rootRef}
      onContextMenu={onContextMenu}
      className={`group flex gap-2.5 rounded-lg px-1 transition-colors duration-500 ${
        grouped ? 'mt-0.5' : 'mt-3'
      } ${mine ? 'flex-row-reverse' : ''} ${highlighted ? 'bg-primary-light' : ''}`}
    >
      {/* 头像列：分组消息用占位保持对齐；点击弹个人卡片 */}
      {showAvatars && (
        <div className="w-9 shrink-0">
          {!grouped && (
            <button onClick={() => setShowCard(true)} className="block cursor-pointer">
              <Avatar name={displayName} username={message.u.username} size={36} />
            </button>
          )}
        </div>
      )}

      <div className={`flex max-w-[68%] min-w-0 flex-col ${mine ? 'items-end' : 'items-start'}`}>
        {!grouped && (
          <div className={`mb-1 flex items-baseline gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
            <span className="text-xs text-ink-2">{mine ? '' : displayName}</span>
            <span className="text-xs text-ink-3">{time}</span>
          </div>
        )}

        <div className={`relative flex items-end gap-2 ${mine ? 'flex-row-reverse' : ''}`}>
          {/* 悬浮操作栏：贴气泡上沿内侧，避免被滚动容器裁剪（第一条消息也够得着） */}
          {!editing && !message.pending && !message.failed && (
            <div
              className={`absolute -top-4 z-10 hidden group-hover:flex ${
                mine ? 'right-0' : 'left-0'
              }`}
            >
              <div className="relative flex items-center gap-0.5 rounded-lg border border-line bg-surface-4 p-0.5 shadow-[0_2px_8px_rgba(31,35,41,0.1)]">
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
                <button
                  title="更多表情"
                  className={hoverBtn}
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setPicker(picker ? null : { x: r.left, y: r.bottom + 4 });
                  }}
                >
                  <SmilePlus size={15} />
                </button>
                <div className="mx-0.5 h-4 w-px bg-line" />
                <button title="回复" className={hoverBtn} onClick={() => setReplyTo(message)}>
                  <Reply size={15} />
                </button>
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
              </div>
            </div>
          )}

          {/* 纯图片消息不套气泡（飞书是裸图），有文字时才有气泡底 */}
          <div
            className={`text-sm leading-relaxed break-words whitespace-pre-wrap ${
              bareMedia
                ? ''
                : `rounded-lg px-3 py-2 ${mine ? 'bg-bubble-mine text-ink' : 'bg-bubble-other text-ink'}`
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
                {inTodo && (
                  <button
                    onClick={() => setModule('todos')}
                    className="mr-1 inline-flex items-center text-primary"
                    title="已加入待办，点击查看"
                  >
                    <ListTodo size={12} />
                  </button>
                )}
                {message.msg ? renderMarkdown(message.msg, myUsername) : null}
                {!message.msg && !message.attachments?.length ? (
                  <span className="text-ink-3">[暂不支持的消息类型]</span>
                ) : null}
                {message.attachments?.map((att, i) => (
                  <AttachmentCard key={i} att={att} message={message} />
                ))}
                {message.urls
                  ?.filter((u) => u.meta && Object.keys(u.meta).length > 0)
                  .slice(0, 2)
                  .map((u, i) => <UrlPreviewCard key={i} url={u.url} meta={u.meta!} />)}
                {message.editedAt && <span className="ml-1 text-xs text-ink-3">(已编辑)</span>}
              </>
            )}
          </div>
          {grouped && (
            <span className="pb-0.5 text-2xs text-ink-3 opacity-0 transition group-hover:opacity-100">
              {time}
            </span>
          )}
          {/* 发送状态：发送中 / 失败可重试 */}
          {message.pending && (
            <Loader2 size={13} className="mb-1 shrink-0 animate-spin text-ink-3" />
          )}
          {message.failed && (
            <span className="mb-0.5 flex shrink-0 items-center gap-1">
              <button
                title="发送失败，点击重试"
                onClick={() => void resendMessage(message._id)}
                className="text-danger"
              >
                <AlertCircle size={14} />
              </button>
              <button
                title="放弃发送"
                onClick={() => discardMessage(message._id)}
                className="text-ink-3 hover:text-danger"
              >
                <Trash2 size={12} />
              </button>
            </span>
          )}
        </div>

        {/* 已读回执：只在自己最后一条消息下显示（飞书交互） */}
        {mine && !message.pending && !message.failed && receipt?.mid === message._id && (
          <span
            className="mt-0.5 text-2xs text-ink-3"
            title={receipt.users.map((u) => u.name || u.username).join('、')}
          >
            {roomType === 'd'
              ? receipt.users.length > 0
                ? '已读'
                : '未读'
              : receipt.users.length > 0
                ? `${receipt.users.length} 人已读`
                : '暂无人已读'}
          </span>
        )}

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

      {picker && (
        <EmojiPicker
          pos={picker}
          onPick={(e) => {
            setPicker(null);
            void toggleReaction(message._id, `:${e.code}:`);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {forwarding && <ForwardDialog message={message} onClose={() => setForwarding(false)} />}
      {todoOpen && (
        <TodoDialog
          source={{
            rid: message.rid,
            mid: message._id,
            roomName,
            // 待办里存快照：原消息被删了也还看得懂当时是什么事
            excerpt: stripQuotePrefix(message.msg ?? '').slice(0, 200) ||
              (message.file?.name ? `[文件] ${message.file.name}` : '[图片/附件]'),
            author: displayName,
          }}
          onClose={() => setTodoOpen(false)}
        />
      )}
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

/**
 * 每条消息都订阅 store，但列表里的"正在输入"、滚动等状态变化会重渲染父组件。
 * 消息对象在 store 里是不可变替换的（改一条只换那一条的引用），
 * 所以按引用比较即可挡掉整列表的无谓重渲染。
 */
export default memo(MessageItem);
