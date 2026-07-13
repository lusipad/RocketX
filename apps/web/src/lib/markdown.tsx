import { Fragment, type ReactNode } from 'react';

/**
 * 轻量消息 Markdown 渲染（不引第三方库、不用 dangerouslySetInnerHTML）。
 * 支持 Rocket.Chat 常用记法：*粗* / **粗**、_斜_、~删除线~、`行内代码`、
 * ```代码块```、URL 自动链接、@提及 与 #频道 高亮。不支持嵌套。
 */

const INLINE_RE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*)|(~~[^~\n]+~~|~[^~\s][^~\n]*~)|(\b_[^_\n]+_\b|(?<=^|\s)_[^_\n]+_(?=$|\s))|(https?:\/\/[^\s<>"']+)|((?<=^|\s)@[\w.\-]+)|((?<=^|\s)#[\w.\-]+)/g;

function renderInline(text: string, me: string | undefined, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(<Fragment key={`${keyBase}-t${i++}`}>{text.slice(last, idx)}</Fragment>);
    const [full] = m;
    const key = `${keyBase}-m${i++}`;
    if (m[1]) {
      nodes.push(
        <code key={key} className="rounded bg-black/8 px-1 py-0.5 font-mono text-[0.9em]">
          {full.slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      const inner = full.startsWith('**') ? full.slice(2, -2) : full.slice(1, -1);
      nodes.push(<strong key={key}>{inner}</strong>);
    } else if (m[3]) {
      const inner = full.startsWith('~~') ? full.slice(2, -2) : full.slice(1, -1);
      nodes.push(<del key={key}>{inner}</del>);
    } else if (m[4]) {
      nodes.push(<em key={key}>{full.slice(1, -1)}</em>);
    } else if (m[5]) {
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
    } else if (m[6]) {
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
    } else if (m[7]) {
      // #纯数字 且配置过工作台 → 链接到 ADO 工作项
      const adoBase = /^#\d+$/.test(full) ? localStorage.getItem('rcx-ado-web') : null;
      if (adoBase) {
        nodes.push(
          <a
            key={key}
            href={`${adoBase}/_workitems/edit/${full.slice(1)}`}
            target="_blank"
            rel="noreferrer"
            title={`Azure DevOps 工作项 ${full}`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {full}
          </a>,
        );
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
  if (last < text.length) nodes.push(<Fragment key={`${keyBase}-t${i++}`}>{text.slice(last)}</Fragment>);
  return nodes;
}

export function renderMarkdown(text: string, me?: string): ReactNode {
  // 先切代码块，再对普通段落做行内解析
  const parts = text.split(/```(?:\w*\n)?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre
            key={i}
            className="my-1 overflow-x-auto rounded-md bg-[#1f2329] p-2.5 font-mono text-xs leading-relaxed text-[#f2f3f5]"
          >
            {part.replace(/\n$/, '')}
          </pre>
        ) : part ? (
          <Fragment key={i}>{renderInline(part, me, String(i))}</Fragment>
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
