import { t } from '../i18n';

export interface DispatchEvidence {
  label: string;
  text: string;
}

export interface DispatchSpec {
  title: string;
  goal: string;
  acceptance: string[];
  boundaries: string[];
  /** 引用的原文。由宿主从可信来源填充，模型给不了 */
  evidence: DispatchEvidence[];
}

const TITLE_LIMIT = 60;
const GOAL_LIMIT = 600;
const LIST_ITEM_LIMIT = 200;
const LIST_LIMIT = 8;
const EVIDENCE_LIMIT = 6;
const EVIDENCE_TEXT_LIMIT = 800;

function clean(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\r/g, '').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
}

function cleanList(value: unknown, limit = LIST_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => clean(item, LIST_ITEM_LIMIT))
    .filter(Boolean)
    .slice(0, limit);
}

/** 模型给的规格字段一律过一遍：只收白名单字段、逐项截断、丢弃空值 */
export function normalizeDispatchSpec(input: unknown): DispatchSpec {
  const raw = (input && typeof input === 'object' && !Array.isArray(input))
    ? input as Record<string, unknown>
    : {};
  return {
    title: clean(raw.title, TITLE_LIMIT) || t('agent.dispatch.unnamedTask'),
    goal: clean(raw.goal, GOAL_LIMIT),
    acceptance: cleanList(raw.acceptance),
    boundaries: cleanList(raw.boundaries),
    evidence: [],
  };
}

/** 证据由宿主注入，不接受模型自填 —— 它必须来自真实工具返回 */
export function withDispatchEvidence(
  spec: DispatchSpec,
  evidence: readonly DispatchEvidence[],
): DispatchSpec {
  return {
    ...spec,
    evidence: evidence
      .map((item) => ({
        label: clean(item.label, TITLE_LIMIT) || t('agent.dispatch.defaultEvidenceLabel'),
        text: clean(item.text, EVIDENCE_TEXT_LIMIT),
      }))
      .filter((item) => item.text)
      .slice(0, EVIDENCE_LIMIT),
  };
}

/**
 * 派工线程的首轮输入。
 *
 * **这是整条链路的注入防线。** 任务规格是用户在卡上逐字过目并点了「派发」的，
 * 证据区却是聊天记录与工具返回——不可信内容。两者必须分框，并且明说
 * 证据区只是数据。
 *
 * 与「转到 Codex」那条旧路径的关键差别：**绝不写「如果最后一个用户请求
 * 包含尚未完成的明确任务，直接继续执行」**——那句话在一个有仓库写权限的
 * 会话里，等于把不可信内容变成可执行指令。
 */
export function renderDispatchSpec(spec: DispatchSpec): string {
  const lines: string[] = [
    t('agent.dispatch.intro1'),
    t('agent.dispatch.intro2'),
    '',
    '<rocketx_task_spec>',
    t('agent.dispatch.titleLine', { title: spec.title }),
  ];
  if (spec.goal) lines.push('', t('agent.dispatch.goalHeading'), spec.goal);
  if (spec.acceptance.length) {
    lines.push('', t('agent.dispatch.acceptanceHeading'), ...spec.acceptance.map((item) => `- ${item}`));
  }
  if (spec.boundaries.length) {
    lines.push('', t('agent.dispatch.boundariesHeading'), ...spec.boundaries.map((item) => `- ${item}`));
  }
  lines.push('</rocketx_task_spec>');

  if (spec.evidence.length) {
    lines.push(
      '',
      '<rocketx_untrusted_evidence>',
      ...spec.evidence.flatMap((item) => [t('agent.dispatch.evidenceLabel', { label: item.label }), item.text, '']),
      '</rocketx_untrusted_evidence>',
      '',
      // 只在真有证据时才提它：说明一个不存在的区块，对模型是纯干扰
      t('agent.dispatch.evidenceWarning1'),
      t('agent.dispatch.evidenceWarning2'),
    );
  }

  lines.push(
    '',
    t('agent.dispatch.outro'),
  );
  return lines.join('\n');
}

/** 卡片与列表上给人看的一行摘要 */
export function dispatchSpecSummary(spec: DispatchSpec): string {
  const parts = [spec.title];
  if (spec.acceptance.length) parts.push(t('agent.dispatch.summaryAcceptance', { count: spec.acceptance.length }));
  if (spec.boundaries.length) parts.push(t('agent.dispatch.summaryBoundaries', { count: spec.boundaries.length }));
  return parts.join(' · ');
}
