/** 与桌面端本地 HTML 预览的大小上限一致，可容纳带内嵌图片的报告。 */
export const MAX_HTML_PREVIEW_BYTES = 12 * 1024 * 1024;

/** srcDoc 接收的是字符串，交给 iframe 前要先按文件本身的编码解码。 */
export function decodeHtmlPreview(bytes: Uint8Array, ...contentTypes: (string | undefined)[]): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(bytes);

  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const metaCharset = head.match(/<meta\s[^>]*?\bcharset\s*=\s*["']?\s*([\w.-]+)/i)?.[1];
  const headers = contentTypes.map((type) => type?.match(/;\s*charset\s*=\s*["']?\s*([\w.-]+)/i)?.[1]);
  for (const label of [...headers, metaCharset]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // 上传端偶尔给出浏览器不认识的编码名，继续尝试文档声明。
    }
  }
  return new TextDecoder().decode(bytes);
}
