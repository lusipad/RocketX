import type {
  ImprovementProposal,
  ImprovementTarget,
  RepetitionCandidate,
} from './model';

export function classifyImprovementTarget(
  candidate: RepetitionCandidate,
  existingSkillNames: readonly string[] = [],
): ImprovementTarget {
  if (candidate.intentKey.startsWith('profile:')) return 'profile';
  if (candidate.intentKey.startsWith('remember:')) return 'memory-rule';
  if (candidate.action === 'create-task') return 'task';
  if (candidate.action === 'run-routine') return 'routine';
  if (candidate.action === 'open-view') return 'tool-preset';
  if (candidate.intentKey.startsWith('workflow:')) {
    const requestedSkill = candidate.intentKey.slice('workflow:'.length);
    return existingSkillNames.includes(requestedSkill) ? 'no-op' : 'micro-skill';
  }
  return 'no-op';
}

export function buildImprovementProposal(
  candidate: RepetitionCandidate,
  existingSkillNames: readonly string[] = [],
  now = Date.now(),
): ImprovementProposal {
  const target = classifyImprovementTarget(candidate, existingSkillNames);
  const skillName = target === 'micro-skill'
    ? candidate.intentKey.slice('workflow:'.length).replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-')
    : undefined;
  const labels: Record<ImprovementTarget, string> = {
    task: '把它接成任务',
    profile: '把它变成已确认偏好',
    'memory-rule': '形成可复用规则',
    routine: '沿用现有例行照看',
    'tool-preset': '做成快捷入口',
    'micro-skill': '形成一个小 Skill',
    'no-op': '暂时不自动化',
  };
  return {
    id: `proposal-${candidate.id}`,
    candidateId: candidate.id,
    target,
    title: labels[target],
    rationale: `这套语义操作在 ${candidate.activeDays} 天内出现 ${candidate.occurrences} 次。`,
    preview: [
      `识别意图：${candidate.intentKey}`,
      `读取工作面：${candidate.surfaces.join('、')}`,
      target === 'no-op' ? '保持现状，不新增自动化。' : `先预演“${labels[target]}”，不会直接产生副作用。`,
    ],
    ...(skillName ? { skillName } : {}),
    status: 'suggested',
    createdAt: now,
  };
}
