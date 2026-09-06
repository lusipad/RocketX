import { assetUrl, isTauri, normalizeAssetPath, rest } from './client';
import { useDownloadHistory } from '../stores/downloadHistory';
import { fileNameOfDownloadPath, type DownloadSourceV1 } from './downloadHistory';

export interface SaveFileOptions {
  /** 取消下载：中断读取并放弃写盘（仅桌面流式分支生效，网页端由浏览器托管） */
  signal?: AbortSignal;
  /** 桌面流式分支的进度回调；total 为 null 表示服务端没给 content-length */
  onProgress?: (loaded: number, total: number | null) => void;
}

/** 超过这个大小的文件退回整流直写：分块缓冲会等量占内存，进度与内存二选一 */
const PROGRESS_BUFFER_LIMIT = 512 * 1024 * 1024;

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === 'AbortError'
    : err instanceof Error && err.name === 'AbortError';
}

/**
 * 保存站内文件到本地。
 *
 * 两端机制完全不同，别想着统一：
 *
 * - **桌面端**：WebView2 / WKWebView 不认 blob URL 上的 download 属性，点了没反应。
 *   必须用 Rust 通道把文件取回来（顺便绕开 CORS），再走原生「另存为」对话框。
 *   提供 signal / onProgress 时走流式分块读取：边读边回调进度，取消即中断；
 *   超大文件（>512MB）退回整流直写，避免等量内存缓冲。
 *
 * - **网页端**：绝不能用 fetch。Rocket.Chat 只给 `/api/v1/*` 开了 CORS，
 *   `/file-upload/*` 的预检 OPTIONS 不返回 200 —— 服务器地址一旦跨域，
 *   fetch 文件必然被浏览器拦掉。直接用 <a href> 让浏览器去下载即可：
 *   认证靠登录时种下的 rc_uid / rc_token cookie，服务端又带了
 *   `Content-Disposition: attachment`，文件名和下载行为都由它决定。
 *   因此网页端没有进度与取消，下载由浏览器接管。
 *
 * 失败一律抛出（用户取消抛 AbortError），由调用方 toast，不要静默。
 */
export async function saveFile(
  path: string,
  fileName: string,
  source?: DownloadSourceV1,
  options?: SaveFileOptions,
): Promise<void> {
  // Site_Url 拼出来的绝对地址重拼到当前连接地址上，见 normalizeAssetPath 的说明
  path = normalizeAssetPath(path);
  if (isTauri) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const target = await save({ defaultPath: fileName });
    if (!target) return; // 用户取消了保存对话框，不是错误
    const response = await rest.fetchFileResponse(path);
    if (!response.body) throw new Error('文件响应没有可读取的内容');

    const totalHeader = Number(response.headers.get('content-length'));
    const total = Number.isFinite(totalHeader) ? totalHeader : null;

    if ((total ?? Infinity) > PROGRESS_BUFFER_LIMIT) {
      // 超大文件：整流直写不占内存，放弃细粒度进度
      options?.onProgress?.(0, total);
      await writeFile(target, response.body);
      options?.onProgress?.(total ?? 0, total);
      useDownloadHistory.getState().record(fileNameOfDownloadPath(target, fileName), target, source);
      return;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    const onAbort = () => void reader.cancel().catch(() => undefined);
    options?.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      // 流式读取语义：cancel 之后 read() 会正常返回 done，所以循环结束后
      // 必须用 signal.aborted 区分「读完了」和「被取消」，取消不能写半截文件
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        options?.onProgress?.(loaded, total);
      }
      if (options?.signal?.aborted) throw new DOMException('下载已取消', 'AbortError');
      // 分块可能是不同 ArrayBuffer 的视图，合成一块连续缓冲再落盘
      const merged = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      await writeFile(target, merged);
      options?.onProgress?.(loaded, total ?? loaded);
      useDownloadHistory.getState().record(fileNameOfDownloadPath(target, fileName), target, source);
    } catch (err) {
      await reader.cancel().catch(() => undefined);
      throw err;
    } finally {
      options?.signal?.removeEventListener('abort', onAbort);
    }
    return;
  }

  const a = document.createElement('a');
  a.href = path.startsWith('/') ? assetUrl(path) : path;
  a.download = fileName; // 同源时生效；跨域时由服务端的 Content-Disposition 决定
  a.rel = 'noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
