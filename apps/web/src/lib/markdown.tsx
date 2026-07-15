import { Fragment, type ReactNode } from 'react';
import WorkItemLink from '../components/WorkItemLink';
import { adoWebBase } from './ado';
import Emoji from '../components/Emoji';

/**
 * 轻量消息 Markdown 渲染（不引第三方库、不用 dangerouslySetInnerHTML）。
 * 支持 Rocket.Chat 常用记法：*粗* / **粗**、_斜_、~删除线~、`行内代码`、
 * ```代码块```、[文字](链接)、URL 自动链接、:emoji:（含 RC 自定义表情）、
 * @提及 与 #频道 高亮、> 引用行、- 列表行。不支持嵌套。
 */

// URL 排除常见中英文收尾标点，避免「链接，」把标点吃进去
const URL_CHARS = `[^\\s<>"'一-龥，。；！？）」』】]`;
const INLINE_RE = new RegExp(
  [
    String.raw`(\`[^\`\n]+\`)`, // 1 行内代码
    String.raw`(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))`, // 2 [文字](链接)
    String.raw`(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*)`, // 3 粗体
    String.raw`(~~[^~\n]+~~|~[^~\s][^~\n]*~)`, // 4 删除线
    String.raw`(\b_[^_\n]+_\b|(?<=^|\s)_[^_\n]+_(?=$|\s))`, // 5 斜体
    String.raw`(https?:\/\/${URL_CHARS}+)`, // 6 URL
    // 7 emoji 短代码：前后都不能挨着字母数字，否则 10:30:00 里的 :30: 会被当成 emoji
    String.raw`((?<![0-9A-Za-z]):[a-zA-Z0-9_+\-]+:(?![0-9A-Za-z]))`,
    // 8 提及：. 和 - 只允许出现在词字符之间，不能结尾——否则「@zhang.」结尾句号被吞进用户名
    String.raw`((?<=^|[\s一-鿿，。！？；：、])@\w+(?:[.\-]\w+)*)`,
    // 9 频道/工作项：同上，「修复了#123.」的句号不该吞进去，否则 #123 认不出是工作项
    String.raw`((?<=^|[\s一-鿿，。！？；：、])#\w+(?:[.\-]\w+)*)`,
  ].join('|'),
  'g',
);

/**
 * 工作项引用的呈现形态：整条消息就只有 #号（或 ADO 工作项链接）→ 富内联卡片；
 * 夹在文字里 → 紧凑 chip + 悬浮详情卡，不打断行文（issue：文字中的 #号 要悬浮卡片）。
 */
type WiVariant = 'card' | 'chip';

export function isPureWorkItemText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^#\d+(\s+#\d+)*$/.test(t)) return true;
  // 单独粘贴一条 ADO 工作项链接也算「纯卡片」
  return /^https?:\/\/\S+\/_workitems\/edit\/\d+\S*$/i.test(t);
}

function renderInline(
  text: string,
  me: string | undefined,
  keyBase: string,
  wi: WiVariant,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last)
      nodes.push(<Fragment key={`${keyBase}-t${i++}`}>{text.slice(last, idx)}</Fragment>);
    const [full] = m;
    const key = `${keyBase}-m${i++}`;
    if (m[1]) {
      nodes.push(
        <code key={key} className="rounded bg-fill-active px-1 py-0.5 font-mono text-[0.9em]">
          {full.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      const label = full.slice(1, full.indexOf(']'));
      const href = full.slice(full.indexOf('(') + 1, -1);
      nodes.push(
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noreferrer"
          className="break-all text-primary underline-offset-2 hover:underline"
        >
          {label}
        </a>,
      );
    } else if (m[3]) {
      const inner = full.startsWith('**') ? full.slice(2, -2) : full.slice(1, -1);
      nodes.push(<strong key={key}>{inner}</strong>);
    } else if (m[4]) {
      const inner = full.startsWith('~~') ? full.slice(2, -2) : full.slice(1, -1);
      nodes.push(<del key={key}>{inner}</del>);
    } else if (m[5]) {
      nodes.push(<em key={key}>{full.slice(1, -1)}</em>);
    } else if (m[6]) {
      // 粘贴的 ADO 工作项 URL（.../_workitems/edit/123）自动 unfurl 成悬停详情卡，
      // 复用 #工作项号 那套 WorkItemLink（issue #13）。必须属于当前配置的 ADO 集合
      // 才转卡片：href 是用 adoWebBase 重建的，也避免把别家 ADO 链接认成本服务器的。
      const adoBase = adoWebBase();
      const wiUrl = /\/_workitems\/edit\/(\d+)\b/i.exec(full);
      if (wiUrl && adoBase && full.toLowerCase().startsWith(adoBase.toLowerCase())) {
        nodes.push(<WorkItemLink key={key} id={Number(wiUrl[1])} variant={wi} />);
      } else {
        nodes.push(
          <a
            key={key}
            href={full}
            target="_blank"
            rel="noreferrer"
            className="break-all text-primary underline-offset-2 hover:underline"
          >
            {full}
          </a>,
        );
      }
    } else if (m[7]) {
      nodes.push(<Emoji key={key} code={full} size={18} />);
    } else if (m[8]) {
      const username = full.slice(1);
      const isMe = me && (username === me || username === 'all' || username === 'here');
      nodes.push(
        <span
          key={key}
          className={
            isMe
              ? 'rounded bg-primary px-1 text-white'
              : 'rounded bg-primary-light px-1 font-medium text-primary'
          }
        >
          {full}
        </span>,
      );
    } else if (m[9]) {
      // #纯数字 且配置过工作台 → ADO 工作项链接（悬停出详情卡，可快速评论）
      const adoBase = /^#\d+$/.test(full) ? adoWebBase() : null;
      if (adoBase) {
        nodes.push(<WorkItemLink key={key} id={Number(full.slice(1))} variant={wi} />);
      } else {
        nodes.push(
          <span key={key} className="font-medium text-primary">
            {full}
          </span>,
        );
      }
    }
    last = idx + full.length;
  }
  if (last < text.length)
    nodes.push(<Fragment key={`${keyBase}-t${i++}`}>{text.slice(last)}</Fragment>);
  return nodes;
}

