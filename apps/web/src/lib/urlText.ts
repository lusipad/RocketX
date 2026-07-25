/**
 * 裸 URL 的合法字符类：排除常见中英文收尾标点，避免「链接，」把标点吃进去。
 *
 * 渲染层（markdown.tsx）与解析层（butlerConclusions.ts）必须用同一份，
 * 否则会出现「界面上链接可点、解析器却认不出」的静默错位。
 */
export const URL_CHARS = `[^\\s<>"'一-龥，。；！？）」』】]`;

export const BARE_URL_SOURCE = `https?://${URL_CHARS}+`;
