import type { RoutineTrigger } from '../stores/routines';

export type ButlerAbilityTemplateId =
  | 'mention-triage'
  | 'room-digest'
  | 'morning-brief'
  | 'evening-review';

export type RoutinePrecheck = 'new-mentions' | 'room-activity' | 'none';

export interface ButlerAbilityTemplate {
  id: ButlerAbilityTemplateId;
  title: string;
  description: string;
  skillName: string;
  defaultTrigger: RoutineTrigger;
  precheck: RoutinePrecheck;
  category: 'watch' | 'digest';
  params?: 'rooms';
}

export const BUTLER_ABILITY_TEMPLATES: ButlerAbilityTemplate[] = [
  {
    id: 'mention-triage',
    title: '有人 @ 我，先帮我看',
    description: '有新的 @ 时，帮你逐条判断对方要什么、急不急、下一步怎么做。',
    defaultTrigger: { kind: 'interval', everyMinutes: 15 },
    precheck: 'new-mentions',
    category: 'watch',
    skillName: 'butler-reply-guardian',
  },
  {
    id: 'room-digest',
    title: '群里聊了什么，晚上给我一份',
    description: '每天汇总选定房间的讨论要点，并找出落到你头上的事。',
    skillName: 'room-digest',
    defaultTrigger: { kind: 'daily', time: '21:00' },
    precheck: 'room-activity',
    category: 'digest',
    params: 'rooms',
  },
  {
    id: 'morning-brief',
    title: '晨报',
    description: '早上把要回应、要完成和可能影响交付的事排清楚。',
    skillName: 'morning-brief',
    defaultTrigger: { kind: 'daily', time: '08:30' },
    precheck: 'none',
    category: 'digest',
  },
  {
    id: 'evening-review',
    title: '晚间回顾',
    description: '下班前找出今天还没回应、没完成或会影响交付的事。',
    skillName: 'evening-review',
    defaultTrigger: { kind: 'daily', time: '18:30' },
    precheck: 'none',
    category: 'digest',
  },
];

export function findButlerAbilityTemplate(
  templateId: string,
): ButlerAbilityTemplate | undefined {
  return BUTLER_ABILITY_TEMPLATES.find((template) => template.id === templateId);
}
