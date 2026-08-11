import type { RcMessageAttachment } from '@rcx/rc-client';

function attachmentContentLines(attachment: RcMessageAttachment): string[] {
  const fields = (attachment.fields ?? []).map((field) => {
    const title = field.title?.trim();
    const value = field.value?.trim();
    if (title && value) return `${title}：${value}`;
    return title || value || '';
  });

  return [
    attachment.title?.trim() ?? '',
    attachment.text?.trim() ?? '',
    attachment.description?.trim() ?? '',
    ...fields,
    ...(attachment.attachments ?? []).flatMap(attachmentContentLines),
  ].filter(Boolean);
}

export function quoteAttachmentText(attachment: RcMessageAttachment): string | undefined {
  const text = attachment.text?.trim();
  if (text) return text;

  const lines = (attachment.attachments ?? []).flatMap(attachmentContentLines);
  const unique = [...new Set(lines)];
  return unique.length > 0 ? unique.join('\n') : undefined;
}

export function findQuoteImage(
  attachment: RcMessageAttachment,
): RcMessageAttachment | undefined {
  if (attachment.image_url) return attachment;
  return attachment.attachments?.find((nested) => !!nested.image_url);
}
