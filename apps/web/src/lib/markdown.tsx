import { Fragment, type ReactNode } from 'react';
import WorkItemLink from '../components/WorkItemLink';
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
    String.raw`(:[a-zA-Z0-9_+\-]+:)`, // 7 emoji 短代码
    String.raw`((?<=^|[\s一-鿿，。！？；：、])@[\w.\-]+)`, // 8 提及（中文后可紧跟）
    String.raw`((?<=^|[\s一-鿿，。！？；：、])#[\w.\-]+)`, // 9 频道/工作项
  ].join('|'),
  'g',
);

function renderInline(text: string, me: string | undefined, keyBase: string): ReactNode[] {
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
      const adoBase = /^#\d+$/.test(full) ? localStorage.getItem('rcx-ado-web') : null;
      if (adoBase) {
        nodes.push(<WorkItemLink key={key} id={Number(full.slice(1))} />);
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

/** 行级结构：> 引用、- / * 列表，其余整行走行内解析 */
function renderLines(text: string, me: string | undefined, keyBase: string): ReactNode[] {
  const lines = text.split('\n');
  const nodes: ReactNode[] = [];
  let quoteBuffer: string[] = [];
  // 上一行是否为块级元素（引用/列表）：块级元素自带换行，后面不该再补 \n
  let lastWasBlock = false;

  const flushQuote = (key: string) => {
    if (quoteBuffer.length === 0) return;
    const content = quoteBuffer.join('\n');
    quoteBuffer = [];
    nodes.push(
      <blockquote key={key} className="my-1 border-l-[3px] border-line pl-2.5 text-ink-2">
        {renderInline(content, me, `${key}-q`)}
      </blockquote>,
    );
    lastWasBlock = true;
  };

  lines.forEach((line, li) => {
    const key = `${keyBase}-l${li}`;
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      quoteBuffer.push(quote[1]);
      return;
    }
    flushQuote(`${key}-fq`);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      nodes.push(
        <span key={key} className="block pl-1.5">
          <span className="mr-1.5 text-ink-3">•</span>
          {renderInline(bullet[1], me, key)}
        </span>,
      );
      lastWasBlock = true;
      return;
    }
    // 前一行是引用/列表这类块级元素时不再补换行（否则会多出一个空行）
    const prevWasBlock =
      nodes.length > 0 &&
      typeof nodes[nodes.length - 1] !== 'string' &&
      lastWasBlock;
    nodes.push(
      <Fragment key={key}>
        {li > 0 && !prevWasBlock ? '\n' : null}
        {renderInline(line, me, key)}
      </Fragment>,
    );
    lastWasBlock = false;
  });
  flushQuote(`${keyBase}-fq-end`);
  return nodes;
}

export function renderMarkdown(text: string, me?: string): ReactNode {
  // 隐藏消息开头的引用链接（[ ](url) 前缀，引用内容由附件渲染）
  text = text.replace(/^(\s*\[ \]\((?:https?:\/\/|\/)[^)\s]*\)\s*)+/, '');
  // 先切代码块，再对普通段落做行级/行内解析
  const parts = text.split(/```(?:\w*\n)?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre
            key={i}
            className="my-1 overflow-x-auto rounded-md bg-code-bg p-2.5 font-mono text-xs leading-relaxed text-code-ink"
          >
            {part.replace(/\n$/, '')}
          </pre>
        ) : part ? (
          <Fragment key={i}>{renderLines(part, me, String(i))}</Fragment>
        ) : null,
      )}
    </>
  );
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
