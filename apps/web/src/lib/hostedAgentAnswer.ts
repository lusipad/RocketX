export type HostedAgentAnswer = {
  provider: string;
  note?: string;
  body: string;
};

export type HostedAgentRoleKind = 'product' | 'architect' | 'contrarian' | 'captain';

export interface RoundtableDecisionOption {
  id: string;
  label: string;
  summary?: string;
  recommended?: boolean;
}

export interface RoundtableDecisionPayload {
  title: string;
  consensus: string[];
  contention?: string;
  options: RoundtableDecisionOption[];
  targetFiles?: string[];
  acceptance?: string[];
}

/**
 * 解析由群内 AI 托管或 AI 参与者发出的 `🤖 <AgentName>(（说明）)\n正文` 消息，
 * 排除 `🤖 **` 开头的托管租约状态卡以免误判。
 */
export function parseHostedAgentAnswer(text: string): HostedAgentAnswer | null {
  if (/^🤖\s*\*\*/u.test(text)) return null;
  const match = /^🤖\s*([^\r\n（(]+?)(?:[（(]([^）)\r\n]+)[）)])?[ \t]*\r?\n([\s\S]*)$/u.exec(text);
  const provider = match?.[1]?.trim();
  const body = match?.[3]?.trim();
  if (!match || !provider || provider.length > 48 || !body) return null;
  return {
    provider,
    note: match[2]?.trim() || undefined,
    body,
  };
}

export function inferHostedAgentRole(
  provider: string,
  note?: string,
): HostedAgentRoleKind | null {
  const combined = `${provider} ${note ?? ''}`.toLowerCase();
  if (/(产品设计|产品经理|product\s*design|product\b)/iu.test(combined)) return 'product';
  if (/(架构工程|系统架构|架构师|architecture|architect\b)/iu.test(combined)) return 'architect';
  if (/(挑刺官|挑刺|反方|contrarian|devil'?s\s*advocate)/iu.test(combined)) return 'contrarian';
  if (/(主理人|主理决议|captain|synthesis)/iu.test(combined)) return 'captain';
  return null;
}

export function formatDecisionBlock(decision: RoundtableDecisionPayload): string {
  return ['```rcx-decision', JSON.stringify(decision), '```'].join('\n');
}

function normalizeDecisionPayload(raw: unknown): RoundtableDecisionPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const title = typeof obj.title === 'string' ? obj.title.trim() : '';
  const rawOptions = Array.isArray(obj.options) ? obj.options : [];
  const options: RoundtableDecisionOption[] = [];
  for (const [idx, item] of rawOptions.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const label = typeof rec.label === 'string' ? rec.label.trim() : '';
    if (!label) continue;
    options.push({
      id: typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : `opt-${idx + 1}`,
      label,
      summary: typeof rec.summary === 'string' ? rec.summary.trim() || undefined : undefined,
      recommended: Boolean(rec.recommended),
    });
  }

  if (!title || options.length === 0) return null;

  const consensus = Array.isArray(obj.consensus)
    ? obj.consensus
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
    : [];
  const targetFiles = Array.isArray(obj.targetFiles)
    ? obj.targetFiles
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
    : undefined;
  const acceptance = Array.isArray(obj.acceptance)
    ? obj.acceptance
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.trim())
    : undefined;

  return {
    title,
    consensus,
    contention: typeof obj.contention === 'string' ? obj.contention.trim() || undefined : undefined,
    options,
    targetFiles: targetFiles && targetFiles.length > 0 ? targetFiles : undefined,
    acceptance: acceptance && acceptance.length > 0 ? acceptance : undefined,
  };
}

export function parseDecisionBlockFromBody(body: string): {
  cleanBody: string;
  decision: RoundtableDecisionPayload | null;
} {
  const fencePattern = /```rcx-decision\s*\r?\n([\s\S]*?)\r?\n```/u;
  const match = fencePattern.exec(body);
  if (!match) {
    return { cleanBody: body.trim(), decision: null };
  }
  try {
    const parsedJson = JSON.parse(match[1].trim());
    const decision = normalizeDecisionPayload(parsedJson);
    if (!decision) {
      return { cleanBody: body.trim(), decision: null };
    }
    const cleanBody = `${body.slice(0, match.index)}${body.slice(match.index + match[0].length)}`.trim();
    return { cleanBody, decision };
  } catch {
    return { cleanBody: body.trim(), decision: null };
  }
}

export function summarizeDecisionForHandoff(
  decision: RoundtableDecisionPayload,
  chosenOptionId?: string,
): string {
  const chosen =
    decision.options.find((opt) => opt.id === chosenOptionId)
    ?? decision.options.find((opt) => opt.recommended)
    ?? decision.options[0];
  const lines: string[] = [`- **${decision.title}**`];
  for (const item of decision.consensus.slice(0, 3)) {
    lines.push(`- ✓ ${item}`);
  }
  if (decision.contention) {
    lines.push(`- ⚖️ ${decision.contention}`);
  }
  if (chosen) {
    lines.push(`- → ${chosen.label}${chosen.summary ? `（${chosen.summary}）` : ''}`);
  }
  if (decision.targetFiles?.length) {
    lines.push(`- 📁 ${decision.targetFiles.slice(0, 4).join(', ')}`);
  }
  return lines.join('\n');
}
