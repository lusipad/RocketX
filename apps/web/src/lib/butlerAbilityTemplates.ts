import { t, type MessageKey } from '../i18n';
import type { RoutineTrigger } from '../stores/routines';

export type ButlerAbilityTemplateId =
  | 'mention-triage'
  | 'room-digest'
  | 'morning-brief'
  | 'evening-review';

export type RoutinePrecheck = 'new-mentions' | 'room-activity' | 'none';

export interface ButlerAbilityTemplate {
  id: ButlerAbilityTemplateId;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  promptKey?: MessageKey;
  readonly title: string;
  readonly description: string;
  skillName?: string;
  readonly prompt?: string;
  defaultTrigger: RoutineTrigger;
  precheck: RoutinePrecheck;
  category: 'watch' | 'digest';
  params?: 'rooms';
}

interface ButlerAbilityTemplateSpec {
  id: ButlerAbilityTemplateId;
  titleKey: MessageKey;
  descriptionKey: MessageKey;
  promptKey?: MessageKey;
  skillName?: string;
  defaultTrigger: RoutineTrigger;
  precheck: RoutinePrecheck;
  category: 'watch' | 'digest';
  params?: 'rooms';
}

function createAbilityTemplate(spec: ButlerAbilityTemplateSpec): ButlerAbilityTemplate {
  const entry: ButlerAbilityTemplate = {
    ...spec,
    get title() {
      return t(spec.titleKey);
    },
    get description() {
      return t(spec.descriptionKey);
    },
  };
  if (spec.promptKey) {
    const promptKey = spec.promptKey;
    Object.defineProperty(entry, 'prompt', {
      enumerable: true,
      get() {
        return t(promptKey);
      },
    });
  }
  return entry;
}

export const BUTLER_ABILITY_TEMPLATES: ButlerAbilityTemplate[] = [
  createAbilityTemplate({
    id: 'mention-triage',
    titleKey: 'butler.template.mentionTriage.title',
    descriptionKey: 'butler.template.mentionTriage.description',
    defaultTrigger: { kind: 'interval', everyMinutes: 15 },
    precheck: 'new-mentions',
    category: 'watch',
    skillName: 'butler-reply-guardian',
  }),
  createAbilityTemplate({
    id: 'room-digest',
    titleKey: 'butler.template.roomDigest.title',
    descriptionKey: 'butler.template.roomDigest.description',
    skillName: 'room-digest',
    defaultTrigger: { kind: 'daily', time: '21:00' },
    precheck: 'room-activity',
    category: 'digest',
    params: 'rooms',
  }),
  createAbilityTemplate({
    id: 'morning-brief',
    titleKey: 'butler.template.morningBrief.title',
    descriptionKey: 'butler.template.morningBrief.description',
    promptKey: 'butler.template.morningBrief.prompt',
    defaultTrigger: { kind: 'daily', time: '08:30' },
    precheck: 'none',
    category: 'digest',
  }),
  createAbilityTemplate({
    id: 'evening-review',
    titleKey: 'butler.template.eveningReview.title',
    descriptionKey: 'butler.template.eveningReview.description',
    promptKey: 'butler.template.eveningReview.prompt',
    defaultTrigger: { kind: 'daily', time: '18:30' },
    precheck: 'none',
    category: 'digest',
  }),
];

export function findButlerAbilityTemplate(
  templateId: string,
): ButlerAbilityTemplate | undefined {
  return BUTLER_ABILITY_TEMPLATES.find((template) => template.id === templateId);
}