/**
 * 块级 Markdown。
 *
 * 聊天消息和文档预览共用同一套解析，只是排版尺度不同（variant）：
 * 聊天里标题不该占满一屏，段落也不该像文档那样上下留白。
 *
 * 关于 `#`：标准 Markdown 要求 `#` 后必须跟空格才是标题。
 * 所以 `#128`（工作项引用）、`#general`（频道）不会被误当成标题 —— 这正是
 * 敢在聊天里支持标题的原因。
 */
type Variant = 'chat' | 'doc';

const HEADING_CLS: Record<Variant, string[]> = {
  chat: [
    'mt-1 mb-0.5 text-[17px] font-semibold',
    'mt-1 mb-0.5 text-[16px] font-semibold',
    'mt-1 mb-0.5 text-[15px] font-semibold',
    'mt-0.5 text-sm font-semibold',
    'mt-0.5 text-sm font-semibold',
    'mt-0.5 text-sm font-medium text-ink-2',
  ],
  doc: [
    'mt-4 mb-2 text-2xl font-semibold',
    'mt-4 mb-2 text-xl font-semibold',
    'mt-3 mb-1.5 text-lg font-semibold',
    'mt-3 mb-1.5 text-base font-semibold',
    'mt-2 mb-1 text-sm font-semibold',
    'mt-2 mb-1 text-sm font-medium text-ink-2',
  ],
};

