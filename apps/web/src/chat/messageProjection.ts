import { RcApiError, tsMs, type RcMessage, type RcMessageAttachment } from '@rcx/rc-client';
import { emojify } from '../lib/emoji';
import { QUOTE_LINK_RE, stripQuotePrefix } from '../lib/messageText';
import { isLanControlMessage } from '../lan/protocol';
import { decorateLanMessage } from '../lan/outbox';
import { stripAgentSessionMarker } from '../agent/card';

/**
 * Merge an optimistic/server message without losing a quote attachment that
 * the realtime echo has already expanded.
 */
export function mergeMessageUpdate(current: RcMessage, incoming: RcMessage): RcMessage {
  const quote = current.attachments?.find((attachment) => attachment.message_link);
  const incomingHasQuote = incoming.attachments?.some((attachment) => attachment.message_link);
  if (quote && !incomingHasQuote && QUOTE_LINK_RE.test(incoming.msg)) {
    return {
      ...incoming,
      attachments: [quote, ...(incoming.attachments ?? [])],
    };
  }
  return incoming;
}

export function upsertMessage(list: RcMessage[], message: RcMessage): RcMessage[] {
  if (isLanControlMessage(message.msg)) return list;
  const decorated = decorateLanMessage(message);
  const index = list.findIndex((item) => item._id === decorated._id);
  if (index >= 0) {
    const next = list.slice();
    next[index] = mergeMessageUpdate(list[index], decorated);
    return next;
  }
  return [...list, decorated];
}

export function messageTime(message: RcMessage): number {
  return message.rocketxOriginalTs ?? tsMs(message.ts);
}

export function shouldUseLanFallback(error: unknown, tmid?: string): boolean {
  return !tmid && (!(error instanceof RcApiError) || error.status >= 500);
}

export function messagePreview(msg: RcMessage | undefined): string {
  if (!msg) return '';
  if (isLanControlMessage(msg.msg)) return '';
  const who = msg.u?.name || msg.u?.username || '';
  if (msg.t) return '[系统消息]';
  const text = emojify(stripAgentSessionMarker(msg.msg ?? '').replace(QUOTE_LINK_RE, ''));
  if (text) return who ? `${who}: ${text}` : text;
  if (msg.file?.name) return who ? `${who}: [文件] ${msg.file.name}` : `[文件] ${msg.file.name}`;
  if (msg.attachments?.length) return who ? `${who}: [图片/附件]` : '[图片/附件]';
  return '';
}

export function localQuoteAttachment(quoted: RcMessage): RcMessageAttachment {
  const image = quoted.attachments?.find((attachment) => !!attachment.image_url);
  return {
    message_link: 'local-quote',
    author_name: quoted.u.name || quoted.u.username,
    text:
      stripQuotePrefix(stripAgentSessionMarker(quoted.msg)) ||
      quoted.attachments?.[0]?.title ||
      '[卡片消息]',
    ts: quoted.ts,
    ...(image?.image_url ? { image_url: image.image_url } : {}),
    ...(image
      ? {
          image_url: image.image_url,
          image_dimensions: image.image_dimensions,
          title: image.title,
          title_link: image.title_link,
        }
      : {}),
  };
}
