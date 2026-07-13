import { EMOJI_MAP } from './emoji-map';

/**
 * emoji 短代码。
 *
 * 短代码体系必须与 Rocket.Chat 一致（JoyPixels / emojione），
 * 因为 chat.react 的 reaction key 就是 `:code:`，服务端和官方客户端都按这套认。
 * 完整表由 scripts/gen-emoji.ts 从 emoji-toolkit 生成（含 :cowboy: 这类别名）。
 *
 * 只有 map 进主包——渲染消息时要同步查表。选择器的分类数据（3400+ 项）
 * 只有点开选择器才用得上，见 loadEmojiSections()。
 */
export interface EmojiEntry {
  code: string;
  char: string;
}

export { EMOJI_MAP };

export interface EmojiSection {
  label: string;
  items: EmojiEntry[];
}

let sectionsCache: EmojiSection[] | null = null;

/** 懒加载选择器分类数据（单独成块，不进首屏） */
export async function loadEmojiSections(): Promise<EmojiSection[]> {
  if (sectionsCache) return sectionsCache;
  const { EMOJI_GROUPS } = await import('./emoji-groups');
  sectionsCache = EMOJI_GROUPS.map((g) => ({
    label: g.label,
    items: g.codes.map((code) => ({ code, char: EMOJI_MAP[code] })),
  }));
  return sectionsCache;
}

/** 认不出来的短代码原样返回，别让消息里出现空白 */
export function emojiFromShortcode(code: string): string {
  const name = code.replace(/:/g, '');
  return EMOJI_MAP[name] ?? `:${name}:`;
}

/** 把纯文本里的 :code: 全部替换成 emoji（摘要、预览等不走 markdown 渲染的地方用） */
export function emojify(text: string): string {
  return text.replace(/:([a-z0-9_+-]+):/gi, (m, code: string) => EMOJI_MAP[code] ?? m);
}
