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
  skillName?: string;
  prompt?: string;
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
    prompt: [
      '生成今天的晨报。先读取未处理的 @、未完成待办和今天日程，只写有事实依据且需要我行动的内容。',
      '按“今日重点（最多 3 条）/ 待回应 / 今天日程与冲突 / 交付风险”输出；每条说明下一步并保留可用来源链接。',
      '没有数据的分区省略；数据不完整时只用一句话说明缺口。不要写泛泛建议、寒暄、新闻或自我分析。',
    ].join('\n'),
    defaultTrigger: { kind: 'daily', time: '08:30' },
    precheck: 'none',
    category: 'digest',
  },
  {
    id: 'evening-review',
    title: '晚间回顾',
    description: '下班前找出今天还没回应、没完成或会影响交付的事。',
    prompt: [
      '生成今天的晚间回顾。读取未处理的 @、未完成待办和今天日程，只保留尚未回应、尚未完成或可能影响交付的事项。',
      '按“离开前必须处理 / 可顺延到明天 / 等待他人”输出；每条给出明确下一步并保留可用来源链接。',
      '没有事实依据的分区省略；不要复述过程、给泛泛建议或凑字数。',
    ].join('\n'),
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
