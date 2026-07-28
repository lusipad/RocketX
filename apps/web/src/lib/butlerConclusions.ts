import { parseAdoUrl } from './ado';
import type { ButlerSource } from './butlerContext';
import { BARE_URL_SOURCE } from './urlText';

export type ButlerConclusionRef = `msg:${string}` | `wi:${number}` | `pr:${number}` | `build:${number}`;

export interface ButlerConclusion {
  /** 从 0 起，用于本地 state key 与无障碍标签 */
  index: number;
  /** 去掉列表前缀后的原文（含 markdown 链接语法），仅供展示与调试 */
  text: string;
  /** 去链接、去 markdown 记号后的完整文本：**写入待办时用这个**，否则标题里会焊着一整条 permalink */
  plain: string;
  /** plain 截断后的短标题，按钮提示用 */
  label: string;
  ref: ButlerConclusionRef;
  /** 命中的工具来源。msg/wi 的写动作必须有它 */
  source?: ButlerSource;
  /** 仅 pr/build：sources 未命中但链接过了同集合校验，可安全「打开」 */
  fallbackWebUrl?: string;
  can: { open: boolean; todo: boolean; watch: boolean };
}

export interface ButlerConclusionEnv {
  siteUrl: string;
  adoBase: string | null;
  sources?: readonly ButlerSource[];
}

// 与 markdown.tsx 的列表判定保持同一口径（那边是 tsx + React，不能直接 import）
const TASK_ITEM = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
const ORDERED_ITEM = /^(\s*)(\d+)[.)]\s+(.*)$/;
const BULLET_ITEM = /^(\s*)[-*+]\s+(.*)$/;
/** 技能统一要求的粗体小标题，本身不是结论 */
const SECTION_HEADING = /^\*\*[^*]+\*\*\s*[:：]?\s*$/;

