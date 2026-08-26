import { useState, useEffect, useRef, useCallback } from 'react';
import { X, BookOpen, Loader, CheckCircle, Circle, AlertCircle, Trash2, Zap, RefreshCw, ArrowLeft, ArrowRight, Network, ZoomIn, ZoomOut, RotateCcw, Download } from 'lucide-react';
import { mindmapApi } from '../services/api';
import { getErrorMessage } from '../utils/error';
import { sanitizeSvg } from '../utils/sanitize';

interface ChapterRange {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  isContent: boolean;
}

interface MindmapRecord {
  id: number;
  book_id: number;
  chapter_id: string;
  chapter_title: string | null;
  page_start: number | null;
  page_end: number | null;
  svg_content: string | null;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  error_message: string | null;
  model_used: string | null;
}

interface MindMapPanelProps {
  isOpen: boolean;
  onClose: () => void;
  bookId: number;
  bookTitle: string;
  totalPages: number;
  onNavigateToPage?: (page: number) => void;
}

export default function MindMapPanel({
  isOpen,
  onClose,
  bookId,
  bookTitle,
  totalPages,
  onNavigateToPage,
}: MindMapPanelProps) {
  const [chapters, setChapters] = useState<ChapterRange[]>([]);
  const [mindmaps, setMindmaps] = useState<MindmapRecord[]>([]);
  const [generatingChapters, setGeneratingChapters] = useState<Set<string>>(new Set());
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [viewingItem, setViewingItem] = useState<{
    title: string;
    pageRange?: string;
    svgContent: string;
    chapterIndex?: number;
  } | null>(null);
  const [, setStreamProgress] = useState({ completed: 0, total: 0 });
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef(false);

  // Zoom & pan state for modal
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const svgContainerRef = useRef<HTMLDivElement>(null);

  const loadMindmaps = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await mindmapApi.getMindmaps(bookId);
      const data = res.data.data;
      setChapters(data.chapters || []);
      setMindmaps(data.mindmaps || []);
    } catch (err: unknown) {
      setError(getErrorMessage(err, '加载思维导图失败'));
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    if (isOpen) {
      loadMindmaps();
      abortRef.current = false;
    }
    return () => { abortRef.current = true; };
  }, [isOpen, bookId, loadMindmaps]);

  // Reset zoom/pan when viewing item changes
  useEffect(() => {
    if (viewingItem) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
    }
  }, [viewingItem]);

  const getChapterMindmap = (chapterId: string): MindmapRecord | undefined =>
    mindmaps.find(m => m.chapter_id === chapterId);

  const getStatusIcon = (chapterId: string) => {
    if (generatingChapters.has(chapterId)) {
      return <Loader size={14} className="animate-spin text-purple-500" />;
    }
    const mindmap = getChapterMindmap(chapterId);
    if (!mindmap) return <Circle size={14} className="text-gray-400" />;
    if (mindmap.status === 'completed') return <CheckCircle size={14} className="text-purple-500" />;
    if (mindmap.status === 'generating') return <Loader size={14} className="animate-spin text-purple-500" />;
    if (mindmap.status === 'failed') return <AlertCircle size={14} className="text-red-500" />;
    return <Circle size={14} className="text-gray-400" />;
  };

  const handleGenerateChapter = async (chapterId: string) => {
    setGeneratingChapters(prev => new Set(prev).add(chapterId));
    try {
      const res = await mindmapApi.generateMindmap(bookId, chapterId);
      const newMindmap: MindmapRecord = res.data.data;
      setMindmaps(prev => {
        const filtered = prev.filter(m => m.chapter_id !== chapterId);
        return [...filtered, newMindmap];
      });
    } catch (err: unknown) {
      setError(`生成失败: ${getErrorMessage(err)}`);
    } finally {
      setGeneratingChapters(prev => {
        const next = new Set(prev);
        next.delete(chapterId);
        return next;
      });
    }
  };

  const handleGenerateAll = async () => {
    setIsGeneratingAll(true);
    abortRef.current = false;
    setStreamProgress({ completed: 0, total: contentChapters.length });

    try {
      const stream = mindmapApi.generateAllStream(bookId);
      for await (const event of stream) {
        if (abortRef.current) break;

        switch (event.type) {
          case 'init':
            setStreamProgress({ completed: 0, total: event.totalChapters });
            break;
          case 'chapter_start':
            setGeneratingChapters(prev => new Set(prev).add(event.chapterId));
            break;
          case 'chapter_complete':
            setGeneratingChapters(prev => {
              const next = new Set(prev);
              next.delete(event.chapterId);
              return next;
            });
            setMindmaps(prev => {
              const filtered = prev.filter(m => m.chapter_id !== event.chapterId);
              return [...filtered, {
                id: 0,
                book_id: bookId,
                chapter_id: event.chapterId,
                chapter_title: event.title,
                page_start: null,
                page_end: null,
                svg_content: event.svgContent,
                status: 'completed' as const,
                error_message: null,
                model_used: null,
              }];
            });
            setStreamProgress(prev => ({ ...prev, completed: prev.completed + 1 }));
            break;
          case 'chapter_error':
            setGeneratingChapters(prev => {
              const next = new Set(prev);
              next.delete(event.chapterId);
              return next;
            });
            setStreamProgress(prev => ({ ...prev, completed: prev.completed + 1 }));
            break;
        }
      }
    } catch (err: unknown) {
      setError(`生成错误: ${getErrorMessage(err)}`);
    } finally {
      setIsGeneratingAll(false);
      setGeneratingChapters(new Set());
    }
  };

  const handleDeleteAll = async () => {
    try {
      await mindmapApi.deleteMindmaps(bookId);
      setMindmaps([]);
    } catch (err: unknown) {
      setError(`删除失败: ${getErrorMessage(err)}`);
    }
  };

  const handleDownloadHTML = () => {
    const completedMindmaps = mindmaps
      .filter(m => m.status === 'completed' && m.svg_content)
      .sort((a, b) => (a.page_start ?? 0) - (b.page_start ?? 0));

    if (completedMindmaps.length === 0) return;

    setIsDownloading(true);
    try {
      const sections = completedMindmaps.map(m => {
        const title = m.chapter_title || `Chapter ${m.chapter_id}`;
        return `    <section class="chapter">
      <h2>${title}</h2>
      <div class="mindmap">${sanitizeSvg(m.svg_content!)}</div>
    </section>`;
      }).join('\n');

      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${bookTitle} - 思维导图</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; }
    h1 { text-align: center; padding: 40px 20px 10px; font-size: 24px; }
    .subtitle { text-align: center; color: #888; font-size: 14px; margin-bottom: 30px; }
    .chapter { background: #fff; margin: 20px auto; padding: 30px; max-width: 1200px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); page-break-after: always; }
    .chapter h2 { font-size: 18px; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 2px solid #e8e8ff; color: #444; }
    .mindmap { display: flex; justify-content: center; overflow-x: auto; }
    .mindmap svg { max-width: 100%; height: auto; }
    @media print {
      body { background: #fff; }
      .chapter { box-shadow: none; margin: 0; padding: 20px; max-width: none; }
    }
  </style>
</head>
<body>
  <h1>${bookTitle}</h1>
  <p class="subtitle">思维导图合集 · 共 ${completedMindmaps.length} 章</p>
${sections}
</body>
</html>`;

      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${bookTitle}_思维导图.html`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError(`导出失败: ${getErrorMessage(err)}`);
    } finally {
      setIsDownloading(false);
    }
  };

  // Close modal on ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && viewingItem) {
        setViewingItem(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [viewingItem]);

  // Wheel zoom in modal
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(prev => Math.min(Math.max(0.3, prev + delta), 3));
  }, []);

  useEffect(() => {
    const container = svgContainerRef.current;
    if (!container || !viewingItem) return;
    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [viewingItem, handleWheel]);

  // Mouse drag panning
  const handleMouseDown = (e: React.MouseEvent) => {
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isPanningRef.current) return;
    setPan({
      x: e.clientX - panStartRef.current.x,
      y: e.clientY - panStartRef.current.y,
    });
  };

  const handleMouseUp = () => {
    isPanningRef.current = false;
  };

  const contentChapters = chapters.filter(c => c.isContent);
  const completedCount = mindmaps.filter(m => m.status === 'completed' && contentChapters.some(c => c.id === m.chapter_id)).length;
  const hasMultipleContentChapters = contentChapters.length > 1;

  const openChapterViewing = (chapter: ChapterRange, index: number) => {
    const mindmap = getChapterMindmap(chapter.id);
    if (mindmap?.status === 'completed' && mindmap.svg_content) {
      setViewingItem({
        title: chapter.title,
        pageRange: `第 ${chapter.pageStart}–${chapter.pageEnd} 页`,
        svgContent: mindmap.svg_content,
        chapterIndex: index,
      });
    }
  };

  const navigateChapter = (direction: -1 | 1) => {
    if (!viewingItem || viewingItem.chapterIndex == null) return;
    let nextIdx = viewingItem.chapterIndex + direction;
    while (nextIdx >= 0 && nextIdx < contentChapters.length) {
      const ch = contentChapters[nextIdx];
      const m = getChapterMindmap(ch.id);
      if (m?.status === 'completed' && m.svg_content) {
        setViewingItem({
          title: ch.title,
          pageRange: `第 ${ch.pageStart}–${ch.pageEnd} 页`,
          svgContent: m.svg_content,
          chapterIndex: nextIdx,
        });
        return;
      }
      nextIdx += direction;
    }
  };

  const hasPrevChapter = (): boolean => {
    if (!viewingItem || viewingItem.chapterIndex == null) return false;
    for (let i = viewingItem.chapterIndex - 1; i >= 0; i--) {
      const m = getChapterMindmap(contentChapters[i].id);
      if (m?.status === 'completed' && m.svg_content) return true;
    }
    return false;
  };

  const hasNextChapter = (): boolean => {
    if (!viewingItem || viewingItem.chapterIndex == null) return false;
    for (let i = viewingItem.chapterIndex + 1; i < contentChapters.length; i++) {
      const m = getChapterMindmap(contentChapters[i].id);
      if (m?.status === 'completed' && m.svg_content) return true;
    }
    return false;
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 transition-opacity"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="fixed right-0 top-0 h-full w-[420px] max-w-[90vw] z-50 flex flex-col bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl shadow-[-8px_0_30px_-10px_rgba(0,0,0,0.15)]"
        style={{ animation: 'slideIn 0.3s ease-out' }}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-5 pt-5 pb-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-purple-500/25">
                <Network size={18} className="text-white" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">思维导图</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">AI 知识可视化</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {completedCount > 0 && !isGeneratingAll && (
                <button
                  onClick={handleDownloadHTML}
                  disabled={isDownloading}
                  className="p-2 text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded-lg transition-colors disabled:opacity-50"
                  title="下载 HTML"
                >
                  {isDownloading ? <Loader size={16} className="animate-spin" /> : <Download size={16} />}
                </button>
              )}
              {mindmaps.length > 0 && !isGeneratingAll && (
                <button
                  onClick={handleDeleteAll}
                  className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors"
                  title="删除所有思维导图"
                >
                  <Trash2 size={16} />
                </button>
              )}
              <button
                onClick={onClose}
                className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* Book info badge */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-full text-xs">
              <BookOpen size={12} />
              <span className="max-w-[250px] truncate">{bookTitle}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-full text-xs">
              {totalPages} 页
            </span>
          </div>
        </div>

        <div className="h-px bg-gradient-to-r from-transparent via-gray-200 dark:via-gray-700 to-transparent" />

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scroll-smooth">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader size={24} className="animate-spin text-purple-500" />
            </div>
          ) : (
            <>
              {error && (
                <div className="bg-red-50 dark:bg-red-950/30 border border-red-200/60 dark:border-red-800/40 rounded-xl p-3">
                  <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
                  <button onClick={() => setError(null)} className="text-xs text-red-500 underline mt-1">关闭</button>
                </div>
              )}

              {/* Generate All Button */}
              {hasMultipleContentChapters && (
                <div className="space-y-2">
                  <button
                    onClick={handleGenerateAll}
                    disabled={isGeneratingAll}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 text-white rounded-xl text-sm font-medium transition-all shadow-sm hover:shadow-md disabled:opacity-70 disabled:cursor-not-allowed active:scale-[0.98]"
                  >
                    {isGeneratingAll ? (
                      <Loader size={15} className="animate-spin" />
                    ) : (
                      <Zap size={15} />
                    )}
                    {isGeneratingAll ? '正在生成中...' : '一键生成导图'}
                  </button>

                  {/* Progress bar */}
                  {(isGeneratingAll || completedCount > 0) && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-500"
                          style={{ width: `${contentChapters.length > 0 ? (completedCount / contentChapters.length) * 100 : 0}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {completedCount}/{contentChapters.length}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Chapter List */}
              <div className={`space-y-1.5 ${isGeneratingAll ? 'pointer-events-none opacity-60' : ''}`}>
                {contentChapters.map((chapter) => {
                  const chapterMindmap = getChapterMindmap(chapter.id);
                  const isGenerating = generatingChapters.has(chapter.id);

                  return (
                    <div key={chapter.id} className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                      {/* Chapter Header */}
                      <div
                        className={`flex items-center gap-2 px-3 py-2.5 transition-colors ${chapterMindmap?.status === 'completed' ? 'cursor-pointer hover:bg-purple-50/50 dark:hover:bg-purple-950/20' : ''}`}
                        onClick={() => {
                          if (chapterMindmap?.status === 'completed' && chapterMindmap.svg_content) {
                            openChapterViewing(chapter, contentChapters.indexOf(chapter));
                          }
                        }}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                            {chapter.title}
                          </div>
                          <button
                            className="text-xs text-gray-400 dark:text-gray-500 hover:text-purple-500 dark:hover:text-purple-400 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              onNavigateToPage?.(chapter.pageStart);
                              onClose();
                            }}
                          >
                            第 {chapter.pageStart}–{chapter.pageEnd} 页
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {isGenerating && (
                            <Loader size={14} className="animate-spin text-purple-500" />
                          )}
                          {getStatusIcon(chapter.id)}
                          {!chapterMindmap?.svg_content && !isGenerating && !isGeneratingAll && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleGenerateChapter(chapter.id);
                              }}
                              className="text-xs px-2 py-0.5 bg-purple-500 hover:bg-purple-600 text-white rounded transition-colors"
                            >
                              生成
                            </button>
                          )}
                          {chapterMindmap?.status === 'completed' && !isGenerating && !isGeneratingAll && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleGenerateChapter(chapter.id);
                              }}
                              className="p-0.5 text-gray-400 hover:text-purple-500 transition-colors"
                              title="重新生成"
                            >
                              <RefreshCw size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Full-screen SVG viewing modal */}
      {viewingItem && (
        <>
          <div
            className="fixed inset-0 z-[60] bg-black/60 backdrop-blur-sm"
            onClick={() => setViewingItem(null)}
            style={{ animation: 'modalFadeIn 0.2s ease-out' }}
          />
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none">
            <div
              className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-[95vw] max-w-5xl max-h-[90vh] flex flex-col pointer-events-auto border border-gray-200 dark:border-gray-700"
              style={{ animation: 'modalScaleIn 0.2s ease-out' }}
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                <div className="flex-1 min-w-0 pr-4">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {viewingItem.title}
                  </h3>
                  {viewingItem.pageRange && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{viewingItem.pageRange}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {/* Zoom controls */}
                  <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg px-1.5 py-1">
                    <button
                      onClick={() => setZoom(prev => Math.max(0.3, prev - 0.2))}
                      className="p-1 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                      title="缩小"
                    >
                      <ZoomOut size={16} />
                    </button>
                    <span className="text-xs text-gray-500 min-w-[40px] text-center">
                      {Math.round(zoom * 100)}%
                    </span>
                    <button
                      onClick={() => setZoom(prev => Math.min(3, prev + 0.2))}
                      className="p-1 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                      title="放大"
                    >
                      <ZoomIn size={16} />
                    </button>
                    <button
                      onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
                      className="p-1 text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition-colors"
                      title="重置"
                    >
                      <RotateCcw size={14} />
                    </button>
                  </div>
                  <button
                    onClick={() => setViewingItem(null)}
                    className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
                    aria-label="关闭"
                  >
                    <X size={20} />
                  </button>
                </div>
              </div>

              {/* Modal SVG Content */}
              <div
                ref={svgContainerRef}
                className="flex-1 overflow-hidden cursor-grab active:cursor-grabbing bg-gray-50 dark:bg-gray-800/50"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              >
                <div
                  className="w-full h-full flex items-center justify-center"
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                    transformOrigin: 'center center',
                    transition: isPanningRef.current ? 'none' : 'transform 0.1s ease-out',
                  }}
                >
                  <div
                    className="mindmap-svg-container"
                    dangerouslySetInnerHTML={{ __html: sanitizeSvg(viewingItem.svgContent) }}
                    style={{ pointerEvents: 'none' }}
                  />
                </div>
              </div>

              {/* Modal Footer — chapter navigation */}
              <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
                <button
                  onClick={() => navigateChapter(-1)}
                  disabled={!hasPrevChapter()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/30 rounded-lg transition-colors disabled:opacity-30 disabled:pointer-events-none"
                >
                  <ArrowLeft size={14} />
                  上一章
                </button>
                <span className="text-xs text-gray-400 dark:text-gray-500">
                  {viewingItem.chapterIndex != null ? `${viewingItem.chapterIndex + 1} / ${contentChapters.length}` : ''}
                </span>
                <button
                  onClick={() => navigateChapter(1)}
                  disabled={!hasNextChapter()}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-purple-600 dark:hover:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-950/30 rounded-lg transition-colors disabled:opacity-30 disabled:pointer-events-none"
                >
                  下一章
                  <ArrowRight size={14} />
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      <style>{`
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0.5;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        @keyframes modalFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes modalScaleIn {
          from {
            opacity: 0;
            transform: scale(0.95);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }
        .mindmap-svg-container svg {
          max-width: 100%;
          height: auto;
        }
      `}</style>
    </>
  );
}
