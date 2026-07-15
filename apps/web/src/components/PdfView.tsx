import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * PDF 渲染。
 *
 * 不用 `<iframe src=blob:...>` —— 那完全依赖宿主 webview 自带的 PDF 阅读器插件：
 * 桌面端的 WebView2、无头浏览器、部分 Linux webview 都不一定有，有也不一定认 blob。
 * 用 pdf.js 自己画到 canvas 上，三端行为一致，也才测得了。
 *
 * pdf.js 有 1MB+，单独成块按需加载（打开 PDF 才拉）。
 */
const MAX_PAGES = 50;

export default function PdfView({ data }: { data: ArrayBuffer }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // 销毁走 loadingTask（PDFDocumentProxy 上没有 destroy）
    let task: { destroy: () => Promise<void> } | null = null;
    let worker: Worker | null = null;

    void (async () => {
      try {
        // legacy 构建在 worker 自己的 realm 内补齐 TypedArray.toHex 等新 API；
        // 只在主窗口补 polyfill 无法修复旧 WebView2 中 worker 的 #20 崩溃。
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        if (cancelled) return;
        // worker 用「内联实例」而非「让宿主提供文件」：`?url` 会产出一个 .mjs 资源，
        // 由 pdf.js `new Worker(src, {type:'module'})` 去取——桌面端(Tauri)的 asset
        // 协议对 .mjs 返回的 MIME/scheme 不被 webview 接受，module worker 与 fake
        // worker 双双失败，表现为「PDF解析失败」(issue #10)。改用 Vite 的
        // `?worker&inline` 拿到 Worker 构造器，自己 new 出实例交给 workerPort，
        // pdf.js 直接用现成 worker，跳过取文件+MIME 校验，与宿主如何返回 .mjs 无关。
        const PdfWorker = (
          await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline')
        ).default;
        if (cancelled) return;
        worker = new PdfWorker();
        pdfjs.GlobalWorkerOptions.workerPort = worker;

        // pdf.js 会接管（并清空）传入的 buffer，给它一份拷贝，
        // 否则重新渲染时拿到的是已被分离的 buffer
        const loading = pdfjs.getDocument({ data: data.slice(0) });
        task = loading;
        const pdf = await loading.promise;
        if (cancelled) return;
        setPages(pdf.numPages);
        setLoading(false);

        const host = containerRef.current;
        if (!host) return;
        host.innerHTML = '';

        const width = host.clientWidth - 32;
        const count = Math.min(pdf.numPages, MAX_PAGES);

        for (let i = 1; i <= count; i++) {
          const page = await pdf.getPage(i);
          if (cancelled) return;

          // 按容器宽度铺满；再乘设备像素比，避免高分屏发虚
          const base = page.getViewport({ scale: 1 });
          const scale = width / base.width;
          const dpr = Math.min(window.devicePixelRatio || 1, 2);
          const viewport = page.getViewport({ scale: scale * dpr });

          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = `${viewport.width / dpr}px`;
          canvas.style.height = `${viewport.height / dpr}px`;
          canvas.className = 'mx-auto mb-3 rounded shadow-sm';
          canvas.setAttribute('data-pdf-page', String(i));
          host.appendChild(canvas);

          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvas, canvasContext: ctx, viewport }).promise;
        }
      } catch (err) {
        if (!cancelled) {
          setLoading(false);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
      const activeWorker = worker;
      if (task) void task.destroy().finally(() => activeWorker?.terminate());
      else activeWorker?.terminate();
    };
  }, [data]);

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-sm text-danger">PDF 解析失败</div>
        <div className="max-w-md text-xs break-words text-ink-3">{error}</div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {loading && (
        <div className="flex flex-1 items-center justify-center gap-2 text-sm text-ink-3">
          <Loader2 size={16} className="animate-spin" />
          解析 PDF…
        </div>
      )}
      <div ref={containerRef} className="flex-1 overflow-auto bg-fill-2 p-4" />
      {pages > MAX_PAGES && (
        <div className="shrink-0 border-t border-line py-2 text-center text-xs text-ink-3">
          共 {pages} 页，只渲染了前 {MAX_PAGES} 页，完整内容请下载查看
        </div>
      )}
    </div>
  );
}
