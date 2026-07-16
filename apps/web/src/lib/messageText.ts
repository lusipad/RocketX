export const QUOTE_LINK_RE = /^(\s*\[ \]\((?:https?:\/\/|\/)[^)\s]*\)\s*)+/;

/** 去掉消息文本开头的引用链接前缀，只保留用户实际看到的正文。 */
export function stripQuotePrefix(text: string): string {
  return text.replace(QUOTE_LINK_RE, '');
}
