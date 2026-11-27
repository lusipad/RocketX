import { t } from '../i18n';
import {
  asRecord,
  collectStructuredObject,
  optionalString,
  requiredString,
  stringArray,
  type AiChatGateway,
} from './structuredOutput';

export interface MessageExtractionInput {
  rid: string;
  mid: string;
  roomName: string;
  author: string;
  text: string;
  sentAt?: string;
  now?: Date;
  availableWorkItemTypes?: string[];
  /** 当前消息所属话题的上下文；普通消息为空。 */
  context?: ReadonlyArray<{ author: string; text: string; sentAt?: string }>;
}

export interface MessageActionDraft {
  source: Pick<MessageExtractionInput, 'rid' | 'mid' | 'roomName' | 'author'>;
  title: string;
  description?: string;
  due?: string;
  workItemType?: string;
  tags: string[];
}

export interface TodoPrefill {
  rid: string;
  mid: string;
  roomName: string;
  excerpt: string;
  author: string;
  note?: string;
  due?: string;
}

export interface WorkItemPrefill {
  title: string;
  description?: string;
  due?: string;
  type?: string;
  tags: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: unknown): string | undefined {
  const due = optionalString(value, 'due');
  if (!due) return undefined;
  if (!DATE_PATTERN.test(due)) throw new Error(t('agent.extraction.dueFormat'));
  const [year, month, day] = due.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(t('agent.extraction.dueInvalid'));
  }
  return due;
}

function parseDraft(value: unknown, input: MessageExtractionInput): MessageActionDraft {
  const record = asRecord(value);
  const type = optionalString(record.workItemType, 'workItemType');
  const availableTypes = input.availableWorkItemTypes ?? [];
  if (type && availableTypes.length && !availableTypes.includes(type)) {
    throw new Error(t('agent.extraction.invalidType', { type }));
  }
  return {
    source: {
      rid: input.rid,
      mid: input.mid,
      roomName: input.roomName,
      author: input.author,
    },
    title: requiredString(record.title, 'title'),
    description: optionalString(record.description, 'description'),
    due: validDate(record.due),
    workItemType: type,
    tags: stringArray(record.tags, 'tags'),
  };
}

export async function extractMessageAction(
  input: MessageExtractionInput,
  gateway: AiChatGateway,
): Promise<MessageActionDraft> {
  if (!input.text.trim()) throw new Error(t('agent.extraction.emptyMessage'));
  const now = input.now ?? new Date();
  const value = await collectStructuredObject(gateway, 'extraction', {
    responseFormat: 'json',
    thinking: 'disabled',
    maxTokens: 800,
    messages: [
      {
        role: 'system',
        content: [
          t('agent.extraction.sys1'),
          t('agent.extraction.sys2'),
          t('agent.extraction.sys3', { date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` }),
          t('agent.extraction.sys4'),
          t('agent.extraction.sys5'),
          t('agent.extraction.sys6'),
          t('agent.extraction.sys7'),
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          room: input.roomName,
          author: input.author,
          sentAt: input.sentAt ?? null,
          message: input.text,
          context: input.context ?? [],
          availableWorkItemTypes: input.availableWorkItemTypes ?? [],
        }),
      },
    ],
  });
  return parseDraft(value, input);
}

export function toTodoPrefill(draft: MessageActionDraft, originalText: string): TodoPrefill {
  return {
    ...draft.source,
    excerpt: originalText,
    note: draft.title,
    due: draft.due,
  };
}

export function toWorkItemPrefill(draft: MessageActionDraft): WorkItemPrefill {
  return {
    title: draft.title,
    description: draft.description,
    due: draft.due,
    type: draft.workItemType,
    tags: draft.tags.join(';'),
  };
}
