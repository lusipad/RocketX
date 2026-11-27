import { tsMs, type RcMessage, type RcMessageAttachment } from '@rcx/rc-client';
import { t } from '../i18n';
import { stripQuotePrefix } from './messageText';
import { stripAgentSessionMarker } from '../agent/card';

function escapeLabel(value: string): string {
  return value.replaceAll('[', '\\[').replaceAll(']', '\\]');
}

function attachmentMarkdown(attachment: RcMessageAttachment): string[] {
  if (attachment.message_link) return [];
  const label = escapeLabel(attachment.title || attachment.description || t('chat.common.attachment'));
  const lines: string[] = [];
  if (attachment.text) lines.push(attachment.text);
  if (attachment.image_url) lines.push(`![${label}](${attachment.image_url})`);
  else if (attachment.title_link) lines.push(`[${label}](${attachment.title_link})`);
  else if (attachment.title && !attachment.text) lines.push(t('chat.output.attachmentTitle', { title: attachment.title }));
  for (const field of attachment.fields ?? []) {
    if (field.title || field.value) {
      lines.push([field.title, field.value].filter(Boolean).join(t('chat.common.colonSep')));
    }
  }
  return lines;
}

export function messageToMarkdown(message: RcMessage): string {
  const lines = [
    stripQuotePrefix(stripAgentSessionMarker(message.msg ?? '')).trim(),
    ...(message.attachments ?? []).flatMap(attachmentMarkdown),
  ].filter(Boolean);
  return lines.join('\n\n') || t('chat.forward.emptyMessage');
}

/** 复制、导出共用：按时间排序，不包含发送人、用户名或用户 ID。 */
export function messagesToMarkdown(messages: readonly RcMessage[]): string {
  return [...messages]
    .sort((left, right) => tsMs(left.ts) - tsMs(right.ts))
    .map(messageToMarkdown)
    .join('\n\n---\n\n');
}
