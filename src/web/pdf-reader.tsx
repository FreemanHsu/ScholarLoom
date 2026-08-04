import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist";

import { pdfViewerUrl } from "./pdf-viewer-url.js";

export type PdfViewerEngine = "native" | "pdfjs";

export function PdfReader({ engine, url, page }: { engine: PdfViewerEngine; url: string; page: number }) {
  if (engine === "native") {
    const src = pdfViewerUrl(url, page);
    return <iframe key={src} title="原始 PDF" src={src} data-viewer-engine="native" />;
  }
  return <PdfJsReader url={url.split("#", 1)[0]!} page={page} />;
}

function PdfJsReader({ url, page }: { url: string; page: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [loadedPercent, setLoadedPercent] = useState(0);
  const [renderedPage, setRenderedPage] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const updateWidth = () => setAvailableWidth(Math.max(1, scroll.clientWidth - 32));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setDocument(null);
    setLoadedPercent(0);
    setRenderedPage(null);
    setError(null);

    void Promise.all([
      import("pdfjs-dist"),
      import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
    ]).then(async ([pdfjs, worker]) => {
      if (cancelled) return;
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      loadingTask = pdfjs.getDocument({ url, rangeChunkSize: 64 * 1024 });
      loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
        if (!cancelled && total > 0) setLoadedPercent(Math.min(100, Math.round((loaded / total) * 100)));
      };
      const nextDocument = await loadingTask.promise;
      if (cancelled) return;
      setDocument(nextDocument);
      setLoadedPercent(100);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "PDF.js 加载失败");
    });

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [url]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!document || !canvas || availableWidth <= 0) return;
    const targetPage = Math.min(document.numPages, Math.max(1, page));
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    setRenderedPage(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;

    void document.getPage(targetPage).then(async (pdfPage) => {
      if (cancelled) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: availableWidth / natural.width });
      const outputScale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      renderTask = pdfPage.render({
        canvas,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      });
      await renderTask.promise;
      if (!cancelled) setRenderedPage(targetPage);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : "PDF.js 渲染失败");
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [availableWidth, document, page]);

  if (error) {
    const fallbackSrc = pdfViewerUrl(url, page);
    return <div className="pdfjs-fallback" data-viewer-engine="native-fallback">
      <div className="pdfjs-fallback-status" role="alert">
        PDF.js 暂时无法显示原文，已切换到浏览器 PDF 阅读器。
      </div>
      <iframe key={fallbackSrc} title="原始 PDF" src={fallbackSrc} />
    </div>;
  }

  const busy = !error && renderedPage !== page;
  const status = !document ? `正在加载原文… ${loadedPercent}%` : `正在渲染第 ${page} 页…`;
  return <div className="pdfjs-reader" data-viewer-engine="pdfjs" aria-busy={busy} ref={scrollRef}>
    {busy && <div className="pdfjs-status" role="status" aria-live="polite">{status}</div>}
    <div className="pdfjs-page">
      <canvas key={`${url}:${page}`} ref={canvasRef} aria-label={`PDF 第 ${page} 页`}
        {...(renderedPage === page ? { "data-rendered-page": page } : {})} />
    </div>
  </div>;
}
