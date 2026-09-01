/**
 * 上传通道选择（issue #377）。
 *
 * 桌面端的 HTTP 走 Tauri 插件，请求体在 JS 侧会被物化成「一个字节一个元素」的
 * 普通数组（`Array.from(new Uint8Array(body))`）。500MB 文件需要一个五亿元素的
 * 数组，V8 直接抛 `RangeError: Invalid array length`；小一些的也要吃掉数 GB 内存。
 * 所以超过阈值的内存文件先落盘，再由 Rust 从磁盘流式提交给 Rocket.Chat。
 *
 * 纯函数放在这里，方便回归测试；真正的落盘与上传在 platform/desktopFs.ts。
 */

/** WebView 里允许直接上传的最大字节数。 */
export const DESKTOP_INLINE_UPLOAD_LIMIT = 8 * 1024 * 1024;

/** 落盘分块大小：每块单独走一次 IPC 原始字节通道，峰值内存只有一块。 */
export const UPLOAD_SPOOL_CHUNK = 8 * 1024 * 1024;

/** 落盘临时目录（相对应用数据目录）。 */
export const UPLOAD_SPOOL_DIR = 'upload-spool';

/** 内存文件是否必须先落盘再走原生上传。浏览器端 fetch 自己会流式发送 Blob。 */
export function shouldSpoolUpload(size: number, desktop: boolean): boolean {
  return desktop && Number.isFinite(size) && size > DESKTOP_INLINE_UPLOAD_LIMIT;
}

/**
 * 落盘文件名：Rocket.Chat 上显示的名字取自落盘路径，所以要尽量保留原名，
 * 只清掉路径分隔符、控制字符等在磁盘上非法或可能越界的字符。
 */
export function safeSpoolName(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return (cleaned || 'file').slice(-120);
}

/** 落盘分块的字节区间，最后一块允许不足一个 chunk。 */
export function spoolChunkRanges(size: number, chunk = UPLOAD_SPOOL_CHUNK): [number, number][] {
  if (!Number.isFinite(size) || size <= 0) return [[0, 0]];
  const ranges: [number, number][] = [];
  for (let offset = 0; offset < size; offset += chunk) {
    ranges.push([offset, Math.min(offset + chunk, size)]);
  }
  return ranges;
}
