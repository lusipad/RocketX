import type { RcMessage } from '@rcx/rc-client';

/** 消息里第一张图片附件的服务器路径（原图 title_link 优先，回退缩略图） */
export function messageImagePath(message: RcMessage): string | null {
  const attachment = message.attachments?.find((item) => !!item.image_url);
  if (!attachment) return null;
  return attachment.title_link || attachment.image_url || null;
}

/** 剪贴板只稳定接受 image/png，其他格式先转码（GIF 取第一帧） */
export async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建图片转码画布');
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('图片转码失败'))), 'image/png'),
    );
  } finally {
    bitmap.close();
  }
}

/**
 * 图片消息 → 真实位图进剪贴板，粘贴到其他应用才是图片而不是
 * `![name](/file-upload/…)` 链接文本（issue #92）。
 * 非图片消息或环境不支持位图剪贴板时返回 false，调用方走文本路径。
 * ClipboardItem 的值用 Promise：在点击手势的临时激活窗口内先占位，
 * 图片带鉴权下载并转码完成后再落入剪贴板。
 */
export async function copyMessageImage(
  message: RcMessage,
  fetchFile: (path: string) => Promise<Blob>,
): Promise<boolean> {
  const path = messageImagePath(message);
  if (!path || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': fetchFile(path).then(toPngBlob) }),
  ]);
  return true;
}
