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
import { AtSign, Image, Paperclip, Reply, SendHorizontal, Slash, Smile, X } from 'lucide-react';
import { stripQuotePrefix, useChat } from '../stores/chat';
import { rest } from '../lib/client';
import { toast } from '../stores/toast';
import { useAliases } from '../stores/aliases';
import { usePrefs } from '../stores/prefs';
import { pinyinMatch, pinyinScore, usePinyinReady } from '../lib/pinyin';
import {
  commandDesc,
  commandParams,
  filterCommands,
  parseSlash,
  slashPrefix,
} from '../lib/slash';
import EmojiPicker from './EmojiPicker';
import Avatar from './Avatar';

// @ 前允许中文（中文输入习惯不加空格：'你好@zhang'）
const MENTION_RE = /(?:^|[\s一-鿿，。！？；：、])@([\w.\-]*)$/;

// 现代 Chromium（含 Tauri 的 WebView2）用 CSS field-sizing 原生自适应高度，
// 就不必每次输入用 JS 重置 height='auto' 再量——那个每键强制回流在中文输入法
// 逐字合成时会让输入框肉眼可见地抖一下（issue #15）。不支持时才回退 JS。
const SUPPORTS_FIELD_SIZING =
  typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content');

export default function Composer() {
  const activeRid = useChat((s) => s.activeRid);
  const roomType = useChat((s) => (s.activeRid ? s.subscriptions[s.activeRid]?.t : undefined));
  const send = useChat((s) => s.send);
  const loadMembers = useChat((s) => s.loadMembers);
  const inviteMembers = useChat((s) => s.inviteMembers);
  const requestUpload = useChat((s) => s.requestUpload);
  const uploading = useChat((s) => s.uploading);
  const setDraft = useChat((s) => s.setDraft);
  const replyTo = useChat((s) => s.replyTo);
  const setReplyTo = useChat((s) => s.setReplyTo);
  const emitTyping = useChat((s) => s.emitTyping);
  // 'alternative' = Ctrl+Enter 发送、Enter 换行
  const sendOnEnter = usePrefs((s) => s.prefs.sendOnEnter);
  const prefsLoaded = usePrefs((s) => s.loaded);

  const runSlash = useChat((s) => s.runSlash);
  const slashCommands = useChat((s) => s.slashCommands);
  const recalledText = useChat((s) => s.recalledText);

  const [text, setText] = useState('');
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [picker, setPicker] = useState(false);
  const [members, setMembers] = useState<RcUser[]>([]);
  // 目录里搜到的群外用户（@ 群外的人用，防抖搜索）
  const [remoteUsers, setRemoteUsers] = useState<RcUser[]>([]);
  const mentionSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // @ 了群外的人：记下来，发送前邀请入群（否则 RC 不会给非成员发 @ 提醒）
  const [pendingInvites, setPendingInvites] = useState<RcUser[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  /** 光标停在命令名上时的前缀（'' 表示刚打了个 /）；null 表示不在命令补全状态 */
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashListRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 切换会话时恢复该会话草稿并预取成员（供 @ 补全）
  useEffect(() => {
    setText(activeRid ? (useChat.getState().drafts[activeRid] ?? '') : '');
    setMentionQuery(null);
    setPicker(false);
    setPendingInvites([]); // 待邀请名单跟着会话走，切走就清
    textareaRef.current?.focus();
    if (activeRid) {
      void loadMembers(activeRid).then(setMembers);
    }
  }, [activeRid, loadMembers]);

  // 撤回后自动填入原文
  useEffect(() => {
    if (recalledText) {
      setText(recalledText);
      useChat.setState({ recalledText: null });
      textareaRef.current?.focus();
    }
  }, [recalledText]);

  // 草稿防抖保存
  const persistDraft = (value: string) => {
    if (!activeRid) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    const rid = activeRid;
    draftTimer.current = setTimeout(() => setDraft(rid, value.trim() ? value : ''), 300);
  };

  const pinyinReady = usePinyinReady();
  const aliases = useAliases((s) => s.aliases);

  // @ 群外的人：输入 @关键词 时防抖搜全局目录，把不在群里的人也拉进候选
  useEffect(() => {
    const q = mentionQuery?.trim();
    if (!q) {
      setRemoteUsers([]);
      return;
    }
    if (mentionSearchTimer.current) clearTimeout(mentionSearchTimer.current);
    mentionSearchTimer.current = setTimeout(() => {
      void rest
        .searchUsers(q, 20)
        .then(({ users }) => setRemoteUsers(users))
        .catch(() => setRemoteUsers([]));
    }, 250);
    return () => {
      if (mentionSearchTimer.current) clearTimeout(mentionSearchTimer.current);
    };
  }, [mentionQuery]);

  const candidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.trim();
    const base: { username: string; name?: string; isRemote?: boolean }[] = [
      { username: 'all', name: '通知所有人' },
      { username: 'here', name: '通知在线成员' },
      ...members,
    ];
    // 支持拼音（zhangsan / zs → 张三）与备注名（给谁起了备注就按备注找谁）
    const label = (u: { username: string; name?: string }) =>
      aliases[`u:${u.username}`] || u.name || u.username;
    const local = base
      .filter((u) => pinyinMatch(q, aliases[`u:${u.username}`], u.name, u.username))
      .sort((a, b) => pinyinScore(q, label(a)) - pinyinScore(q, label(b)));
    // 群外用户：目录搜到的、不在群成员里的，标 isRemote 拼在本地结果后面
    const memberNames = new Set(base.map((u) => u.username));
    const remote = remoteUsers
      .filter((u) => u.username && !memberNames.has(u.username))
      .map((u) => ({ username: u.username, name: u.name, isRemote: true }));
    return [...local, ...remote].slice(0, 8);
    // pinyinReady：字典异步加载完成后要重算一次候选
  }, [mentionQuery, members, aliases, pinyinReady, remoteUsers]);

  const slashCandidates = useMemo(
    () => (slashQuery === null ? [] : filterCommands(slashCommands, slashQuery)),
    [slashQuery, slashCommands],
  );

  // 面板会滚动，选中项必须跟着滚进可视区，否则按方向键翻到第 9 条以后就看不见高亮了
  useEffect(() => {
    const list = slashListRef.current;
    if (!list) return;
    list
      .querySelector(`[data-slash-index="${slashIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [slashIndex, slashQuery]);

  const refreshMention = (value: string, cursor: number) => {
    const before = value.slice(0, cursor);
    const m = MENTION_RE.exec(before);
    setMentionQuery(m ? m[1] : null);
    setMentionIndex(0);
    setSlashQuery(slashPrefix(before));
    setSlashIndex(0);
  };

  /**
   * 把光标所在的命令名补全，**只替换命令那一段**。
   *
   * 之前是 `setText('/' + command + ' ')` —— 整个输入框被换掉。写好 `hello` 之后把光标
   * 挪到行首打个 `/`，弹出补全一回车，`hello` 就没了。参数也一样：`/kic @张三` 回头补全
   * 命令名，`@张三` 被吞掉。补全只该动它该动的那几个字符。
   */
  const insertCommand = (command: string) => {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? text.length;
    const head = `/${command} `;
    const next = head + text.slice(cursor);
    setText(next);
    persistDraft(next); // 补全插入的内容也要进草稿，否则切会话就丢（P2-g）
    setSlashQuery(null);
    requestAnimationFrame(() => {
      el?.focus();
      // 光标停在命令后面（接着打参数），不是整段文本的末尾
      el?.setSelectionRange(head.length, head.length);
    });
  };

  /** 按实际内容高度自适应（数换行符算不出自动换行的长文本） */
  const autoResize = () => {
    // 浏览器原生 field-sizing 已处理，JS 不再插手（避免每键回流抖动）
    if (SUPPORTS_FIELD_SIZING) return;
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
    // 高度自适应交给 useEffect([text]) 统一做，这里不再重复调（原本每键跑两遍回流）
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
    persistDraft(next); // 同上（P2-g）
    // @ 的是群外的人 → 记下来，发送前拉进群（这样 TA 才收得到 @ 提醒）
    const remote = remoteUsers.find((u) => u.username === username);
    if (remote && !members.some((m) => m.username === username)) {
      setPendingInvites((prev) =>
        prev.some((u) => u.username === username) ? prev : [...prev, remote],
      );
    }
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
    persistDraft(next); // 同上（P2-g）
    setPicker(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(cursor + char.length, cursor + char.length);
    });
  };

  const clearInput = () => {
    setText('');
    setMentionQuery(null);
    setSlashQuery(null);
    if (activeRid) {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      setDraft(activeRid, '');
    }
    textareaRef.current?.focus();
  };

  const doSend = async () => {
    const value = text.trim();
    if (!value) return;

    // 斜杠命令走服务端执行，不能当文本发出去
    const slash = parseSlash(value);
    if (slash) {
      // 认不出的命令 runSlash 会提示并拦下，输入框保留原文让用户改
      const known = slashCommands.some(
        (c) => c.command.toLowerCase() === slash.command,
      );
      if (known) clearInput();
      else setSlashQuery(null);
      await runSlash(slash.command, slash.params);
      return;
    }

    // @ 了群外的人 → 发送前先把他们拉进群，RC 才会把 @ 提醒送到（非成员收不到提及通知）。
    // 只对群/频道有效；DM 不适用。
    const rid = activeRid;
    const toInvite =
      rid && roomType && roomType !== 'd'
        ? pendingInvites.filter((u) => value.includes(`@${u.username}`))
        : [];

    const quote = replyTo;
    // 乐观发送：立刻清空输入框，不阻塞下一条（连发不会被吞）
    clearInput();
    setReplyTo(null);
    setPendingInvites([]);

    if (rid && toInvite.length > 0) {
      try {
        // inviteMembers 会邀请 + 清成员缓存 + toast「已添加」；之后 TA 是成员，@ 提醒才发得到
        await inviteMembers(rid, toInvite);
        void loadMembers(rid).then(setMembers); // 缓存已清，重拉刷新本地 @ 补全用的成员表
      } catch (err) {
        // 邀请失败：消息照常发，但对方可能收不到提醒，得说一声
        toast.error(err, '把群外成员拉进群失败，对方可能收不到 @ 提醒');
      }
    }

    // 失败由消息气泡的红色标记与 toast「重试」承接
    await send(value, quote ? { quote } : undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法合成中，方向键/回车/Esc 都归 IME 选字用，补全面板一律不拦（P2-f）
    const composing = e.nativeEvent.isComposing;
    if (!composing && slashQuery !== null && slashCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashCandidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashCandidates.length) % slashCandidates.length);
        return;
      }
      // Tab 永远是补全。
      // Enter：名字还没打全就先补全（免得 `/kic` 回车换来一句「没有这个命令」）；
      // 已经打全了（`/shrug`）就直接执行，不用多按一次。
      const isTab = e.key === 'Tab';
      const isEnter = e.key === 'Enter' && !e.nativeEvent.isComposing && !e.shiftKey;
      if (isTab || isEnter) {
        const typedIsComplete = slashCommands.some(
          (c) => c.command.toLowerCase() === slashQuery.toLowerCase(),
        );
        if (isTab || !typedIsComplete) {
          e.preventDefault();
          insertCommand(slashCandidates[slashIndex].command);
          return;
        }
        // 打全了：落到下面的发送逻辑，由 doSend 派发成命令
      }
      if (e.key === 'Escape') {
        setSlashQuery(null);
        return;
      }
    }
    if (!composing && mentionQuery !== null && candidates.length > 0) {
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
    // 偏好还没加载完就先按「Ctrl+Enter 才发送」这条保守规则：否则默认值是 Enter 发送，
    // 而用户真实设置可能是「Enter 换行」，一按回车就把半句话发出去（P1-6）。
    const effectiveMode = prefsLoaded ? sendOnEnter : 'alternative';
    const shouldSend =
      effectiveMode === 'alternative'
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
      {/* 斜杠命令补全弹层：命令有 27 个，装不下就滚，别把数据砍掉 */}
      {slashQuery !== null && slashCandidates.length > 0 && (
        <div
          ref={slashListRef}
          className="absolute bottom-full left-4 z-30 mb-1 max-h-72 w-80 overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface-4 py-1 shadow-[0_4px_16px_rgba(31,35,41,0.12)]"
        >
          {slashCandidates.map((c, i) => {
            // 服务器给的是 i18n 键名（Slash_Shrug_Description），得翻成人话
            const desc = commandDesc(c);
            const params = commandParams(c);
            return (
              <button
                key={c.command}
                data-slash-index={i}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertCommand(c.command);
                }}
                onMouseEnter={() => setSlashIndex(i)}
                className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left ${
                  i === slashIndex ? 'bg-primary-light' : ''
                }`}
              >
                <span className="flex items-baseline gap-1.5">
                  <span className="font-medium text-ink">/{c.command}</span>
                  {params && <span className="truncate text-2xs text-ink-3">{params}</span>}
                </span>
                {desc && <span className="truncate text-2xs text-ink-3">{desc}</span>}
              </button>
            );
          })}
        </div>
      )}

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
                <Avatar
                  name={aliases[`u:${u.username}`] || u.name || u.username}
                  username={u.username}
                  size={24}
                />
              )}
              <span className="font-medium text-ink">
                {aliases[`u:${u.username}`] || u.name || u.username}
              </span>
              <span className="min-w-0 truncate text-xs text-ink-3">@{u.username}</span>
              {u.isRemote && (
                <span className="ml-auto shrink-0 rounded bg-fill-1 px-1 text-2xs text-ink-3">
                  非群成员
                </span>
              )}
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
            const next = prefix + inserted + text.slice(cursor);
            setText(next);
            persistDraft(next);
            setMentionQuery('');
            requestAnimationFrame(() => el?.focus());
          }}
        >
          <AtSign size={16} />
        </button>
        {slashCommands.length > 0 && (
          <button
            title="斜杠命令"
            className={toolBtn}
            onClick={() => {
              // 命令必须在最前面，所以直接把输入框换成 "/"（原文有内容就不动）
              if (text.trim()) {
                setSlashQuery(null);
                return;
              }
              setText('/');
              persistDraft('/');
              setSlashQuery('');
              setSlashIndex(0);
              requestAnimationFrame(() => {
                const el = textareaRef.current;
                el?.focus();
                el?.setSelectionRange(1, 1);
              });
            }}
          >
            <Slash size={16} />
          </button>
        )}
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
              // 「怎么发送」和「怎么换行」得同时讲 —— 只说一半，想发多行的人就卡住了
              ? '输入消息，Ctrl + Enter 发送，Enter 换行'
              : '输入消息，Enter 发送，Shift + Enter 换行'
          }
          className="max-h-40 min-h-9 flex-1 resize-none overflow-y-auto rounded-md border border-line px-3 py-2 text-sm leading-relaxed outline-none transition [field-sizing:content] focus:border-primary"
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
