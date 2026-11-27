import { t } from '../i18n';
import type { ButlerMemoryEntry, ButlerSkillApprovalPolicy, ButlerSkillEntry } from '../platform/desktopCommands';
import { useAcpAgents } from '../stores/acpAgents';
import {
  isMemoryCurrent,
  useButlerMemory,
  validateMemoryNoSecrets,
} from '../stores/butlerMemory';
import { useButlerSkills } from '../stores/butlerSkills';
import { useCodexWorkspace } from '../stores/codexWorkspace';
import { useWorkLedger } from '../stores/workLedger';

export interface DreamMemoryArtifact {
  id: string;
  title: string;
  action: 'created' | 'updated' | 'expired';
  previousContent?: string;
  previousTags?: string[];
  previousEntry?: ButlerMemoryEntry;
}

export interface DreamSkillSnapshot {
  slug: string;
  name: string;
  existedBefore: boolean;
  currentSkillId: string;
  previousSkill?: {
    id: string;
    slug: string;
    name: string;
    description: string;
    category: string;
    instructionsMd: string;
    triggers: string[];
    allowedTools: string[];
    approvalPolicy: ButlerSkillApprovalPolicy;
    workspaceRoot: string | null;
    enabled: boolean;
    pinned: boolean;
  };
}

export interface ButlerDreamJournalEntry {
  id: string;
  dateKey: string;
  at: number;
  trigger: 'auto' | 'manual';
  episodesReviewed: number;
  memoriesConsolidated: number;
  memoriesCreated: number;
  skillsEvolved: number;
  watchpointsPruned: number;
  highlights: string[];
  reflectionMd: string;
  memoryArtifacts?: DreamMemoryArtifact[];
  skillSnapshots?: DreamSkillSnapshot[];
  rolledBackAt?: number;
}

export interface DreamObservationSummary {
  at: number;
  source: string;
  kind: string;
  summary: string;
}

export interface DreamInsightFeedbackItem {
  createdAt: number;
  kind: string;
  title: string;
  userFeedback?: 'accepted' | 'dismissed';
}

export interface ExecuteDreamCycleInput {
  now?: number;
  trigger?: 'auto' | 'manual';
  runner: (input: { workspaceRoot: string; text: string; name: string }) => Promise<{ text: string; threadId?: string }>;
  observations: readonly DreamObservationSummary[];
  insights: readonly DreamInsightFeedbackItem[];
  pruneExpiredWatchpoints: (now: number) => number;
}

function formatLocalDateKey(now: number = Date.now()): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeTitleKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,，。；;:/\\|()\[\]{}"'<>-]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function memoryScore(entry: ButlerMemoryEntry): number {
  return (entry.pinned ? 1_000_000 : 0)
    + entry.recallCount * 100
    + Math.floor(entry.updatedAt / 10_000);
}