const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
// 与 markdown.tsx 共用同一份字符类：口径不一致会让「界面上可点、解析器认不出」
const BARE_URL = new RegExp(BARE_URL_SOURCE, 'g');
const BARE_WORK_ITEM = /(?:^|[^\w#])#(\d+)\b/;

const LABEL_LIMIT = 24;

function listItemText(row: string): string | null {
  const task = TASK_ITEM.exec(row);
  if (task) return task[3];
  const ordered = ORDERED_ITEM.exec(row);
  if (ordered) return ordered[3];
  const bullet = BULLET_ITEM.exec(row);
  if (bullet) return bullet[2];
  return null;
}

/** 去链接、去 markdown 记号的洁净文本：写入待办用它，不截断 */
function plainText(text: string): string {
  return text
    .replace(MARKDOWN_LINK, '$1')
    .replace(BARE_URL, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s*·\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortLabel(plain: string): string {
  return plain.length > LABEL_LIMIT ? `${plain.slice(0, LABEL_LIMIT)}…` : plain;
}

function sameOrigin(href: string, siteUrl: string): URL | null {
  try {
    const target = new URL(href);
    const site = new URL(siteUrl);
    return target.origin.toLocaleLowerCase() === site.origin.toLocaleLowerCase() ? target : null;
  } catch {
    return null;
  }
}

/** 按在文本中出现的位置返回全部链接（markdown 与裸 URL 混排、去重） */
function hrefsOf(text: string): string[] {
  const found: Array<{ at: number; href: string }> = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    found.push({ at: match.index ?? 0, href: match[2] });
  }
  for (const match of text.matchAll(BARE_URL)) {
    const at = match.index ?? 0;
    // markdown 链接里的 URL 会被裸 URL 正则再命中一次，位置落在同一区间内则跳过
    if (found.some((item) => item.href === match[0])) continue;
    found.push({ at, href: match[0] });
  }
  found.sort((left, right) => left.at - right.at);
  return found.map((item) => item.href);
}

interface Anchor {
  ref: ButlerConclusionRef;
  href?: string;
}

/** 能做的动作越多，越应该成为这条结论的归属对象 */
const ANCHOR_PRIORITY: Record<string, number> = { msg: 0, wi: 1, pr: 2, build: 3 };

/**
 * 结论文本自带的归属锚点：技能强制每条带 [原文](link) / [#编号](webUrl)，这里只做反解。
 *
 * **按能力优先级挑选而不是取第一个**：承诺类结论常写成
 * 「张三承诺修完 [#202](工作项) · [原文](permalink)」，取第一个会把归属判给工作项，
 * 「等待跟进」（等待记录的唯一入口）就此消失。
 */
function anchorOf(text: string, env: ButlerConclusionEnv): Anchor | null {
  const anchors: Anchor[] = [];
  const hrefs = hrefsOf(text);
  for (const href of hrefs) {
    const permalink = sameOrigin(href, env.siteUrl);
    const mid = permalink?.searchParams.get('msg');
    if (mid) {
      anchors.push({ ref: `msg:${mid}`, href });
      continue;
    }
    const entity = parseAdoUrl(href, env.adoBase);
    if (entity?.kind === 'workitem') anchors.push({ ref: `wi:${entity.id}`, href });
    else if (entity?.kind === 'pullrequest') anchors.push({ ref: `pr:${entity.id}`, href });
    else if (entity?.kind === 'build') anchors.push({ ref: `build:${entity.id}`, href });
  }
  // 只有整条结论里没有任何链接时才认裸 #编号（与 markdown.tsx 的工作项判定同口径）
  if (hrefs.length === 0 && env.adoBase) {
    const bare = BARE_WORK_ITEM.exec(text);
    if (bare) anchors.push({ ref: `wi:${Number(bare[1])}` });
  }
  if (anchors.length === 0) return null;
  return anchors.reduce((best, candidate) => {
    const bestRank = ANCHOR_PRIORITY[best.ref.split(':', 1)[0]] ?? 9;
    const rank = ANCHOR_PRIORITY[candidate.ref.split(':', 1)[0]] ?? 9;
    return rank < bestRank ? candidate : best;
  });
}

function findSource(
  ref: ButlerConclusionRef,
  sources: readonly ButlerSource[] | undefined,
): ButlerSource | undefined {
  if (!sources?.length) return undefined;
  if (ref.startsWith('msg:')) {
    const mid = ref.slice(4);
    return sources.find((source) => source.kind === 'message' && source.mid === mid && !!source.rid);
  }
  const [kind, id] = ref.split(':', 2);
  const wanted = kind === 'wi' ? 'work-item' : kind === 'pr' ? 'pull-request' : 'build';
  return sources.find((source) => source.kind === wanted && source.id === id);
}

/**
 * 把一段管家回答切成可动手的结论。
 *
 * **铁律**：模型写的链接只当**选择器**，写动作的一切字段（rid/mid/roomName/正文）
 * 必须来自命中的 `ButlerSource`——那是工具真实返回的数据。查不到就不产出这一条，
 * 宁可少给按钮，也不让模型编造出来的 id 变成写操作。
 */
export function parseButlerConclusions(
  text: string,
  env: ButlerConclusionEnv,
): ButlerConclusion[] {
  const conclusions: ButlerConclusion[] = [];
  for (const row of text.split('\n')) {
    const trimmed = row.trim();
    if (!trimmed || SECTION_HEADING.test(trimmed)) continue;
    const item = listItemText(row);
    if (!item?.trim()) continue;
    const anchor = anchorOf(item, env);
    if (!anchor) continue;
    const source = findSource(anchor.ref, env.sources);
    const isMessage = anchor.ref.startsWith('msg:');
    const isWorkItem = anchor.ref.startsWith('wi:');

    // 消息：没有命中来源就连「打开」都不给——没有 rid 也跳不回去
    if (isMessage && !source) continue;
    // 裸 #编号 的工作项没有来源兜底，同样不产出
    if (isWorkItem && !source && !anchor.href) continue;

    const fallbackWebUrl = !source && anchor.href ? anchor.href : undefined;
    const plain = plainText(item);
    if (!plain) continue;
    conclusions.push({
      index: conclusions.length,
      text: item.trim(),
      plain,
      label: shortLabel(plain),
      ref: anchor.ref,
      ...(source ? { source } : {}),
      ...(fallbackWebUrl ? { fallbackWebUrl } : {}),
      can: {
        open: true,
        todo: !!source && (isMessage || isWorkItem),
        watch: isMessage && !!source,
      },
    });
  }
  return conclusions;
}

/**
 * 从消息来源的 label 里取发言人，供「等待跟进」预填。
 * label 由 extractButlerSources 机器生成，形如 `房间 · 发言人：正文`，
 * 比从模型散文里猜人名可靠得多。
 */
export function senderFromSourceLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const match = /·\s*([^：:·]+)\s*[：:]/.exec(label);
  const sender = match?.[1]?.trim();
  return sender || undefined;
}
