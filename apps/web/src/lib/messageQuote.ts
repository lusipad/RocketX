import type { RcMessageAttachment } from '@rcx/rc-client';

export function findQuoteImage(
  attachment: RcMessageAttachment,
): RcMessageAttachment | undefined {
  if (attachment.image_url) return attachment;
  return attachment.attachments?.find((nested) => !!nested.image_url);
}
