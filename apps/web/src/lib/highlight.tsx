import { Fragment, type ReactNode } from 'react';

/**
 * 把文本里命中关键词的部分标黄（全部命中，不只第一处）。
 * keyword 若被用户手动包成 /.../，先剥掉再匹配（正则搜索时传进来的就是这种）。
 */
export function highlightText(text: string, keyword?: string): ReactNode {
  const raw = keyword?.trim();
  if (!raw) return text;
  // 剥掉 /.../ 正则包装，取里面的字面量来做高亮匹配
  const q = /^\/.*\/$/.test(raw) ? raw.slice(1, -1) : raw;
  if (!q) return text;

  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let i = lower.indexOf(needle, from);
  let n = 0;
  while (i >= 0) {
    if (i > from) parts.push(<Fragment key={`t${n}`}>{text.slice(from, i)}</Fragment>);
    parts.push(
      <mark key={`m${n}`} className="rounded bg-warning/30 px-0.5 text-ink">
        {text.slice(i, i + q.length)}
      </mark>,
    );
    from = i + q.length;
    i = lower.indexOf(needle, from);
    n++;
  }
  if (n === 0) return text;
  if (from < text.length) parts.push(<Fragment key={`t${n}`}>{text.slice(from)}</Fragment>);
  return <>{parts}</>;
}
