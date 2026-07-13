import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import type { RcUser } from '@rcx/rc-client';
import { AtSign, Image, Paperclip, Reply, SendHorizontal, Smile, X } from 'lucide-react';
import { stripQuotePrefix, useChat } from '../stores/chat';
import { usePrefs } from '../stores/prefs';
import EmojiPicker from './EmojiPicker';
import Avatar from './Avatar';

// @ 前允许中文（中文输入习惯不加空格：'你好@zhang'）
const MENTION_RE = /(?:^|[\s一-鿿，。！？；：、])@([\w.\-]*)$/;

export default function Composer() {
  const activeRid = useChat((s) => s.activeRid);
  const send = useChat((s) => s.send);
  const loadMembers = useChat((s) => s.loadMembers);
  const requestUpload = useChat((s) => s.requestUpload);
  const uploading = useChat((s) => s.uploading);
  const setDraft = useChat((s) => s.setDraft);
  const replyTo = useChat((s) => s.replyTo);
  const setReplyTo = useChat((s) => s.setReplyTo);
  const emitTyping = useChat((s) => s.emitTyping);
  // 'alternative' = Ctrl+Enter 发送、Enter 换行
  const sendOnEnter = usePrefs((s) => s.prefs.sendOnEnter ?? 'normal');

  const [text, setText] = useState('');
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [picker, setPicker] = useState(false);
  const [members, setMembers] = useState<RcUser[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 切换会话时恢复该会话草稿并预取成员（供 @ 补全）
  useEffect(() => {
    setText(activeRid ? (useChat.getState().drafts[activeRid] ?? '') : '');
    setMentionQuery(null);
    setPicker(false);
    textareaRef.current?.focus();
    if (activeRid) {
      void loadMembers(activeRid).then(setMembers);
    }
  }, [activeRid, loadMembers]);

  // 草稿防抖保存
  const persistDraft = (value: string) => {
    if (!activeRid) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    const rid = activeRid;
    draftTimer.current = setTimeout(() => setDraft(rid, value.trim() ? value : ''), 300);
  };

  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const base: { username: string; name?: string }[] = [
      { username: 'all', name: '通知所有人' },
      { username: 'here', name: '通知在线成员' },
      ...members,
    ];
    return base
      .filter(
        (u) =>
          u.username.toLowerCase().startsWith(q) ||
          (u.name ?? '').toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [mentionQuery, members]);

  const refreshMention = (value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const m = MENTION_RE.exec(before);
    setMentionQuery(m ? m[1] : null);
    setMentionIndex(0);
  };

  /** 按实际内容高度自适应（数换行符算不出自动换行的长文本） */
  const autoResize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    persistDraft(e.target.value);
    emitTyping();
    refreshMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
    requestAnimationFrame(autoResize);
  };

  // 文本被外部改变（发送清空、切换会话恢复草稿）时同步高度
  useEffect(autoResize, [text, activeRid]);

  // 粘贴图片/文件 → 发送确认弹窗（飞书交互）
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length > 0) {
      e.preventDefault();
      requestUpload(files);
    }
  };

  const insertMention = (username: string) => {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? text.length;
    const before = text.slice(0, cursor).replace(MENTION_RE, (full) =>
      full.startsWith('@') ? `@${username} ` : `${full[0]}@${username} `,
    );
    const next = before + text.slice(cursor);
    setText(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  };

  const insertEmoji = (char: string) => {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? text.length;
    const next = text.slice(0, cursor) + char + text.slice(cursor);
    setText(next);
    setPicker(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursor + char.length, cursor + char.length);
    });
  };

  const doSend = async () => {
    const value = text.trim();
    if (!value) return;
    // 乐观发送：立刻清空输入框，不阻塞下一条（连发不会被吞）
    setText('');
    setMentionQuery(null);
    setReplyTo(null);
    if (activeRid) {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      setDraft(activeRid, '');
    }
    textareaRef.current?.focus();
    // 失败由消息气泡的红色标记与 toast「重试」承接
    await send(value, replyTo ? { quote: replyTo } : undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && candidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % candidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(candidates[mentionIndex].username);
        return;
      }
      if (e.key === 'Escape') {
        setMentionQuery(null);
        return;
      }
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const shouldSend =
      sendOnEnter === 'alternative'
        ? e.ctrlKey || e.metaKey // Ctrl/Cmd + Enter 发送
        : !e.shiftKey && !e.ctrlKey && !e.metaKey; // Enter 发送
    if (shouldSend) {
      e.preventDefault();
      void doSend();
    }
  };

  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length > 0) requestUpload(files);
  };

  const toolBtn =
    'flex h-7 w-7 items-center justify-center rounded text-ink-2 transition hover:bg-fill-hover hover:text-ink';

  return (
    <div className="relative shrink-0 border-t border-line px-4 pt-2 pb-3">
      {/* @ 成员补全弹层 */}
      {mentionQuery !== null && candidates.length > 0 && (
        <div className="absolute bottom-full left-4 z-30 mb-1 w-64 overflow-hidden rounded-lg border border-line bg-surface-4 py-1 shadow-[0_4px_16px_rgba(31,35,41,0.12)]">
          {candidates.map((u, i) => (
            <button
              key={u.username}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(u.username);
              }}
              onMouseEnter={() => setMentionIndex(i)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                i === mentionIndex ? 'bg-primary-light' : ''
              }`}
            >
              {u.username === 'all' || u.username === 'here' ? (
                <span className="flex h-6 w-6 items-center justify-center rounded bg-primary-light text-primary">
                  <AtSign size={13} />
                </span>
              ) : (
                <Avatar name={u.name || u.username} username={u.username} size={24} />
              )}
              <span className="font-medium text-ink">{u.name || u.username}</span>
              <span className="text-xs text-ink-3">@{u.username}</span>
            </button>
          ))}
        </div>
      )}

      {picker && (
        <EmojiPicker
          onPick={(e) => insertEmoji(e.char)}
          onClose={() => setPicker(false)}
          className="absolute bottom-full left-4 mb-1 shadow-lg"
        />
      )}

      {/* 引用回复条（飞书交互） */}
      {replyTo && (
        <div className="mb-1.5 flex items-center gap-2 rounded-md bg-fill-1 px-2.5 py-1.5">
          <Reply size={13} className="shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-xs text-ink-2">
            回复 {replyTo.u.name || replyTo.u.username}：
            {stripQuotePrefix(replyTo.msg) || '[卡片消息]'}
          </span>
          <button
            onClick={() => setReplyTo(null)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-fill-hover"
          >
            <X size={12} />
          </button>
        </div>
      )}
      <div className="flex items-center gap-1 pb-1.5">
        <button title="表情" className={toolBtn} onClick={() => setPicker((v) => !v)}>
          <Smile size={16} />
        </button>
        <button
          title="提及成员"
          className={toolBtn}
          onClick={() => {
            const el = textareaRef.current;
            const cursor = el?.selectionStart ?? text.length;
            const prefix = text.slice(0, cursor);
            const needsSpace = prefix && !/\s$/.test(prefix);
            const inserted = `${needsSpace ? ' ' : ''}@`;
            setText(prefix + inserted + text.slice(cursor));
            setMentionQuery('');
            requestAnimationFrame(() => el?.focus());
          }}
        >
          <AtSign size={16} />
        </button>
        <button title="发送图片" className={toolBtn} onClick={() => imageInputRef.current?.click()}>
          <Image size={16} />
        </button>
        <button title="发送文件" className={toolBtn} onClick={() => fileInputRef.current?.click()}>
          <Paperclip size={16} />
        </button>
        {uploading > 0 && <span className="pl-1 text-xs text-ink-3">上传中（{uploading}）…</span>}
      </div>
      <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
      <input ref={fileInputRef} type="file" multiple hidden onChange={onFiles} />

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onClick={(e) =>
            refreshMention(text, (e.target as HTMLTextAreaElement).selectionStart ?? 0)
          }
          rows={1}
          placeholder={
            sendOnEnter === 'alternative'
              ? '输入消息，Ctrl + Enter 发送'
              : '输入消息，Enter 发送，Shift + Enter 换行'
          }
          className="max-h-40 min-h-9 flex-1 resize-none overflow-y-auto rounded-md border border-line px-3 py-2 text-sm leading-relaxed outline-none transition focus:border-primary"
        />
        <button
          onClick={() => void doSend()}
          disabled={!text.trim()}
          title="发送"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-white transition hover:bg-primary-hover active:bg-primary-active disabled:cursor-not-allowed disabled:opacity-40"
        >
          <SendHorizontal size={17} />
        </button>
      </div>
    </div>
  );
}
