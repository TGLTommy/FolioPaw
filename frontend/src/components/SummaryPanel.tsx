import { useState, useEffect, useRef, useCallback } from 'react';
import { X, FileText, BookOpen, ChevronRight, ChevronDown, Loader, CheckCircle, Circle, AlertCircle, Trash2, Zap, RefreshCw, ArrowLeft, ArrowRight } from 'lucide-react';
import { summaryApi } from '../services/api';
import ReactMarkdown from 'react-markdown';
import { getErrorMessage } from '../utils/error';

interface ChapterRange {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  isContent: boolean;
}

interface SummaryRecord {
  id: number;
  book_id: number;
  summary_type: 'chapter' | 'book';
  chapter_id: string | null;
  chapter_title: string | null;
  page_start: number | null;
  page_end: number | null;
  summary_text: string | null;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  error_message: string | null;
  model_used: string | null;
}

interface SummaryPanelProps {
  isOpen: boolean;
  onClose: () => void;
  bookId: number;
  bookTitle: string;
  totalPages: number;
  onNavigateToPage?: (page: number) => void;
}

export default function SummaryPanel({
  isOpen,
  onClose,
  bookId,
  bookTitle,
  totalPages,
  onNavigateToPage,
}: SummaryPanelProps) {
  const [chapters, setChapters] = useState<ChapterRange[]>([]);
  const [summaries, setSummaries] = useState<SummaryRecord[]>([]);
  const [bookSummary, setBookSummary] = useState<SummaryRecord | null>(null);
  const [expandedChapters, setExpandedChapters] = useState<Set<string>>(new Set());
  const [generatingChapters, setGeneratingChapters] = useState<Set<string>>(new Set());
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  const [isGeneratingBook, setIsGeneratingBook] = useState(false);
  const [readingItem, setReadingItem] = useState<{
    type: 'book' | 'chapter';
    title: string;
    pageRange?: string;
    content: string;
    chapterIndex?: number;
  } | null>(null);
  const [, setStreamProgress] = useState({ completed: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef(false);

  // Load summaries when panel opens
  const loadSummaries = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await summaryApi.getSummaries(bookId);
      const data = res.data.data;
      setChapters(data.chapters || []);
      const allSummaries: SummaryRecord[] = data.summaries || [];
      setSummaries(allSummaries.filter(s => s.summary_type === 'chapter'));
      setBookSummary(allSummaries.find(s => s.summary_type === 'book') || null);
    } catch (err: unknown) {
      setError(getErrorMessage(err, '加载摘要失败'));
    } finally {
      setLoading(false);
    }
  }, [bookId]);

  useEffect(() => {
    if (isOpen) {
      loadSummaries();
      abortRef.current = false;
    }
    return () => { abortRef.current = true; };
  }, [isOpen, bookId, loadSummaries]);

  const getChapterSummary = (chapterId: string): SummaryRecord | undefined =>
    summaries.find(s => s.chapter_id === chapterId);

  const getStatusIcon = (chapterId: string) => {
    if (generatingChapters.has(chapterId)) {
      return <Loader size={14} className="animate-spin text-blue-500" />;
    }
    const summary = getChapterSummary(chapterId);
    if (!summary) return <Circle size={14} className="text-gray-400" />;
    if (summary.status === 'completed') return <CheckCircle size={14} className="text-emerald-500" />;
    if (summary.status === 'generating') return <Loader size={14} className="animate-spin text-blue-500" />;
    if (summary.status === 'failed') return <AlertCircle size={14} className="text-red-500" />;
    return <Circle size={14} className="text-gray-400" />;
  };

  const toggleChapter = (chapterId: string) => {
    setExpandedChapters(prev => {
      const next = new Set(prev);
      if (next.has(chapterId)) next.delete(chapterId);
      else next.add(chapterId);
      return next;
    });
  };

  const handleGenerateChapter = async (chapterId: string) => {
    setGeneratingChapters(prev => new Set(prev).add(chapterId));
    setExpandedChapters(prev => new Set(prev).add(chapterId));
    try {
      const res = await summaryApi.generateChapterSummary(bookId, chapterId);
      const newSummary: SummaryRecord = res.data.data;
      setSummaries(prev => {
        const filtered = prev.filter(s => s.chapter_id !== chapterId);
        return [...filtered, newSummary];
      });
    } catch (err: unknown) {
      setError(`生成章节摘要失败：${getErrorMessage(err)}`);
    } finally {
      setGeneratingChapters(prev => {
        const next = new Set(prev);
        next.delete(chapterId);
        return next;
      });
    }
  };

  const handleGenerateBook = async () => {
    setIsGeneratingBook(true);
    try {
      const res = await summaryApi.generateBookSummary(bookId);
      setBookSummary(res.data.data);
    } catch (err: unknown) {
      setError(`生成全书摘要失败：${getErrorMessage(err)}`);
    } finally {
      setIsGeneratingBook(false);
    }
  };

  const handleGenerateAll = async () => {
    setIsGeneratingAll(true);
    abortRef.current = false;
    setStreamProgress({ completed: 0, total: contentChapters.length });

    try {
      const stream = summaryApi.generateAllStream(bookId);
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
            setSummaries(prev => {
              const filtered = prev.filter(s => s.chapter_id !== event.chapterId);
              return [...filtered, {
                id: 0,
                book_id: bookId,
                summary_type: 'chapter',
                chapter_id: event.chapterId,
                chapter_title: event.title,
                page_start: null,
                page_end: null,
                summary_text: event.summary,
                status: 'completed',
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
          case 'book_start':
            setIsGeneratingBook(true);
            break;
          case 'book_complete':
            setBookSummary({
              id: 0,
              book_id: bookId,
              summary_type: 'book',
              chapter_id: null,
              chapter_title: null,
              page_start: 1,
              page_end: totalPages,
              summary_text: event.summary,
              status: 'completed',
              error_message: null,
              model_used: null,
            });
            setIsGeneratingBook(false);
            break;
          case 'book_error':
            setIsGeneratingBook(false);
            break;
        }
      }
    } catch (err: unknown) {
      setError(`批量生成摘要失败：${getErrorMessage(err)}`);
    } finally {
      setIsGeneratingAll(false);
      setIsGeneratingBook(false);
      setGeneratingChapters(new Set());
    }
  };

  const handleDeleteAll = async () => {
    try {
      await summaryApi.deleteSummaries(bookId);
      setSummaries([]);
      setBookSummary(null);
    } catch (err: unknown) {
      setError(`删除摘要失败：${getErrorMessage(err)}`);
    }
  };

  // Close reading modal on ESC
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && readingItem) {
        setReadingItem(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [readingItem]);

  const contentChapters = chapters.filter(c => c.isContent);
  const contentChapterIds = new Set(contentChapters.map(c => c.id));
  const completedCount = summaries.filter(s => s.status === 'completed' && contentChapterIds.has(s.chapter_id || '')).length;
  const hasMultipleContentChapters = contentChapters.length > 1;

  const openChapterReading = (chapter: ChapterRange, index: number) => {
    const summary = getChapterSummary(chapter.id);
    if (summary?.status === 'completed' && summary.summary_text) {
      setReadingItem({
        type: 'chapter',
        title: chapter.title,
        pageRange: `第 ${chapter.pageStart}–${chapter.pageEnd} 页`,
        content: summary.summary_text,
        chapterIndex: index,
      });
    }
  };

  const openBookReading = () => {
    if (bookSummary?.status === 'completed' && bookSummary.summary_text) {
      setReadingItem({
        type: 'book',
        title: '全书摘要',
        pageRange: `${totalPages} 页`,
        content: bookSummary.summary_text,
      });
    }
  };

  const navigateChapter = (direction: -1 | 1) => {
    if (!readingItem || readingItem.type !== 'chapter' || readingItem.chapterIndex == null) return;
    let nextIdx = readingItem.chapterIndex + direction;
    while (nextIdx >= 0 && nextIdx < contentChapters.length) {
      const ch = contentChapters[nextIdx];
      const s = getChapterSummary(ch.id);
      if (s?.status === 'completed' && s.summary_text) {
        setReadingItem({
          type: 'chapter',
          title: ch.title,
          pageRange: `第 ${ch.pageStart}–${ch.pageEnd} 页`,
          content: s.summary_text,
          chapterIndex: nextIdx,
        });
        return;
      }
      nextIdx += direction;
    }
  };

  const hasPrevChapter = (): boolean => {
    if (!readingItem || readingItem.type !== 'chapter' || readingItem.chapterIndex == null) return false;
    for (let i = readingItem.chapterIndex - 1; i >= 0; i--) {
      const s = getChapterSummary(contentChapters[i].id);
      if (s?.status === 'completed' && s.summary_text) return true;
    }
    return false;
  };

  const hasNextChapter = (): boolean => {
    if (!readingItem || readingItem.type !== 'chapter' || readingItem.chapterIndex == null) return false;
    for (let i = readingItem.chapterIndex + 1; i < contentChapters.length; i++) {
      const s = getChapterSummary(contentChapters[i].id);
      if (s?.status === 'completed' && s.summary_text) return true;
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
        className="fixed right-0 top-0 h-full w-[420px] max-w-[90vw] z-50 flex flex-col bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl shadow-[-8px_0_30px_-10px_rgba(0,0,0,0.15)] summary-panel-themed"
        style={{ animation: 'slideIn 0.3s ease-out' }}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-5 pt-5 pb-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-teal-500 to-cyan-600 flex items-center justify-center shadow-lg shadow-teal-500/25">
                <FileText size={18} className="text-white" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">智能摘要</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">AI 内容分析</p>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {(summaries.length > 0 || bookSummary) && !isGeneratingAll && (
                <button
                  onClick={handleDeleteAll}
                  className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors"
                  title="删除所有摘要"
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
              <Loader size={24} className="animate-spin text-teal-500" />
            </div>
          ) : (
            <>
              {error && (
                <div className="bg-red-50 dark:bg-red-950/30 border border-red-200/60 dark:border-red-800/40 rounded-xl p-3">
                  <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
                  <button onClick={() => setError(null)} className="text-xs text-red-500 underline mt-1">关闭</button>
                </div>
              )}

              {/* Book Summary Section */}
              <div className="summary-card rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50 dark:bg-gray-800/50">
                  <span className="text-sm font-semibold text-gray-800 dark:text-gray-200 flex items-center gap-2">
                    <BookOpen size={15} className="text-teal-500" />
                    全书摘要
                  </span>
                  {bookSummary?.status === 'completed' ? (
                    <button
                      onClick={handleGenerateBook}
                      disabled={isGeneratingBook || isGeneratingAll}
                      className="text-xs px-2.5 py-1 rounded-md text-teal-600 hover:bg-teal-50 dark:text-teal-400 dark:hover:bg-teal-950/30 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw size={12} className={isGeneratingBook ? 'animate-spin' : ''} />
                    </button>
                  ) : (
                    <button
                      onClick={handleGenerateBook}
                      disabled={isGeneratingBook || isGeneratingAll}
                      className="text-xs px-2.5 py-1 bg-teal-500 hover:bg-teal-600 text-white rounded-md transition-colors disabled:opacity-50 flex items-center gap-1"
                    >
                      {isGeneratingBook ? <Loader size={12} className="animate-spin" /> : null}
                      {isGeneratingBook ? '生成中...' : hasMultipleContentChapters ? '生成' : '生成摘要'}
                    </button>
                  )}
                </div>
                <div className="px-4 py-3">
                  {bookSummary?.status === 'completed' && bookSummary.summary_text ? (
                    <div
                      className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed cursor-pointer hover:bg-teal-50/30 dark:hover:bg-teal-950/10 rounded-lg transition-colors -mx-1 px-1
                      prose-p:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-headings:font-semibold
                      prose-h3:text-sm prose-h4:text-sm prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5
                      prose-strong:font-semibold prose-strong:text-inherit"
                      onClick={openBookReading}
                      title="点击展开阅读"
                    >
                      <ReactMarkdown>{bookSummary.summary_text}</ReactMarkdown>
                    </div>
                  ) : isGeneratingBook ? (
                    <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
                      <Loader size={14} className="animate-spin" />
                      正在生成全书摘要...
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400 dark:text-gray-500 italic py-1">尚未生成</p>
                  )}
                </div>
              </div>

              {/* Generate All Button — only show when multiple content chapters */}
              {hasMultipleContentChapters && (
                <div className="space-y-2">
                  <button
                    onClick={handleGenerateAll}
                    disabled={isGeneratingAll}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-gradient-to-r from-teal-500 to-cyan-500 hover:from-teal-600 hover:to-cyan-600 text-white rounded-xl text-sm font-medium transition-all shadow-sm hover:shadow-md disabled:opacity-70 disabled:cursor-not-allowed active:scale-[0.98]"
                  >
                    {isGeneratingAll ? (
                      <Loader size={15} className="animate-spin" />
                    ) : (
                      <Zap size={15} />
                    )}
                    {isGeneratingAll ? '正在生成中...' : '一键生成摘要'}
                  </button>

                  {/* Progress bar */}
                  {(isGeneratingAll || completedCount > 0) && (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-teal-500 to-cyan-500 transition-all duration-500"
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

              {/* Chapter List — only show content chapters, hide entirely if ≤1 */}
              {hasMultipleContentChapters && <div className={`space-y-1.5 ${isGeneratingAll ? 'pointer-events-none opacity-60' : ''}`}>
                {contentChapters.map((chapter) => {
                  const isExpanded = expandedChapters.has(chapter.id);
                  const chapterSummary = getChapterSummary(chapter.id);
                  const isGenerating = generatingChapters.has(chapter.id);

                  return (
                    <div key={chapter.id} className="summary-card rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                      {/* Chapter Header */}
                      <div
                        className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors ${chapterSummary?.status === 'completed' ? 'hover:bg-teal-50/50 dark:hover:bg-teal-950/20' : ''}`}
                        onClick={() => {
                          if (chapterSummary?.status === 'completed' && chapterSummary.summary_text) {
                            openChapterReading(chapter, contentChapters.indexOf(chapter));
                          } else {
                            toggleChapter(chapter.id);
                          }
                        }}
                      >
                        {isExpanded ? <ChevronDown size={14} className="text-gray-400 flex-shrink-0" /> : <ChevronRight size={14} className="text-gray-400 flex-shrink-0" />}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">
                            {chapter.title}
                          </div>
                          <button
                            className="text-xs text-gray-400 dark:text-gray-500 hover:text-teal-500 dark:hover:text-teal-400 transition-colors"
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
                          {getStatusIcon(chapter.id)}
                          {!chapterSummary?.summary_text && !isGenerating && !isGeneratingAll && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleGenerateChapter(chapter.id);
                              }}
                              className="text-xs px-2 py-0.5 bg-teal-500 hover:bg-teal-600 text-white rounded transition-colors"
                            >
                              生成
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Expanded Content */}
                      {isExpanded && (
                        <div className="px-3 pb-3 pt-1 border-t border-gray-100 dark:border-gray-800">
                          {isGenerating ? (
                            <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
                              <Loader size={14} className="animate-spin" />
                              正在生成中...
                            </div>
                          ) : chapterSummary?.status === 'completed' && chapterSummary.summary_text ? (
                            <div className="prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed mt-1
                              prose-p:my-1.5 prose-headings:mt-2 prose-headings:mb-1 prose-headings:font-semibold
                              prose-h3:text-sm prose-h4:text-sm prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5
                              prose-strong:font-semibold prose-strong:text-inherit">
                              <ReactMarkdown>{chapterSummary.summary_text}</ReactMarkdown>
                            </div>
                          ) : chapterSummary?.status === 'failed' ? (
                            <div className="text-sm text-red-500 py-1">
                              生成失败: {chapterSummary.error_message}
                              {!isGeneratingAll && (
                                <button
                                  onClick={() => handleGenerateChapter(chapter.id)}
                                  className="ml-2 text-xs underline text-red-400 hover:text-red-600"
                                >
                                  重试
                                </button>
                              )}
                            </div>
                          ) : (
                            <p className="text-sm text-gray-400 dark:text-gray-500 italic py-1">
                              尚未生成摘要
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>}
            </>
          )}
        </div>
      </div>

      {/* Reading Modal */}
      {readingItem && (
        <>
          <div
            className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm"
            onClick={() => setReadingItem(null)}
            style={{ animation: 'modalFadeIn 0.2s ease-out' }}
          />
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center p-4 pointer-events-none"
          >
            <div
              className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-2xl w-[90vw] max-h-[85vh] flex flex-col pointer-events-auto border border-gray-200 dark:border-gray-700"
              style={{ animation: 'modalScaleIn 0.2s ease-out' }}
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
                <div className="flex-1 min-w-0 pr-4">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {readingItem.title}
                  </h3>
                  {readingItem.pageRange && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{readingItem.pageRange}</p>
                  )}
                </div>
                <button
                  onClick={() => setReadingItem(null)}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors flex-shrink-0"
                  aria-label="关闭"
                >
                  <X size={20} />
                </button>
              </div>

              {/* Modal Content */}
              <div className="flex-1 overflow-y-auto px-6 py-5">
                <div className="prose prose-base dark:prose-invert max-w-none leading-relaxed
                  prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold
                  prose-h2:text-lg prose-h3:text-base prose-h4:text-base
                  prose-ul:my-2 prose-ol:my-2 prose-li:my-1
                  prose-strong:font-semibold prose-strong:text-inherit
                  prose-blockquote:border-teal-300 dark:prose-blockquote:border-teal-700
                  prose-code:text-teal-600 dark:prose-code:text-teal-400">
                  <ReactMarkdown>{readingItem.content}</ReactMarkdown>
                </div>
              </div>

              {/* Modal Footer — chapter navigation */}
              {readingItem.type === 'chapter' && (
                <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
                  <button
                    onClick={() => navigateChapter(-1)}
                    disabled={!hasPrevChapter()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-teal-600 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/30 rounded-lg transition-colors disabled:opacity-30 disabled:pointer-events-none"
                  >
                    <ArrowLeft size={14} />
                    上一章
                  </button>
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    {readingItem.chapterIndex != null ? `${readingItem.chapterIndex + 1} / ${contentChapters.length}` : ''}
                  </span>
                  <button
                    onClick={() => navigateChapter(1)}
                    disabled={!hasNextChapter()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-teal-600 dark:hover:text-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/30 rounded-lg transition-colors disabled:opacity-30 disabled:pointer-events-none"
                  >
                    下一章
                    <ArrowRight size={14} />
                  </button>
                </div>
              )}
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
      `}</style>
    </>
  );
}
