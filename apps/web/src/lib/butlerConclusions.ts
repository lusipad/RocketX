import { parseAdoUrl } from './ado';
import type { ButlerSource } from './butlerContext';

export type ButlerConclusionRef = `msg:${string}` | `wi:${number}` | `pr:${number}` | `build:${number}`;

export interface ButlerConclusion {
  /** 从 0 起，用于本地 state key 与无障碍标签 */
  index: number;
  /** 去掉列表前缀后的原文 */
  text: string;
  /** 去链接、去 markdown 记号后的短标题，按钮提示用 */
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
const BARE_URL = /https?:\/\/[^\s)（）「」]+/g;
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

function plainLabel(text: string): string {
  const stripped = text
    .replace(MARKDOWN_LINK, '$1')
    .replace(BARE_URL, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > LABEL_LIMIT ? `${stripped.slice(0, LABEL_LIMIT)}…` : stripped;
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

function hrefsOf(text: string): string[] {
  const hrefs: string[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) hrefs.push(match[2]);
  for (const match of text.matchAll(BARE_URL)) hrefs.push(match[0]);
  return hrefs;
}

interface Anchor {
  ref: ButlerConclusionRef;
  href?: string;
}

/** 结论文本自带的归属锚点：技能强制每条带 [原文](link) / [#编号](webUrl)，这里只做反解。 */
function anchorOf(text: string, env: ButlerConclusionEnv): Anchor | null {
  const hrefs = hrefsOf(text);
  for (const href of hrefs) {
    const permalink = sameOrigin(href, env.siteUrl);
    const mid = permalink?.searchParams.get('msg');
    if (mid) return { ref: `msg:${mid}`, href };
    const entity = parseAdoUrl(href, env.adoBase);
    if (entity?.kind === 'workitem') return { ref: `wi:${entity.id}`, href };
    if (entity?.kind === 'pullrequest') return { ref: `pr:${entity.id}`, href };
    if (entity?.kind === 'build') return { ref: `build:${entity.id}`, href };
  }
  // 只有整条结论里没有任何链接时才认裸 #编号（与 markdown.tsx 的工作项判定同口径）
  if (hrefs.length === 0 && env.adoBase) {
    const bare = BARE_WORK_ITEM.exec(text);
    if (bare) return { ref: `wi:${Number(bare[1])}` };
  }
  return null;
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
    conclusions.push({
      index: conclusions.length,
      text: item.trim(),
      label: plainLabel(item),
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
 * 从消息来源的 label 里取发言人，供「盯它」预填。
 * label 由 extractButlerSources 机器生成，形如 `房间 · 发言人：正文`，
 * 比从模型散文里猜人名可靠得多。
 */
export function senderFromSourceLabel(label: string | undefined): string | undefined {
  if (!label) return undefined;
  const match = /·\s*([^：:·]+)\s*[：:]/.exec(label);
  const sender = match?.[1]?.trim();
  return sender || undefined;
}