export async function consolidateDuplicateMemories(): Promise<number> {
  const memState = useButlerMemory.getState();
  const active = memState.memories.filter(
    (m) => m.accountScope === memState.accountScope && isMemoryCurrent(m),
  );
  if (active.length < 2) return 0;

  // Group by category + workspaceRoot to avoid cross-context collisions.
  const buckets = new Map<string, ButlerMemoryEntry[]>();
  for (const entry of active) {
    const key = `${entry.category}::${(entry.workspaceRoot ?? '').trim().toLowerCase()}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(entry);
    buckets.set(key, bucket);
  }

  let consolidated = 0;
  const expiredIds = new Set<string>();

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const sorted = [...bucket].sort((a, b) => memoryScore(b) - memoryScore(a));
    for (let i = 0; i < sorted.length; i += 1) {
      const keeper = sorted[i];
      if (expiredIds.has(keeper.id)) continue;
      const keeperTitle = normalizeTitleKey(keeper.title);
      const keeperTokens = tokenSet(`${keeper.title} ${keeper.content}`);
      const mergedTags = new Set(keeper.tags);
      let tagsAdded = false;

      for (let j = i + 1; j < sorted.length; j += 1) {
        const candidate = sorted[j];
        if (expiredIds.has(candidate.id)) continue;
        const candTitle = normalizeTitleKey(candidate.title);
        const similarity = jaccardSimilarity(
          keeperTokens,
          tokenSet(`${candidate.title} ${candidate.content}`),
        );
        const isDuplicate = keeperTitle === candTitle || similarity >= 0.82;
        if (!isDuplicate) continue;

        for (const tag of candidate.tags) {
          if (!mergedTags.has(tag)) {
            mergedTags.add(tag);
            tagsAdded = true;
          }
        }
        await memState.expireMemory(candidate.id).catch(() => undefined);
        expiredIds.add(candidate.id);
        consolidated += 1;
      }

      if (tagsAdded) {
        await memState
          .correctMemory(keeper.id, { tags: [...mergedTags].slice(0, 10) })
          .catch(() => undefined);
      }
    }
  }

  return consolidated;
}

export async function calibrateAttentionPreferences(
  insights: readonly DreamInsightFeedbackItem[],
  now: number = Date.now(),
): Promise<number> {
  const memState = useButlerMemory.getState();
  if (memState.memoryPaused) return 0;

  const dismissed = insights.filter((i) => i.userFeedback === 'dismissed');
  if (dismissed.length < 2) return 0;

  const byKind = new Map<string, string[]>();
  for (const item of dismissed) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item.title);
    byKind.set(item.kind, list);
  }

  let createdOrUpdated = 0;
  const dateStr = formatLocalDateKey(now);
  for (const [kind, titles] of byKind.entries()) {
    if (titles.length < 2) continue;
    const title = t('agent.dream.calibrationTitle', { kind });
    const content = t('agent.dream.calibrationContent', {
      kind,
      count: titles.length,
      examples: titles.slice(0, 3).join('; '),
    });
    if (!validateMemoryNoSecrets(content).ok) continue;

    const existing = memState.memories.find(
      (m) =>
        m.accountScope === memState.accountScope
        && isMemoryCurrent(m)
        && m.title === title,
    );
    if (existing) {
      if (existing.content !== content) {
        await memState.correctMemory(existing.id, { content }).catch(() => undefined);
        createdOrUpdated += 1;
      }
    } else {
      await memState
        .upsertMemory({
          category: 'preference',
          title,
          content,
          tags: ['dream-calibrated', 'attention-gate', kind],
          sourceKind: 'assistant_review',
          sourceRef: `dream:${dateStr}`,
          confidence: 0.85,
          enabled: true,
        })
        .catch(() => undefined);
      createdOrUpdated += 1;
    }
  }
  return createdOrUpdated;
}

export function buildDreamReflectionPrompt(input: {
  now: number;
  episodes: readonly { at: number; source: string; kind: string; summary: string }[];
  dismissedTitles: readonly string[];
  acceptedTitles: readonly string[];
  existingMemoryTitles: readonly string[];
  existingSkillSlugs: readonly string[];
  activeCardsSummary: readonly string[];
  acpErrorsSummary: readonly string[];
}): string {
  return [
    '[Butler Daily Dream — Sleep-Time Consolidation & Self-Evolution]',
    `Date: ${formatLocalDateKey(input.now)} (${new Date(input.now).toISOString()})`,
    '',
    'Recent Episodic Observations:',
    ...(input.episodes.length > 0
      ? input.episodes.slice(0, 30).map((e) => `- [${e.source}/${e.kind}] ${e.summary}`)
      : ['- (no observations logged today)']),
    '',
    'Work Card & Sub-Agent Highlights:',
    ...(input.activeCardsSummary.length > 0 ? input.activeCardsSummary.slice(0, 12) : ['- (no active cards)']),
    ...(input.acpErrorsSummary.length > 0 ? input.acpErrorsSummary.slice(0, 8) : []),
    '',
    'Attention Feedback Today:',
    `- Accepted insights: ${input.acceptedTitles.length} (${input.acceptedTitles.slice(0, 5).join('; ') || 'none'})`,
    `- Dismissed insights: ${input.dismissedTitles.length} (${input.dismissedTitles.slice(0, 5).join('; ') || 'none'})`,
    '',
    `Existing Memory Titles (${input.existingMemoryTitles.length}): ${input.existingMemoryTitles.slice(0, 20).join(' | ') || 'none'}`,
    `Existing Skill Slugs (${input.existingSkillSlugs.length}): ${input.existingSkillSlugs.join(', ') || 'none'}`,
    '',
    'Your Dream Objectives (keep edits durable, high-signal, and secret-free):',
    '1. Replay today\'s wins, blockers, errors, and human decisions. Save genuinely reusable project facts, preferences, or failure lessons via `memory_save` (delete stale contradictions via `memory_delete` if needed).',
    '2. If a recurring workflow or multi-step recovery pattern appeared today, crystallize or refine an actionable playbook via `skill_evolve` (always `confirm_write`).',
    '3. Keep output crisp: summarize 2-5 concrete self-improvements from today\'s Dream in markdown.',
  ].join('\n');
}

export async function executeButlerDreamCycle(
  options: ExecuteDreamCycleInput,
): Promise<ButlerDreamJournalEntry> {
  const now = options.now ?? Date.now();
  const trigger = options.trigger ?? 'manual';

  await useButlerMemory.getState().hydrate().catch(() => undefined);
  await useButlerSkills.getState().hydrate().catch(() => undefined);

  const memBeforeMap = new Map<string, ButlerMemoryEntry>(
    useButlerMemory.getState().memories
      .filter((m) => m.accountScope === useButlerMemory.getState().accountScope && isMemoryCurrent(m))
      .map((m) => [m.id, { ...m, tags: [...m.tags] }]),
  );
  const memCountBefore = memBeforeMap.size;
  const skillBeforeMap = new Map<string, ButlerSkillEntry>(
    useButlerSkills.getState().skills.map((s) => [s.slug, {
      ...s,
      triggers: [...s.triggers],
      allowedTools: [...s.allowedTools],
    }]),
  );
  const skillFingerprintBefore = new Map(
    useButlerSkills.getState().skills.map((s) => [s.slug, `${s.updatedAt}:${s.instructionsMd.length}`]),
  );

  // Stage 1: Deterministic local hygiene (deduplicate memories, calibrate attention, prune watchpoints)
  const memoriesConsolidated = await consolidateDuplicateMemories();
  const calibratedCount = await calibrateAttentionPreferences(options.insights, now);
  const watchpointsPruned = options.pruneExpiredWatchpoints(now);

  const recentWindow = now - 24 * 60 * 60_000;
  const recentEpisodes = options.observations.filter((o) => o.at >= recentWindow);
  const recentInsights = options.insights.filter((i) => i.createdAt >= recentWindow);
  const dismissedTitles = recentInsights
    .filter((i) => i.userFeedback === 'dismissed')
    .map((i) => i.title);
  const acceptedTitles = recentInsights
    .filter((i) => i.userFeedback === 'accepted')
    .map((i) => i.title);

  const activeCardsSummary = useWorkLedger.getState().cards
    .filter((c) => !c.done && Boolean(c.state))
    .slice(0, 12)
    .map((c) => `- Card "${c.title}" stage=${c.state.stage} wait=${c.state.waitState}`);
  const acpErrorsSummary = Object.values(useAcpAgents.getState().sessions)
    .filter((s) => s.status === 'error' && s.error)
    .map((s) => `- ACP error (${s.agentName}): ${s.error}`);

  // Stage 2: Reflective LLM consolidation & skill evolution (best-effort)
  const ws = useCodexWorkspace.getState();
  const workspaceRoot =
    ws.workspaceRoot?.trim()
    || ws.butlerWorkspaceRoot?.trim()
    || ws.defaultWorkspaceRoot?.trim()
    || 'd:/Repos/rocketchatx';

  const dateStr = formatLocalDateKey(now);
  let llmReflection = '';
  try {
    const prompt = buildDreamReflectionPrompt({
      now,
      episodes: recentEpisodes,
      dismissedTitles,
      acceptedTitles,
      existingMemoryTitles: useButlerMemory
        .getState()
        .memories.filter(isMemoryCurrent)
        .map((m) => m.title),
      existingSkillSlugs: useButlerSkills.getState().skills.map((s) => s.slug),
      activeCardsSummary,
      acpErrorsSummary,
    });
    const res = await options.runner({
      workspaceRoot,
      text: prompt,
      name: t('agent.dream.runName', { dateKey: dateStr }),
    });
    llmReflection = res.text.trim();
  } catch {
    // Offline or web-mode: deterministic consolidation above still completes cleanly.
  }

  const memAfterList = useButlerMemory.getState().memories.filter(
    (m) => m.accountScope === useButlerMemory.getState().accountScope && isMemoryCurrent(m),
  );
  const memAfterMap = new Map<string, ButlerMemoryEntry>(memAfterList.map((m) => [m.id, m]));
  const memoryArtifacts: DreamMemoryArtifact[] = [];
  for (const after of memAfterList) {
    const before = memBeforeMap.get(after.id);
    if (!before) {
      memoryArtifacts.push({
        id: after.id,
        title: after.title,
        action: 'created',
      });
    } else if (before.content !== after.content || before.updatedAt !== after.updatedAt) {
      memoryArtifacts.push({
        id: after.id,
        title: after.title,
        action: 'updated',
        previousContent: before.content,
        previousTags: [...before.tags],
      });
    }
  }
  for (const [beforeId, before] of memBeforeMap.entries()) {
    if (!memAfterMap.has(beforeId)) {
      memoryArtifacts.push({
        id: beforeId,
        title: before.title,
        action: 'expired',
        previousEntry: before,
      });
    }
  }

  const memCountAfter = memAfterList.length;
  const memoriesCreated = Math.max(0, calibratedCount + (memCountAfter - (memCountBefore - memoriesConsolidated)));
  let skillsEvolved = 0;
  const skillSnapshots: DreamSkillSnapshot[] = [];
  for (const skill of useButlerSkills.getState().skills) {
    const prevFp = skillFingerprintBefore.get(skill.slug);
    const nextFp = `${skill.updatedAt}:${skill.instructionsMd.length}`;
    if (!prevFp || prevFp !== nextFp) {
      skillsEvolved += 1;
      const beforeSkill = skillBeforeMap.get(skill.slug);
      skillSnapshots.push({
        slug: skill.slug,
        name: skill.name,
        existedBefore: Boolean(beforeSkill),
        currentSkillId: skill.id,
        ...(beforeSkill
          ? {
              previousSkill: {
                id: beforeSkill.id,
                slug: beforeSkill.slug,
                name: beforeSkill.name,
                description: beforeSkill.description,
                category: beforeSkill.category,
                instructionsMd: beforeSkill.instructionsMd,
                triggers: [...beforeSkill.triggers],
                allowedTools: [...beforeSkill.allowedTools],
                approvalPolicy: (beforeSkill.approvalPolicy as ButlerSkillApprovalPolicy) || 'confirm_write',
                workspaceRoot: beforeSkill.workspaceRoot,
                enabled: beforeSkill.enabled,
                pinned: beforeSkill.pinned,
              },
            }
          : {}),
      });
    }
  }

  const highlights: string[] = [];
  highlights.push(t('agent.dream.highlightEpisodes', { count: recentEpisodes.length }));
  if (memoriesConsolidated > 0) {
    highlights.push(t('agent.dream.highlightMerged', { count: memoriesConsolidated }));
  }
  if (memoriesCreated > 0) {
    highlights.push(t('agent.dream.highlightCreated', { count: memoriesCreated }));
  }
  if (skillsEvolved > 0) {
    highlights.push(t('agent.dream.highlightSkills', { count: skillsEvolved }));
  }
  if (watchpointsPruned > 0) {
    highlights.push(t('agent.dream.highlightWatchpoints', { count: watchpointsPruned }));
  }

  const fallbackMd = [
    `### ${t('agent.dream.journalHeading', { dateKey: dateStr })}`,
    '',
    ...highlights.map((h) => `- ${h}`),
  ].join('\n');

  return {
    id: `dream-${crypto.randomUUID()}`,
    dateKey: dateStr,
    at: now,
    trigger,
    episodesReviewed: recentEpisodes.length,
    memoriesConsolidated,
    memoriesCreated,
    skillsEvolved,
    watchpointsPruned,
    highlights,
    reflectionMd: llmReflection || fallbackMd,
    ...(memoryArtifacts.length > 0 ? { memoryArtifacts } : {}),
    ...(skillSnapshots.length > 0 ? { skillSnapshots } : {}),
  };
}
