import { tsMs, type RcDate, type RcMessageAttachment } from '@rcx/rc-client';

export interface MergedForwardSource {
  text: string;
  ts: RcDate;
  attachments?: RcMessageAttachment[];
}

const PROTECTED_FILE_SEGMENTS = new Set(['file-upload', 'ufs', 'file-decrypt']);

function protectedFileSegment(segment: string): boolean {
  let decoded = segment;
  try {
    for (let i = 0; i < 2; i += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    // 畸形编码无法安全规范化；疑似文件路由时按受保护链接处理。
    return /file|ufs|decrypt|%(?:66|75|64)/i.test(segment);
  }
  return PROTECTED_FILE_SEGMENTS.has(decoded.toLowerCase());
}

function isProtectedRoomFile(url?: string): boolean {
  if (!url) return false;
  try {
    return new URL(url, 'https://rocketx.invalid').pathname
      .split('/')
      .some(protectedFileSegment);
  } catch {
    return false;
  }
}

/**
 * 附件里指向原房间受保护文件的下载路径；不是受保护文件时返回 undefined。
 * 图片优先取原图 image_url，其余文件取 title_link。
 */
export function protectedFilePath(attachment: RcMessageAttachment): string | undefined {
  if (attachment.message_link) return undefined;
  if (isProtectedRoomFile(attachment.image_url)) return attachment.image_url;
  if (isProtectedRoomFile(attachment.title_link)) return attachment.title_link;
  return undefined;
}

/** 重传受保护文件时的文件名：附件标题优先，退回 URL 最后一段，再退回「文件」。 */
export function forwardFileName(attachment: RcMessageAttachment): string {
  if (attachment.title) return attachment.title;
  const path = protectedFilePath(attachment);
  const segment = path?.split('?')[0].split('/').filter(Boolean).at(-1);
  if (!segment) return '文件';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Rocket.Chat 的受保护文件仍归属于原房间。跨房间复制 URL 会让目标成员预览/下载
 * 403；保留附件元数据，但去掉不可访问的资源链接并明确提示去原会话查看。
 */
export function forwardableAttachments(
  attachments: RcMessageAttachment[] | undefined,
  preserveProtectedFiles = false,
): RcMessageAttachment[] {
  return (attachments ?? [])
    .filter((attachment) => !attachment.message_link)
    .map((attachment) => {
      const protectedFile =
        isProtectedRoomFile(attachment.image_url) || isProtectedRoomFile(attachment.title_link);
      if (preserveProtectedFiles || !protectedFile) return attachment;
      const { image_url, image_dimensions, title_link, title_link_download, ...safe } = attachment;
      const label = attachment.title || attachment.description || '文件';
      const notice = `[附件：${label}，请在原会话查看]`;
      return { ...safe, text: [safe.text, notice].filter(Boolean).join('\n') };
    });
}

/** 合并转发仍是一条消息；每条原消息的文字和可安全复用的附件元数据都保留下来。 */
export function mergedForwardAttachments(
  sources: MergedForwardSource[],
  preserveProtectedFiles = false,
): RcMessageAttachment[] {
  return [...sources].sort((left, right) => tsMs(left.ts) - tsMs(right.ts)).flatMap((source) => {
    const attachments = forwardableAttachments(source.attachments, preserveProtectedFiles);
    const header: RcMessageAttachment = {
      text:
        source.text ||
        attachments[0]?.title ||
        (attachments.length > 0 ? '[图片/文件]' : '[空消息]'),
      ts: source.ts,
    };
    return [header, ...attachments];
  });
}
