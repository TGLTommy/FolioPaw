import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Loader } from 'lucide-react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

interface PdfReaderPaneProps {
  fileUrl: string;
  pageNumber: number;
}

export default function PdfReaderPane({ fileUrl, pageNumber }: PdfReaderPaneProps) {
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(0);
  const [error, setError] = useState('');
  const surfaceRef = useRef<HTMLDivElement>(null);
  const file = useMemo(() => ({ url: fileUrl }), [fileUrl]);

  useEffect(() => {
    setError('');
    setPageCount(null);
    setZoom(1);
  }, [fileUrl]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const updateFitWidth = () => {
      setFitWidth(Math.max(240, surface.clientWidth - 32));
    };
    updateFitWidth();

    const observer = new ResizeObserver(updateFitWidth);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="reader-pdf-frame rounded-lg overflow-hidden flex flex-col h-full">
      {error ? (
        <div className="flex flex-col items-center justify-center flex-1 p-8 bg-red-50/90 dark:bg-red-950/30">
          <AlertCircle size={48} className="text-red-600 dark:text-red-400 mb-4" />
          <h3 className="text-lg font-semibold text-red-800 dark:text-red-300 mb-2">PDF 加载失败</h3>
          <p className="text-red-700 dark:text-red-400 text-center">{error}</p>
        </div>
      ) : (
        <>
          <div ref={surfaceRef} className="reader-pdf-surface flex-1 overflow-auto">
            {fileUrl ? (
              <Document
                file={file}
                className="flex min-h-full min-w-max items-start justify-center p-4"
                onLoadSuccess={({ numPages }) => setPageCount(numPages)}
                onError={() => setError('无法读取 PDF，请确认文件仍存在且当前会话有效。')}
                loading={(
                  <div className="reader-page-status h-96">
                    <Loader size={32} className="animate-spin reader-accent-text" />
                    <span className="reader-muted ml-4">正在加载 PDF...</span>
                  </div>
                )}
                noData={<div className="reader-muted flex items-center justify-center h-96">没有数据</div>}
              >
                <Page
                  pageNumber={pageNumber}
                  width={fitWidth > 0 ? Math.round(fitWidth * zoom) : undefined}
                  renderTextLayer
                  renderAnnotationLayer
                />
              </Document>
            ) : (
              <div className="reader-muted flex items-center justify-center h-96">正在等待 PDF 文件地址...</div>
            )}
          </div>
          {pageCount !== null && (
            <div className="reader-pdf-toolbar flex justify-center items-center gap-2 p-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => setZoom((current) => Math.max(0.5, Number((current - 0.1).toFixed(1))))}
                className="reader-theme-chip px-2 py-1 rounded text-sm"
                aria-label="缩小 PDF"
              >
                −
              </button>
              <span className="min-w-12 text-center text-sm reader-muted">{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onClick={() => setZoom((current) => Math.min(2, Number((current + 0.1).toFixed(1))))}
                className="reader-theme-chip px-2 py-1 rounded text-sm"
                aria-label="放大 PDF"
              >
                +
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
