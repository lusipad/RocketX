export const QUOTE_LINK_RE = /^(\s*\[ \]\((?:https?:\/\/|\/)[^)\s]*\)\s*)+/;

/** 只接管同一个 Rocket.Chat 部署生成的频道、私有群或私聊永久链接。 */
export function localPermalinkMessageId(href: string, bases: string[]): string | null {
  let url: URL;
  try { url = new URL(href); } catch { return null; }
  const mid = url.searchParams.get('msg');
  if (!mid || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  for (const base of bases) {
    let server: URL;
    try { server = new URL(base); } catch { continue; }
    const prefix = server.pathname.replace(/\/+$/, '') + '/';
    if (url.origin === server.origin && url.pathname.startsWith(prefix) &&
        /^(channel|group|direct)\/[^/]+\/?$/.test(url.pathname.slice(prefix.length))) return mid;
  }
  return null;
}

/** Rocket.Chat 只会把“链接 + 空格 + 正文”稳定展开为官方引用附件。 */
export function quoteMessagePrefix(messageLink: string): string {
  return `[ ](${messageLink}) `;
}

/** 去掉消息文本开头的引用链接前缀，只保留用户实际看到的正文。 */
export function stripQuotePrefix(text: string): string {
  return text.replace(QUOTE_LINK_RE, '');
}
