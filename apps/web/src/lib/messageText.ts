export const QUOTE_LINK_RE = /^(\s*\[ \]\((?:https?:\/\/|\/)[^)\s]*\)\s*)+/;

/** Rocket.Chat 只会把“链接 + 空格 + 正文”稳定展开为官方引用附件。 */
export function quoteMessagePrefix(messageLink: string): string {
  return `[ ](${messageLink}) `;
}

/** 去掉消息文本开头的引用链接前缀，只保留用户实际看到的正文。 */
export function stripQuotePrefix(text: string): string {
  return text.replace(QUOTE_LINK_RE, '');
}
