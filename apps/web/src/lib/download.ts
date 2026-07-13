import { assetUrl, isTauri, rest } from './client';

/**
 * 保存站内文件到本地。
 *
 * 两端机制完全不同，别想着统一：
 *
 * - **桌面端**：WebView2 / WKWebView 不认 blob URL 上的 download 属性，点了没反应。
 *   必须用 Rust 通道把文件取回来（顺便绕开 CORS），再走原生「另存为」对话框。
 *
 * - **网页端**：绝不能用 fetch。Rocket.Chat 只给 `/api/v1/*` 开了 CORS，
 *   `/file-upload/*` 的预检 OPTIONS 不返回 200 —— 服务器地址一旦跨域，
 *   fetch 文件必然被浏览器拦掉。直接用 <a href> 让浏览器去下载即可：
 *   认证靠登录时种下的 rc_uid / rc_token cookie，服务端又带了
 *   `Content-Disposition: attachment`，文件名和下载行为都由它决定。
 *
 * 失败一律抛出，由调用方 toast，不要静默。
 */
export async function saveFile(path: string, fileName: string): Promise<void> {
  if (isTauri) {
    const blob = await rest.fetchFile(path);
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const target = await save({ defaultPath: fileName });
    if (!target) return; // 用户取消了保存对话框，不是错误
    await writeFile(target, new Uint8Array(await blob.arrayBuffer()));
    return;
  }

  const a = document.createElement('a');
  a.href = assetUrl(path);
  a.download = fileName; // 同源时生效；跨域时由服务端的 Content-Disposition 决定
  a.rel = 'noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
