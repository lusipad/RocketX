import { isTauri, rest } from './client';

/**
 * 保存站内文件到本地。
 *
 * 两端机制完全不同：
 * - Web：blob URL + <a download>，浏览器接管。
 * - 桌面：WebView2 / WKWebView 不认 blob URL 上的 download 属性，点了没反应——
 *   必须走 Tauri 的保存对话框 + 文件系统写入。这是「下载没用」的根因。
 *
 * 失败一律抛出，由调用方 toast，不要静默。
 */
export async function saveFile(path: string, fileName: string): Promise<void> {
  const blob = await rest.fetchFile(path);

  if (isTauri) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const target = await save({ defaultPath: fileName });
    if (!target) return; // 用户取消了保存对话框，不是错误
    await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
