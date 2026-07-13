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

    void (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        // worker 必须显式指定，否则 pdf.js 会去猜路径，打包后必然 404
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

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
      void task?.destroy();
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