/** 表格的一行；不是表格就返回 null */
function splitRow(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  return t
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

const isTableSeparator = (line: string): boolean =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

function renderBlocks(
  text: string,
  me: string | undefined,
  keyBase: string,
  variant: Variant,
  wi: WiVariant,
): ReactNode[] {
  const lines = text.split('\n');
  const nodes: ReactNode[] = [];
  const chat = variant === 'chat';

  let i = 0;
  const push = (n: ReactNode) => nodes.push(n);

  while (i < lines.length) {
    const line = lines[i];
    const key = `${keyBase}-b${i}`;

    // 标题（# 后必须有空格）
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}` as 'h1';
      push(
        <Tag key={key} className={HEADING_CLS[variant][level - 1]}>
          {renderInline(heading[2], me, key, wi)}
        </Tag>,
      );
      i++;
      continue;
    }

    // 分割线
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      push(<hr key={key} className={chat ? 'my-1.5 border-line' : 'my-4 border-line'} />);
      i++;
      continue;
    }

    // 表格：至少「表头 + 分隔行」两行
    const header = splitRow(line);
    if (header && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length) {
        const cells = splitRow(lines[j]);
        if (!cells) break;
        rows.push(cells);
        j++;
      }
      push(
        <div key={key} className="my-1.5 overflow-x-auto">
          <table className="min-w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                {header.map((h, hi) => (
                  <th
                    key={hi}
                    className="border border-line bg-fill-1 px-2.5 py-1.5 font-medium text-ink"
                  >
                    {renderInline(h, me, `${key}-h${hi}`, wi)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {/* 单元格数可能与表头不一致，按表头补齐，别让表格塌掉 */}
                  {header.map((_, ci) => (
                    <td key={ci} className="border border-line px-2.5 py-1.5 text-ink-2">
                      {renderInline(r[ci] ?? '', me, `${key}-r${ri}c${ci}`, wi)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j;
      continue;
    }

    // 引用：连续多行合成一块
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      push(
        <blockquote
          key={key}
          className={`border-l-[3px] border-line pl-2.5 text-ink-2 ${chat ? 'my-1' : 'my-1.5'}`}
        >
          {renderBlocks(buf.join('\n'), me, `${key}-q`, variant, wi)}
        </blockquote>,
      );
      continue;
    }

    // 任务列表要先于普通列表判断，否则 [x] 会被当成正文
    const task = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      const done = task[2].toLowerCase() === 'x';
      push(
        <div
          key={key}
          className="flex items-start gap-2 py-0.5"
          style={{ paddingLeft: indentOf(task[1]) }}
        >
          <input type="checkbox" checked={done} readOnly className="mt-1 accent-primary" />
          <span className={done ? 'text-ink-3 line-through' : ''}>
            {renderInline(task[3], me, key, wi)}
          </span>
        </div>,
      );
      i++;
      continue;
    }

    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      push(
        <div key={key} className="flex gap-2 py-0.5" style={{ paddingLeft: indentOf(ordered[1]) }}>
          <span className="shrink-0 text-ink-3">{ordered[2]}.</span>
          <span className="min-w-0">{renderInline(ordered[3], me, key, wi)}</span>
        </div>,
      );
      i++;
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      push(
        <div key={key} className="flex gap-2 py-0.5" style={{ paddingLeft: indentOf(bullet[1]) }}>
          <span className="shrink-0 text-ink-3">•</span>
          <span className="min-w-0">{renderInline(bullet[2], me, key, wi)}</span>
        </div>,
      );
      i++;
      continue;
    }

    // 普通段落：连续的非空行并成一段，段内换行保留
    if (!line.trim()) {
      i++;
      continue;
    }
    // 先无条件吃掉当前行，再往后聚合。这一步是死循环的护栏：段落分支是所有块分支的
    // 兜底，任何被 isBlockStart 判为块起始、却没有对应分支消费的行（例如没有分隔行、
    // 不构成表格的 `|` 开头行）都会落到这里；若不先吃掉当前行，聚合 while 会因
    // isBlockStart 恒真而一次不执行、i 不推进，外层 while 就死循环了。
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    push(
      <p key={key} className={`whitespace-pre-wrap ${chat ? '' : 'my-2'}`}>
        {renderInline(para.join('\n'), me, `${key}-p`, wi)}
      </p>,
    );
  }

  return nodes;
}

/** 每层缩进 16px；不做真正的嵌套列表，视觉对齐就够聊天用了 */
function indentOf(spaces: string): number {
  return Math.min(Math.floor(spaces.replace(/\t/g, '  ').length / 2), 4) * 16;
}

/** 这一行是否会开启一个新的块（用来判断段落到哪儿结束） */
function isBlockStart(line: string): boolean {
  return (
    /^#{1,6}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^\s*(---+|\*\*\*+|___+)\s*$/.test(line) ||
    /^\s*\|/.test(line)
  );
}

/** 代码块切分 + 逐段块级渲染（聊天与文档共用） */
function renderWithCodeFences(
  text: string,
  me: string | undefined,
  variant: Variant,
  wi: WiVariant,
): ReactNode {
  const chat = variant === 'chat';
  const parts = text.split(/```(?:\w*\n)?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre
            key={i}
            className={`overflow-x-auto rounded-md bg-code-bg font-mono leading-relaxed text-code-ink ${
              chat ? 'my-1 p-2.5 text-xs' : 'my-3 p-3 text-xs'
            }`}
          >
            {part.replace(/\n$/, '')}
          </pre>
        ) : part.trim() ? (
          <Fragment key={i}>{renderBlocks(part, me, String(i), variant, wi)}</Fragment>
        ) : null,
      )}
    </>
  );
}

/** 聊天消息 */
export function renderMarkdown(text: string, me?: string): ReactNode {
  // 隐藏消息开头的引用链接（[ ](url) 前缀，引用内容由附件渲染）
  text = text.replace(/^(\s*\[ \]\((?:https?:\/\/|\/)[^)\s]*\)\s*)+/, '');
  // 整条消息只有工作项引用 → 大卡片；夹在文字里 → 紧凑 chip + 悬浮卡
  return renderWithCodeFences(text, me, 'chat', isPureWorkItemText(text) ? 'card' : 'chip');
}

/** 文档预览（.md 文件）：同一套解析，排版更松 */
export function renderMarkdownDoc(text: string): ReactNode {
  return renderWithCodeFences(text, undefined, 'doc', 'chip');
}

/** 纯 URL 链接化（附件卡片等场景用，不做其余 markdown） */
export function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noreferrer"
            className="break-all text-primary underline-offset-2 hover:underline"
          >
            {part}
          </a>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
