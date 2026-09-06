/**
 * 按真实字节嗅探图片 MIME。
 *
 * 桌面端附件拉取链路（Tauri 通道 → fetchFile）可能拿到与字节不符的声明：
 * Rocket.Chat 缩略图服务会把 SVG 转成 PNG 但 URL / 响应头仍写 `image/svg+xml`
 * （或干脆缺失 / application/octet-stream）。webview 的 `<img>` 按声明 MIME
 * 解码 PNG 字节会失败，于是出现「图片装载失败：xxx.svg」。
 *
 * 显示链路以字节魔数为准：声明 Content-Type 只在嗅探不出已知格式时兜底。
 * 这只影响客户端渲染，不会绕开服务端的上传类型策略。
 */

const UTF8 = new TextDecoder('utf-8');

/** 读 blob 头部字节并嗅探已知图片格式；无法判定时返回 null */
export async function sniffImageMime(blob: Blob): Promise<string | null> {
  const probeBytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
  if (probeBytes.length === 0) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    probeBytes.length >= 8 &&
    probeBytes[0] === 0x89 &&
    probeBytes[1] === 0x50 &&
    probeBytes[2] === 0x4e &&
    probeBytes[3] === 0x47 &&
    probeBytes[4] === 0x0d &&
    probeBytes[5] === 0x0a &&
    probeBytes[6] === 0x1a &&
    probeBytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (probeBytes.length >= 3 && probeBytes[0] === 0xff && probeBytes[1] === 0xd8 && probeBytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: GIF87a / GIF89a
  if (probeBytes.length >= 6 && probeBytes[0] === 0x47 && probeBytes[1] === 0x49 && probeBytes[2] === 0x46 && probeBytes[3] === 0x38) {
    return 'image/gif';
  }

  // WebP: RIFF....WEBP
  if (
    probeBytes.length >= 12 &&
    probeBytes[0] === 0x52 &&
    probeBytes[1] === 0x49 &&
    probeBytes[2] === 0x46 &&
    probeBytes[3] === 0x46 &&
    probeBytes[8] === 0x57 &&
    probeBytes[9] === 0x45 &&
    probeBytes[10] === 0x42 &&
    probeBytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  // BMP: BM
  if (probeBytes.length >= 2 && probeBytes[0] === 0x42 && probeBytes[1] === 0x4d) {
    return 'image/bmp';
  }

  // SVG：BOM / 空白之后是 `<`，且前 512 字节内出现 <svg 或 xml 声明 / 注释头。
  const head = UTF8.decode(probeBytes).replace(/^\uFEFF/, '').trimStart();
  if (
    head.startsWith('<') &&
    (/<svg[\s>]/i.test(head) || /<\?xml/i.test(head) || head.startsWith('<!DOCTYPE'))
  ) {
    return 'image/svg+xml';
  }

  return null;
}

/**
 * 字节嗅探优先；嗅探不到时回退到「声明 MIME（非 octet）→ 扩展名 → 原样」。
 * 返回类型被修正的 blob（内容不变），供 URL.createObjectURL 使用。
 */
export async function imageBlobWithDetectedMime(blob: Blob, path: string): Promise<Blob> {
  const sniffed = await sniffImageMime(blob);
  if (sniffed) return blob.slice(0, blob.size, sniffed);
  const declared = blob.type.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') {
    return blob.type === declared ? blob : blob.slice(0, blob.size, blob.type);
  }
  const extension = path.split(/[?#]/, 1)[0]?.split('.').at(-1)?.toLowerCase();
  const mimeType = extension ? IMAGE_MIME_TYPES[extension] : undefined;
  return mimeType ? blob.slice(0, blob.size, mimeType) : blob;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};
