import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import type { Book, ReadingGuide, ReadingStatus } from '../types/index';
import { bookApi, translationApi, folderApi, readingGuideApi } from '../services/api';
import { useBookStore } from '../stores/useBookStore';
import { useFolderStore } from '../stores/useFolderStore';
import { Upload, BookOpen, Trash2, Loader, FolderInput, MoreHorizontal, Globe, Search, Pin, ArrowUp, ArrowDown, CheckCircle2, Circle, AlertCircle, FileText, Square, CheckSquare2 } from 'lucide-react';
import { useToast } from '../contexts/useToast';
import ConfirmDialog from './ConfirmDialog';
import FolderSidebar from './FolderSidebar';
import CreateFolderDialog from './CreateFolderDialog';
import ReadingGuideDialog from './ReadingGuideDialog';

import { BACKEND_ORIGIN as BACKEND_BASE_URL } from '../config/backend';
import { getApiErrorMessage, getErrorMessage } from '../utils/error';
import { canUseBookTextFeatures } from '../utils/bookCapabilities';

type SortKey = 'upload_time' | 'name' | 'progress' | 'size';
type ReadingStatusFilter = 'all' | ReadingStatus;
type BatchStatus = {
  status: string;
  progress: string;
  processedPages: number;
  totalPages: number;
};
type UploadBookResponse = {
  id?: number;
  total_pages?: number;
  totalPages?: number;
  duplicate?: boolean;
  import_status?: Book['import_status'];
};

type TranslationDisplay = {
  label: string;
  detail: string;
  percent: number;
  translatedPages: number;
  totalPages: number;
  state: 'active' | 'complete' | 'partial' | 'empty' | 'failed' | 'unavailable';
  badgeClass: string;
  barClass: string;
};

type ReadingGuideDisplay = {
  label: string;
  title: string;
  state: 'complete' | 'active' | 'failed' | 'empty';
  className: string;
};

type ReadingStatusDisplay = {
  label: string;
  title: string;
  className: string;
  dotClassName: string;
};

const ACTIVE_JOB_STATUSES = new Set(['pending', 'processing', 'stopping']);
const ACTIVE_IMPORT_STATUSES = new Set(['pending', 'processing']);
const READING_STATUS_OPTIONS: ReadingStatus[] = ['unread', 'reading', 'paused', 'finished', 'abandoned'];
const READING_STATUS_DISPLAY: Record<ReadingStatus, ReadingStatusDisplay> = {
  unread: {
    label: '未读',
    title: '未读',
    className: 'border-gray-200 bg-white/90 text-gray-600',
    dotClassName: 'bg-gray-400',
  },
  reading: {
    label: '在读',
    title: '正在读',
    className: 'border-blue-200 bg-blue-50 text-blue-700',
    dotClassName: 'bg-blue-500',
  },
  paused: {
    label: '暂停',
    title: '暂停阅读',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
    dotClassName: 'bg-amber-500',
  },
  finished: {
    label: '已读',
    title: '已读完',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    dotClassName: 'bg-emerald-500',
  },
  abandoned: {
    label: '弃读',
    title: '已弃读',
    className: 'border-rose-200 bg-rose-50 text-rose-700',
    dotClassName: 'bg-rose-500',
  },
};

function isBookVisibleInFolder(book: Book, folderId: number | null | 'all') {
  return folderId === 'all' || book.folder_id === folderId;
}

function getBookDedupeKey(book: Pick<Book, 'id'>) {
  // The backend's content hash is authoritative. Metadata can legitimately be
  // identical (especially while queued books all have zero parsed pages).
  return String(book.id);
}

function getTranslationPercent(donePages: number, totalPages: number): number {
  if (totalPages <= 0) return 0;
  if (donePages >= totalPages) return 100;
  return Math.min(99, Math.floor((donePages / totalPages) * 100));
}

function getBookReadingStatus(book: Book): ReadingStatus {
  return book.reading_status || 'unread';
}

function getTranslationDisplay(book: Book, activeJob?: BatchStatus): TranslationDisplay {
  const totalPages = book.total_pages || activeJob?.totalPages || 0;

  if (book.import_status && ACTIVE_IMPORT_STATUSES.has(book.import_status)) {
    return {
      label: book.import_status === 'pending' ? '等待解析' : '正在解析',
      detail: book.import_stage || '后台导入中',
      percent: 0,
      translatedPages: 0,
      totalPages,
      state: 'active',
      badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
      barClass: 'bg-blue-500',
    };
  }

  if (book.import_status === 'failed') {
    return {
      label: '导入失败',
      detail: book.import_error || '书籍解析失败',
      percent: 0,
      translatedPages: 0,
      totalPages,
      state: 'failed',
      badgeClass: 'bg-red-50 text-red-700 border-red-200',
      barClass: 'bg-red-500',
    };
  }

  if (!canUseBookTextFeatures(book)) {
    return {
      label: '扫描版，只读',
      detail: '未检测到可提取文字',
      percent: 0,
      translatedPages: 0,
      totalPages,
      state: 'unavailable',
      badgeClass: 'bg-slate-100 text-slate-600 border-slate-300',
      barClass: 'bg-slate-300',
    };
  }
  const translatedPages = Math.min(
    totalPages,
    activeJob
      ? Math.max(activeJob.processedPages, book.translated_pages ?? 0)
      : book.translated_pages ?? 0
  );
  const percent = getTranslationPercent(translatedPages, totalPages);
  const detail = totalPages > 0 ? `${translatedPages}/${totalPages} 页` : '无页面';

  if (activeJob?.status === 'stopping') {
    return {
      label: '停止中...',
      detail,
      percent,
      translatedPages,
      totalPages,
      state: 'active',
      badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
      barClass: 'bg-amber-500',
    };
  }

  if (activeJob && ACTIVE_JOB_STATUSES.has(activeJob.status)) {
    return {
      label: `翻译中 ${percent}%`,
      detail,
      percent,
      translatedPages,
      totalPages,
      state: 'active',
      badgeClass: 'bg-blue-50 text-blue-700 border-blue-200',
      barClass: 'bg-blue-600',
    };
  }

  if (totalPages === 0) {
    return {
      label: '无页面',
      detail,
      percent: 0,
      translatedPages: 0,
      totalPages,
      state: 'empty',
      badgeClass: 'bg-gray-50 text-gray-500 border-gray-200',
      barClass: 'bg-gray-300',
    };
  }

  if (book.translation_status === 'failed' && translatedPages < totalPages) {
    if (translatedPages > 0) {
      const remainingPages = totalPages - translatedPages;
      return {
        label: `待重试 ${percent}%`,
        detail: `${translatedPages}/${totalPages} 页，剩余 ${remainingPages} 页可继续翻译`,
        percent,
        translatedPages,
        totalPages,
        state: 'partial',
        badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
        barClass: 'bg-amber-500',
      };
    }

    return {
      label: '翻译失败',
      detail,
      percent,
      translatedPages,
      totalPages,
      state: 'failed',
      badgeClass: 'bg-red-50 text-red-700 border-red-200',
      barClass: 'bg-red-500',
    };
  }

  if (translatedPages >= totalPages) {
    return {
      label: '已翻译',
      detail,
      percent: 100,
      translatedPages,
      totalPages,
      state: 'complete',
      badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      barClass: 'bg-emerald-500',
    };
  }

  if (translatedPages > 0) {
    return {
      label: `已译 ${percent}%`,
      detail,
      percent,
      translatedPages,
      totalPages,
      state: 'partial',
      badgeClass: 'bg-amber-50 text-amber-700 border-amber-200',
      barClass: 'bg-amber-500',
    };
  }

  return {
    label: '未翻译',
    detail,
    percent: 0,
    translatedPages,
    totalPages,
    state: 'empty',
    badgeClass: 'bg-gray-50 text-gray-600 border-gray-200',
    barClass: 'bg-gray-300',
  };
}

function getReadingGuideDisplay(book: Book): ReadingGuideDisplay {
  if (book.import_status && ACTIVE_IMPORT_STATUSES.has(book.import_status)) {
    return {
      label: '导入中',
      title: '书籍正在后台解析，完成后可生成AI摘要',
      state: 'active',
      className: 'border-blue-200 bg-blue-50 text-blue-700',
    };
  }

  if (book.import_status === 'failed') {
    return {
      label: '待重试',
      title: book.import_error || '书籍解析失败，请重试',
      state: 'failed',
      className: 'border-red-200 bg-red-50 text-red-700',
    };
  }

  if (!canUseBookTextFeatures(book)) {
    return {
      label: '仅可阅读',
      title: '扫描版 PDF 未检测到可提取文字，AI摘要不可用',
      state: 'empty',
      className: 'border-slate-200 bg-slate-100 text-slate-500',
    };
  }

  if (book.has_reading_guide || book.reading_guide_status === 'completed') {
    return {
      label: 'AI摘要',
      title: '已生成AI摘要',
      state: 'complete',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    };
  }

  if (book.reading_guide_status === 'generating' || book.reading_guide_status === 'pending') {
    return {
      label: '摘要中',
      title: 'AI摘要正在生成',
      state: 'active',
      className: 'border-blue-200 bg-blue-50 text-blue-700',
    };
  }

  if (book.reading_guide_status === 'failed') {
    return {
      label: '摘要失败',
      title: 'AI摘要生成失败，打开后可重试',
      state: 'failed',
      className: 'border-red-200 bg-red-50 text-red-700',
    };
  }

  if (book.reading_guide_status === 'cancelled') {
    return {
      label: '未摘要',
      title: 'AI摘要已取消，可重新生成',
      state: 'empty',
      className: 'border-gray-200 bg-gray-50 text-gray-500',
    };
  }

  return {
    label: '未摘要',
    title: '还没有AI摘要',
    state: 'empty',
    className: 'border-gray-200 bg-gray-50 text-gray-500',
  };
}

function applyReadingGuideToBook(book: Book, guide: ReadingGuide | null): Book {
  const readingGuideStatus = guide?.status ?? null;
  const hasReadingGuide = guide?.status === 'completed' && guide.guide_text ? 1 : 0;

  if (
    book.reading_guide_status === readingGuideStatus &&
    (book.has_reading_guide || 0) === hasReadingGuide
  ) {
    return book;
  }

  return {
    ...book,
    reading_guide_status: readingGuideStatus,
    has_reading_guide: hasReadingGuide,
  };
}

function isReadingGuideActive(book: Book): boolean {
  return book.reading_guide_status === 'pending' || book.reading_guide_status === 'generating';
}

function canStartReadingGuide(book: Book): boolean {
  return canUseBookTextFeatures(book)
    && !book.has_reading_guide
    && book.reading_guide_status !== 'completed'
    && !isReadingGuideActive(book);
}

export default function BookList() {
  const [books, setBooks] = useState<Book[]>([]);
  const [uploading, setUploading] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [deleteConfirmLoading, setDeleteConfirmLoading] = useState(false);
  const [batchStatus, setBatchStatus] = useState<Record<number, BatchStatus>>({});
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [moveMenuOpenId, setMoveMenuOpenId] = useState<number | null>(null);
  const [statusMenuOpenId, setStatusMenuOpenId] = useState<number | null>(null);
  const [contextMenuId, setContextMenuId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortKey>('upload_time');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [filterType, setFilterType] = useState<'all' | 'pdf' | 'epub'>('all');
  const [filterStatus, setFilterStatus] = useState<ReadingStatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [readingGuideBook, setReadingGuideBook] = useState<Book | null>(null);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedBookIds, setSelectedBookIds] = useState<Set<number>>(new Set());
  const [isBatchSummaryStarting, setIsBatchSummaryStarting] = useState(false);
  const [isBatchSummaryCancelling, setIsBatchSummaryCancelling] = useState(false);
  const { setCurrentBook } = useBookStore();
  const {
    folders,
    selectedFolderId,
    setFolders,
    setUncategorizedCount,
    addFolder,
    incrementFolderCount,
    decrementFolderCount,
  } = useFolderStore();
  const { addToast } = useToast();

  // Track active polling intervals for cleanup
  const pollIntervalsRef = useRef<Map<number, ReturnType<typeof setInterval>>>(new Map());

  const loadFolders = useCallback(async () => {
    try {
      const response = await folderApi.getAll();
      setFolders(response.data.data.folders);
      setUncategorizedCount(response.data.data.uncategorizedCount);
    } catch (error) {
      console.error('Failed to load folders:', error);
    }
  }, [setFolders, setUncategorizedCount]);

  const loadBooks = useCallback(async (folderId: number | null | 'all') => {
    try {
      const response = await bookApi.getAllBooks(folderId);
      setBooks(response.data.data);
    } catch (error) {
      console.error('Failed to load books:', error);
    }
  }, []);

  const mergeBookIntoVisibleList = useCallback((book: Book) => {
    const visibleFolderId = useFolderStore.getState().selectedFolderId;
    if (!isBookVisibleInFolder(book, visibleFolderId)) return;
    const dedupeKey = getBookDedupeKey(book);

    setBooks(prev => [
      book,
      ...prev.filter(existing => existing.id !== book.id && getBookDedupeKey(existing) !== dedupeKey),
    ]);
  }, []);

  const updateBookReadingGuide = useCallback((bookId: number, guide: ReadingGuide | null) => {
    setBooks(prev => {
      let changed = false;
      const nextBooks = prev.map(book => {
        if (book.id !== bookId) return book;
        const nextBook = applyReadingGuideToBook(book, guide);
        if (nextBook !== book) changed = true;
        return nextBook;
      });
      return changed ? nextBooks : prev;
    });

    setReadingGuideBook(prev => {
      if (!prev || prev.id !== bookId) return prev;
      return applyReadingGuideToBook(prev, guide);
    });
  }, []);

  const handleOpenBook = useCallback(async (book: Book) => {
    if (batchStatus[book.id]) return;
    if (book.import_status && ACTIVE_IMPORT_STATUSES.has(book.import_status)) {
      addToast('书籍正在后台解析，完成后即可打开', 'info');
      return;
    }
    if (book.import_status === 'failed') {
      addToast(book.import_error || '书籍解析失败，请从更多操作中重试', 'error');
      return;
    }

    try {
      const response = await bookApi.getBook(book.id);
      setCurrentBook(response.data.data);
    } catch (error) {
      console.error('Failed to refresh book before opening:', error);
      setCurrentBook(book);
    }
  }, [addToast, batchStatus, setCurrentBook]);

  const toggleBookSelection = useCallback((bookId: number) => {
    setSelectedBookIds(prev => {
      const next = new Set(prev);
      if (next.has(bookId)) {
        next.delete(bookId);
      } else {
        next.add(bookId);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedBookIds(new Set());
    setIsSelectionMode(false);
  }, []);

  // Cleanup all polling intervals on unmount
  useEffect(() => {
    const pollIntervals = pollIntervalsRef.current;
    return () => {
      pollIntervals.forEach(interval => clearInterval(interval));
      pollIntervals.clear();
    };
  }, []);

  // Load folders on mount
  useEffect(() => {
    loadFolders();
  }, [loadFolders]);

  // Load books when selected folder changes
  useEffect(() => {
    loadBooks(selectedFolderId);
  }, [loadBooks, selectedFolderId]);

  useEffect(() => {
    const activeBooks = books.filter(
      book => book.import_status && ACTIVE_IMPORT_STATUSES.has(book.import_status)
    );
    if (activeBooks.length === 0) return;

    let cancelled = false;
    const refreshImports = async () => {
      const updates = await Promise.all(activeBooks.map(async (book) => {
        try {
          const response = await bookApi.getImportStatus(book.id);
          return { previous: book, current: response.data.data as Book };
        } catch (error) {
          console.error(`Failed to refresh import status for book ${book.id}:`, error);
          return null;
        }
      }));
      if (cancelled) return;

      const validUpdates = updates.filter((update): update is NonNullable<typeof update> => Boolean(update));
      setBooks(previousBooks => {
        let changed = false;
        const nextBooks = previousBooks.map(book => {
          const update = validUpdates.find(item => item.current.id === book.id);
          if (!update) return book;
          if (
            book.import_status === update.current.import_status
            && book.import_stage === update.current.import_stage
            && book.import_error === update.current.import_error
          ) {
            return book;
          }
          changed = true;
          return update.current;
        });
        return changed ? nextBooks : previousBooks;
      });

      for (const update of validUpdates) {
        if (update.current.import_status === 'ready') {
          addToast(`《${update.current.original_name}》解析完成`, 'success');
        } else if (update.current.import_status === 'failed') {
          addToast(
            `《${update.current.original_name}》解析失败：${update.current.import_error || '未知错误'}`,
            'error',
          );
        }
      }
    };

    void refreshImports();
    const interval = setInterval(() => void refreshImports(), 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [addToast, books]);

  useEffect(() => {
    const activeBookIds = books
      .filter(isReadingGuideActive)
      .map(book => book.id);

    if (activeBookIds.length === 0) return;

    let cancelled = false;

    const refreshReadingGuides = async () => {
      const updates = await Promise.all(activeBookIds.map(async (bookId) => {
        try {
          const response = await readingGuideApi.get(bookId);
          return { bookId, guide: response.data.data };
        } catch (error) {
          console.error(`Failed to refresh AI summary status for book ${bookId}:`, error);
          return null;
        }
      }));

      if (cancelled) return;

      setBooks(prev => {
        let changed = false;
        const nextBooks = prev.map(book => {
          const update = updates.find(item => item?.bookId === book.id);
          if (!update) return book;

          const nextBook = applyReadingGuideToBook(book, update.guide);
          if (nextBook !== book) changed = true;
          return nextBook;
        });
        return changed ? nextBooks : prev;
      });

      setReadingGuideBook(prev => {
        if (!prev) return prev;
        const update = updates.find(item => item?.bookId === prev.id);
        return update ? applyReadingGuideToBook(prev, update.guide) : prev;
      });
    };

    const interval = setInterval(() => {
      void refreshReadingGuides();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [books]);

  // Close transient overlays without rendering a full-screen click blocker.
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (
        target?.closest('.book-context-menu') ||
        target?.closest('.book-context-trigger')
      ) {
        return;
      }

      setContextMenuId(null);
      setMoveMenuOpenId(null);
      setStatusMenuOpenId(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      setContextMenuId(null);
      setMoveMenuOpenId(null);
      setStatusMenuOpenId(null);
      setShowCreateFolder(false);
      if (!deleteConfirmLoading) {
        setDeleteConfirmId(null);
      }
    };

    if (contextMenuId !== null || moveMenuOpenId !== null || statusMenuOpenId !== null) {
      document.addEventListener('mousedown', handlePointerDown);
    }
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenuId, moveMenuOpenId, statusMenuOpenId, deleteConfirmLoading]);

  const formatJobProgress = (
    job: { status: string; processed_pages?: number; total_pages?: number },
    bookSnapshot?: Book
  ) => {
    const totalPages = bookSnapshot?.total_pages || job.total_pages || 0;
    const processedPages = Math.min(
      totalPages,
      Math.max(job.processed_pages || 0, bookSnapshot?.translated_pages || 0)
    );
    const percent = getTranslationPercent(processedPages, totalPages);
    return {
      status: job.status,
      progress: `${percent}% (${processedPages}/${totalPages})`,
      processedPages,
      totalPages,
    };
  };

  const clearBatchStatus = useCallback((bookId: number) => {
    setBatchStatus(prev => {
      const newState = { ...prev };
      delete newState[bookId];
      return newState;
    });
  }, []);

  const handleMoveBook = async (bookId: number, targetFolderId: number | null) => {
    const book = books.find(b => b.id === bookId);
    if (!book) return;

    const previousFolderId = book.folder_id;

    try {
      await bookApi.moveToFolder(bookId, targetFolderId);

      // Update local state
      setBooks(prev => prev.map(b =>
        b.id === bookId
          ? {
              ...b,
              folder_id: targetFolderId,
              folder_name: targetFolderId ? folders.find(f => f.id === targetFolderId)?.name : undefined,
              folder_color: targetFolderId ? folders.find(f => f.id === targetFolderId)?.color : undefined,
            }
          : b
      ));

      // Update folder counts
      if (previousFolderId !== null) {
        decrementFolderCount(previousFolderId);
      } else {
        setUncategorizedCount(prev => Math.max(0, prev - 1));
      }

      if (targetFolderId !== null) {
        incrementFolderCount(targetFolderId);
      } else {
        setUncategorizedCount(prev => prev + 1);
      }

      addToast('书籍已移动', 'success');
      setMoveMenuOpenId(null);
      setStatusMenuOpenId(null);

      // If we're viewing a specific folder and moved out of it, reload
      if (selectedFolderId !== 'all' && previousFolderId === selectedFolderId) {
        loadBooks(selectedFolderId);
      }
    } catch (error: unknown) {
      addToast(getApiErrorMessage(error, '移动失败'), 'error');
    }
  };

  const startBatchTranslation = async (bookId: number) => {
    const book = books.find(b => b.id === bookId);

    if (book && !canUseBookTextFeatures(book)) {
      addToast('扫描版 PDF 未检测到可提取文字，仅支持原版阅读', 'info');
      return;
    }

    try {
      setBatchStatus(prev => ({
        ...prev,
        [bookId]: formatJobProgress({
          status: 'processing',
          processed_pages: book?.translated_pages || 0,
          total_pages: book?.total_pages || 0,
        }, book),
      }));
      const response = await translationApi.startBatchJob(bookId);
      setBatchStatus(prev => ({
        ...prev,
        [bookId]: formatJobProgress(response.data.data, book),
      }));
      addToast('后台翻译任务已启动', 'info');
      pollBatchStatus(bookId, { showToast: true });
    } catch (error: unknown) {
      console.error('Failed to start batch translation:', error);
      addToast(`启动翻译失败: ${getErrorMessage(error)}`, 'error');
      clearBatchStatus(bookId);
    }
  };

  const stopBatchTranslation = async (bookId: number) => {
    const previousStatus = batchStatus[bookId];

    try {
      setBatchStatus(prev => {
        const currentStatus = prev[bookId] || previousStatus;
        return {
          ...prev,
          [bookId]: {
            status: 'stopping',
            progress: '停止中...',
            processedPages: currentStatus?.processedPages || 0,
            totalPages: currentStatus?.totalPages || 0,
          },
        };
      });
      await translationApi.stopJob(bookId);
      pollBatchStatus(bookId, { showToast: true });
    } catch (error: unknown) {
      console.error('Failed to stop batch translation:', error);
      addToast(`停止翻译失败: ${getErrorMessage(error)}`, 'error');
      if (previousStatus) {
        setBatchStatus(prev => ({ ...prev, [bookId]: previousStatus }));
      } else {
        clearBatchStatus(bookId);
      }
    }
  };

  const pollBatchStatus = useCallback((bookId: number, options: { showToast?: boolean } = {}) => {
    // Clear existing interval for this book if any
    const existing = pollIntervalsRef.current.get(bookId);
    if (existing) clearInterval(existing);

    const fetchStatus = async () => {
      const response = await translationApi.getJobStatus(bookId);
      const job = response.data.data;

      if (!job) {
        clearBatchStatus(bookId);
        return false;
      }

      if (ACTIVE_JOB_STATUSES.has(job.status)) {
        setBatchStatus(prev => ({
          ...prev,
          [bookId]: formatJobProgress(job),
        }));
        return true;
      }

      if (job.status === 'completed') {
        if (options.showToast) {
          addToast('书籍翻译完成！', 'success');
        }
        await loadBooks(useFolderStore.getState().selectedFolderId);
      } else if (job.status === 'failed' || job.status === 'stopped') {
        await loadBooks(useFolderStore.getState().selectedFolderId);
        if (options.showToast) {
          if (job.status === 'failed') {
            addToast(job.error_message || '部分页面翻译失败，可继续翻译剩余页面', 'warning');
          } else {
            addToast('翻译已停止', 'info');
          }
        }
      }

      clearBatchStatus(bookId);
      return false;
    };

    const pollInterval = setInterval(async () => {
      try {
        const shouldContinue = await fetchStatus();
        if (!shouldContinue) {
          clearInterval(pollInterval);
          pollIntervalsRef.current.delete(bookId);
        }
      } catch (error) {
        console.error('Polling error:', error);
        clearInterval(pollInterval);
        pollIntervalsRef.current.delete(bookId);
      }
    }, 2000);

    pollIntervalsRef.current.set(bookId, pollInterval);
    void fetchStatus().catch((error) => {
      console.error('Initial polling error:', error);
    });
  }, [addToast, clearBatchStatus, loadBooks]);

  // Restore active background translation progress after refresh.
  useEffect(() => {
    if (books.length === 0) return;

    let cancelled = false;

    const restoreActiveJobs = async () => {
      await Promise.all(books.map(async (book) => {
        try {
          const response = await translationApi.getJobStatus(book.id);
          if (cancelled) return;

          const job = response.data.data;
          if (job && ACTIVE_JOB_STATUSES.has(job.status)) {
            setBatchStatus(prev => ({
              ...prev,
              [book.id]: formatJobProgress(job, book),
            }));
            pollBatchStatus(book.id);
          }
        } catch (error) {
          console.error(`Failed to restore translation status for book ${book.id}:`, error);
        }
      }));
    };

    void restoreActiveJobs();

    return () => {
      cancelled = true;
    };
  }, [books, pollBatchStatus]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    // Client-side validation
    const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200MB
    const ALLOWED_EXTENSIONS = ['.epub', '.pdf'];

    for (const file of Array.from(files)) {
      const ext = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        addToast(`不支持的文件格式: ${file.name}，仅支持 EPUB、PDF`, 'error');
        e.target.value = '';
        return;
      }
      if (file.size > MAX_FILE_SIZE) {
        addToast(`文件过大: ${file.name}（${(file.size / 1024 / 1024).toFixed(1)}MB），最大支持 200MB`, 'error');
        e.target.value = '';
        return;
      }
    }

    try {
      setUploading(true);
      let successCount = 0;
      let duplicateCount = 0;
      let failCount = 0;
      const failedUploads: string[] = [];

      for (const file of Array.from(files)) {
        try {
          const targetFolderId = typeof selectedFolderId === 'number' ? selectedFolderId : null;
          const response = await bookApi.uploadBook(file, targetFolderId);
          const newBook = response.data.data as UploadBookResponse;

          if (newBook?.duplicate) {
            duplicateCount++;
            if (newBook.id) {
              try {
                const bookResponse = await bookApi.getBook(newBook.id);
                mergeBookIntoVisibleList(bookResponse.data.data as Book);
              } catch (error) {
                console.error(`获取已有书籍详情失败: ${file.name}`, error);
              }
            }
            continue;
          }

          successCount++;

          if (targetFolderId !== null) {
            incrementFolderCount(targetFolderId);
          } else {
            setUncategorizedCount(prev => prev + 1);
          }

          if (newBook?.id) {
            try {
              const bookResponse = await bookApi.getBook(newBook.id);
              const uploadedBook = bookResponse.data.data as Book;
              mergeBookIntoVisibleList(uploadedBook);
            } catch (error) {
              console.error(`获取新书详情失败: ${file.name}`, error);
            }
          }
        } catch (error: unknown) {
          failCount++;
          failedUploads.push(`${file.name}：${getApiErrorMessage(error, '上传失败')}`);
          console.error(`上传失败: ${file.name}`, error);
        }
      }

      await loadBooks(useFolderStore.getState().selectedFolderId);
      await loadFolders();
      e.target.value = '';

      if (failCount === 0 && duplicateCount === 0) {
        addToast(`已接收 ${successCount} 本书籍，正在后台解析`, 'success');
      } else {
        addToast(
          `上传完成：${successCount} 本进入解析，${duplicateCount} 本已存在，${failCount} 本上传失败`,
          failCount > 0 ? 'error' : duplicateCount > 0 ? 'info' : 'success'
        );
      }
      if (failedUploads.length > 0) {
        addToast(failedUploads.slice(0, 3).join('；'), 'error');
      }

    } catch (error: unknown) {
      addToast(`上传失败: ${getErrorMessage(error)}`, 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleRetryImport = async (bookId: number) => {
    try {
      await bookApi.retryImport(bookId);
      setBooks(previous => previous.map(book => (
        book.id === bookId
          ? { ...book, import_status: 'pending', import_stage: 'queued', import_error: null }
          : book
      )));
      setContextMenuId(null);
      addToast('已重新排队解析', 'info');
    } catch (error: unknown) {
      addToast(getApiErrorMessage(error, '重新解析失败'), 'error');
    }
  };

  const handleDeleteClick = (id: number) => {
    setDeleteConfirmId(id);
  };

  const handleDeleteConfirm = async () => {
    if (deleteConfirmId === null) return;

    const book = books.find(b => b.id === deleteConfirmId);

    try {
      setDeleteConfirmLoading(true);
      await bookApi.deleteBook(deleteConfirmId);
      await loadBooks(useFolderStore.getState().selectedFolderId);

      // Update folder count
      if (book?.folder_id) {
        decrementFolderCount(book.folder_id);
      } else {
        setUncategorizedCount(prev => Math.max(0, prev - 1));
      }

      addToast('书籍已删除', 'success');
      setDeleteConfirmId(null);
    } catch (error: unknown) {
      addToast(getApiErrorMessage(error, '删除失败'), 'error');
    } finally {
      setDeleteConfirmLoading(false);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteConfirmId(null);
  };

  const getBookName = () => {
    if (deleteConfirmId === null) return '';
    const book = books.find(b => b.id === deleteConfirmId);
    return book?.original_name || '这本书';
  };

  const getViewTitle = () => {
    if (selectedFolderId === 'all') return '全部书籍';
    if (selectedFolderId === null) return '未分类';
    return folders.find(f => f.id === selectedFolderId)?.name || '文件夹';
  };

  const handleTogglePin = async (bookId: number, currentPinned: number | undefined) => {
    const newPinned = !currentPinned;
    try {
      await bookApi.togglePin(bookId, newPinned);
      setBooks(prev => prev.map(b =>
        b.id === bookId ? { ...b, is_pinned: newPinned ? 1 : 0 } : b
      ));
      addToast(newPinned ? '已置顶' : '已取消置顶', 'success');
    } catch {
      addToast('操作失败', 'error');
    }
  };

  const handleUpdateReadingStatus = async (bookId: number, status: ReadingStatus) => {
    try {
      const response = await bookApi.updateReadingStatus(bookId, status);
      const updatedBook = response.data.data as Book | null;
      const readingStatus = updatedBook?.reading_status || status;

      setBooks(prev => prev.map(b =>
        b.id === bookId ? { ...b, reading_status: readingStatus } : b
      ));
      setReadingGuideBook(prev =>
        prev?.id === bookId ? { ...prev, reading_status: readingStatus } : prev
      );
      addToast(`已标记为${READING_STATUS_DISPLAY[readingStatus].label}`, 'success');
    } catch (error: unknown) {
      addToast(getApiErrorMessage(error, '标记失败'), 'error');
    }
  };

  const displayedBooks = useMemo(() => {
    const uniqueBooks = new Map<string, Book>();
    for (const book of books) {
      const dedupeKey = getBookDedupeKey(book);
      if (!uniqueBooks.has(dedupeKey)) {
        uniqueBooks.set(dedupeKey, book);
      }
    }

    let filtered = [...uniqueBooks.values()];

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(b => b.original_name.toLowerCase().includes(q));
    }

    // Type filter
    if (filterType !== 'all') {
      filtered = filtered.filter(b => b.file_type === filterType);
    }

    // Reading status filter
    if (filterStatus !== 'all') {
      filtered = filtered.filter(b => getBookReadingStatus(b) === filterStatus);
    }

    // Sort (pinned always first)
    filtered.sort((a, b) => {
      const pinA = a.is_pinned || 0;
      const pinB = b.is_pinned || 0;
      if (pinA !== pinB) return pinB - pinA;

      let cmp = 0;
      if (sortBy === 'upload_time') {
        cmp = (a.upload_time || '').localeCompare(b.upload_time || '');
      } else if (sortBy === 'name') {
        cmp = (a.original_name || '').localeCompare(b.original_name || '');
      } else if (sortBy === 'progress') {
        const progA = a.total_pages > 0 ? (a.last_read_page || 1) / a.total_pages : 0;
        const progB = b.total_pages > 0 ? (b.last_read_page || 1) / b.total_pages : 0;
        cmp = progA - progB;
      } else if (sortBy === 'size') {
        cmp = (a.file_size || 0) - (b.file_size || 0);
      }

      return sortOrder === 'asc' ? cmp : -cmp;
    });

    return filtered;
  }, [books, searchQuery, filterType, filterStatus, sortBy, sortOrder]);

  const selectedBooks = useMemo(
    () => books.filter(book => selectedBookIds.has(book.id)),
    [books, selectedBookIds]
  );
  const selectedStartableSummaryCount = selectedBooks.filter(canStartReadingGuide).length;
  const selectedActiveSummaryCount = selectedBooks.filter(isReadingGuideActive).length;

  const selectDisplayedBooks = useCallback(() => {
    if (displayedBooks.length === 0) {
      addToast('当前没有可选择的书籍', 'info');
      return;
    }

    setIsSelectionMode(true);
    setSelectedBookIds(new Set(displayedBooks.map(book => book.id)));
  }, [addToast, displayedBooks]);

  const selectUnsummarizedBooks = useCallback(() => {
    const targetBooks = displayedBooks.filter(canStartReadingGuide);
    if (targetBooks.length === 0) {
      addToast('当前筛选结果里没有未摘要的书籍', 'info');
      return;
    }

    setIsSelectionMode(true);
    setSelectedBookIds(new Set(targetBooks.map(book => book.id)));
  }, [addToast, displayedBooks]);

  const startSelectedReadingGuides = useCallback(async () => {
    const targetBooks = selectedBooks.filter(canStartReadingGuide);
    if (targetBooks.length === 0) {
      addToast('所选书籍都已有摘要或正在摘要', 'info');
      return;
    }

    try {
      setIsBatchSummaryStarting(true);
      const results = await Promise.all(targetBooks.map(async (book) => {
        try {
          const response = await readingGuideApi.generate(book.id, false);
          updateBookReadingGuide(book.id, response.data.data);
          return { bookId: book.id, ok: true };
        } catch (error) {
          console.error(`Failed to start AI summary for book ${book.id}:`, error);
          return { bookId: book.id, ok: false };
        }
      }));

      const failedIds = results.filter(result => !result.ok).map(result => result.bookId);
      const successCount = results.length - failedIds.length;
      if (successCount > 0) {
        addToast(`已为 ${successCount} 本书启动AI摘要`, 'success');
      }
      if (failedIds.length > 0) {
        addToast(`${failedIds.length} 本书启动AI摘要失败`, 'error');
      }

      const failedIdSet = new Set(failedIds);
      setSelectedBookIds(failedIdSet);
      if (failedIdSet.size === 0) {
        setIsSelectionMode(false);
      }
    } finally {
      setIsBatchSummaryStarting(false);
    }
  }, [addToast, selectedBooks, updateBookReadingGuide]);

  const cancelSelectedReadingGuides = useCallback(async () => {
    const targetBooks = selectedBooks.filter(isReadingGuideActive);
    if (targetBooks.length === 0) {
      addToast('所选书籍没有正在生成的AI摘要', 'info');
      return;
    }

    try {
      setIsBatchSummaryCancelling(true);
      const results = await Promise.all(targetBooks.map(async (book) => {
        try {
          const response = await readingGuideApi.cancel(book.id);
          updateBookReadingGuide(book.id, response.data.data);
          return { bookId: book.id, ok: true };
        } catch (error) {
          console.error(`Failed to cancel AI summary for book ${book.id}:`, error);
          return { bookId: book.id, ok: false };
        }
      }));

      const failedIds = results.filter(result => !result.ok).map(result => result.bookId);
      const successCount = results.length - failedIds.length;
      if (successCount > 0) {
        addToast(`已取消 ${successCount} 本书的AI摘要`, 'success');
      }
      if (failedIds.length > 0) {
        addToast(`${failedIds.length} 本书取消AI摘要失败`, 'error');
      }

      const failedIdSet = new Set(failedIds);
      setSelectedBookIds(failedIdSet);
      if (failedIdSet.size === 0) {
        setIsSelectionMode(false);
      }
    } finally {
      setIsBatchSummaryCancelling(false);
    }
  }, [addToast, selectedBooks, updateBookReadingGuide]);

  return (
    <div className="flex h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      {/* Folder Sidebar */}
      <FolderSidebar onCreateFolder={() => setShowCreateFolder(true)} />

      {/* Main Content */}
      <div className="flex-1 overflow-auto py-8 px-6">
        <div className="max-w-7xl mx-auto">
          {/* Header Section */}
          <div className="mb-8">
            <div className="flex items-center justify-between flex-col sm:flex-row gap-4">
              <h1 className="text-3xl font-bold text-gray-900">
                {getViewTitle()}
              </h1>
              <label className="flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white rounded-xl hover:shadow-lg hover:shadow-blue-500/30 cursor-pointer transition-all transform hover:scale-105 font-semibold whitespace-nowrap">
                <Upload size={18} />
                <span>{uploading ? '上传中...' : '上传书籍'}</span>
                <input
                  type="file"
                  accept=".epub,.pdf,application/epub+zip,application/pdf"
                  multiple
                  onChange={handleFileUpload}
                  disabled={uploading}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          {/* Toolbar: Search + Filters + Sort */}
          <div className="mb-6 flex flex-wrap items-center gap-3">
            {/* Search */}
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="搜索书名..."
                className="pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 w-44"
              />
            </div>

            {/* Type filter */}
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
              {(['all', 'pdf', 'epub'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setFilterType(t)}
                  className={`px-3 py-1.5 transition-colors ${
                    filterType === t
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {t === 'all' ? '全部' : t.toUpperCase()}
                </button>
              ))}
            </div>

            {/* Reading status filter */}
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
              {([
                { key: 'all', label: '全部' },
                ...READING_STATUS_OPTIONS.map(status => ({
                  key: status,
                  label: READING_STATUS_DISPLAY[status].label,
                })),
              ] as Array<{ key: ReadingStatusFilter; label: string }>).map(s => (
                <button
                  key={s.key}
                  onClick={() => setFilterStatus(s.key)}
                  className={`px-3 py-1.5 transition-colors ${
                    filterStatus === s.key
                      ? 'bg-blue-600 text-white'
                      : 'bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            {/* Batch AI summary controls */}
            {isSelectionMode ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/70 px-2 py-1">
                <span className="px-1 text-xs font-semibold text-blue-700">
                  已选 {selectedBookIds.size} 本
                </span>
                <button
                  onClick={selectDisplayedBooks}
                  disabled={isBatchSummaryStarting || isBatchSummaryCancelling}
                  className="rounded-md border border-blue-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  全选当前
                </button>
                <button
                  onClick={selectUnsummarizedBooks}
                  disabled={isBatchSummaryStarting || isBatchSummaryCancelling}
                  className="rounded-md border border-blue-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-blue-700 transition-colors hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  只选未摘要
                </button>
                <button
                  onClick={startSelectedReadingGuides}
                  disabled={selectedStartableSummaryCount === 0 || isBatchSummaryStarting || isBatchSummaryCancelling}
                  className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isBatchSummaryStarting ? <Loader size={13} className="animate-spin" /> : <CheckSquare2 size={13} />}
                  生成AI摘要{selectedStartableSummaryCount > 0 ? ` ${selectedStartableSummaryCount}` : ''}
                </button>
                <button
                  onClick={cancelSelectedReadingGuides}
                  disabled={selectedActiveSummaryCount === 0 || isBatchSummaryStarting || isBatchSummaryCancelling}
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isBatchSummaryCancelling ? <Loader size={13} className="animate-spin" /> : <Square size={13} />}
                  取消AI摘要{selectedActiveSummaryCount > 0 ? ` ${selectedActiveSummaryCount}` : ''}
                </button>
                <button
                  onClick={clearSelection}
                  disabled={isBatchSummaryStarting || isBatchSummaryCancelling}
                  className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  取消选择
                </button>
              </div>
            ) : (
              <button
                onClick={() => setIsSelectionMode(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-50"
              >
                <CheckSquare2 size={14} />
                批量AI摘要
              </button>
            )}

            {/* Sort */}
            <div className="flex items-center gap-1 ml-auto">
              <select
                value={sortBy}
                onChange={e => setSortBy(e.target.value as SortKey)}
                className="text-sm border border-gray-200 rounded-lg bg-white px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              >
                <option value="upload_time">上传时间</option>
                <option value="name">名称</option>
                <option value="progress">进度</option>
                <option value="size">大小</option>
              </select>
              <button
                onClick={() => setSortOrder(o => o === 'asc' ? 'desc' : 'asc')}
                className="p-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
                title={sortOrder === 'asc' ? '升序' : '降序'}
              >
                {sortOrder === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
              </button>
            </div>
          </div>

          {/* Books Grid - Apple Books style */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-8">
            {displayedBooks.map((book) => {
              const readPercent = book.total_pages > 0
                ? Math.round((book.last_read_page / book.total_pages) * 100)
                : 0;
              const activeJob = batchStatus[book.id];
              const translationDisplay = getTranslationDisplay(book, activeJob);
              const readingGuideDisplay = getReadingGuideDisplay(book);
              const readingStatus = getBookReadingStatus(book);
              const readingStatusDisplay = READING_STATUS_DISPLAY[readingStatus];
              const isSelected = selectedBookIds.has(book.id);
              const textFeaturesAvailable = canUseBookTextFeatures(book);
              const importActive = Boolean(book.import_status && ACTIVE_IMPORT_STATUSES.has(book.import_status));
              const importFailed = book.import_status === 'failed';
              const coverAspectClass = book.file_type === 'pdf' ? 'aspect-[17/22]' : 'aspect-[2/3]';

              return (
                <div key={book.id} className="group">
                  {/* Book Cover with 3D effect */}
                  <div
                    className={`relative book-cover-3d ${importActive || importFailed ? 'cursor-default' : 'cursor-pointer'}`}
                    onClick={() => {
                      if (isSelectionMode) {
                        toggleBookSelection(book.id);
                        return;
                      }
                      void handleOpenBook(book);
                    }}
                  >
                    {/* Book spine (left edge thickness) */}
                    <div className="book-spine" />

                    {/* Main cover face */}
                    <div className={`book-face ${coverAspectClass} overflow-hidden relative transition-shadow ${
                      isSelected ? 'ring-2 ring-blue-500 ring-offset-2 ring-offset-gray-50' : ''
                    }`}>
                      {book.cover_image_path ? (
                        <img
                          src={`${BACKEND_BASE_URL}${book.cover_image_path}`}
                          alt={book.original_name}
                          className="h-full w-full bg-white object-contain"
                        />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-gray-700 to-gray-900 flex flex-col items-center justify-center gap-3 p-4">
                          <BookOpen size={32} className="text-gray-400" />
                          <span className="text-gray-300 text-xs font-medium text-center leading-tight line-clamp-3">
                            {book.original_name}
                          </span>
                          <span className="text-gray-500 text-[10px] font-medium uppercase">{book.file_type}</span>
                        </div>
                      )}

                      {/* Page edges - visible on right side */}
                      <div className="book-page-edges" />

                      {/* Pin badge */}
                      {!!book.is_pinned && (
                        <div className="absolute top-1.5 right-1.5 bg-amber-500 text-white rounded-full p-1 shadow-md z-10">
                          <Pin size={10} />
                        </div>
                      )}

                      {book.import_status !== 'pending'
                        && book.import_status !== 'processing'
                        && book.import_status !== 'failed'
                        && book.file_type === 'pdf'
                        && book.text_extraction_status !== 'ready' && (
                        <div
                          className={`absolute bottom-2 left-2 z-10 rounded-full border px-2 py-0.5 text-[10px] font-semibold shadow-sm ${
                            book.text_extraction_status === 'unavailable'
                              ? 'border-slate-300 bg-slate-800/90 text-white'
                              : 'border-amber-200 bg-amber-50/95 text-amber-700'
                          }`}
                          title={book.text_extraction_status === 'unavailable'
                            ? '未检测到可提取文字，扫描版仅可阅读'
                            : '部分页面无文字，文本功能会跳过这些页面'}
                        >
                          {book.text_extraction_status === 'unavailable' ? '扫描版 · 只读' : '部分页无文字'}
                        </div>
                      )}

                      {/* Reading status badge */}
                      {readingStatus !== 'unread' && !isSelectionMode && (
                        <div
                          className={`absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold shadow-sm ${readingStatusDisplay.className}`}
                          title={readingStatusDisplay.title}
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${readingStatusDisplay.dotClassName}`} />
                          {readingStatusDisplay.label}
                        </div>
                      )}

                      {/* Selection badge */}
                      {isSelectionMode && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleBookSelection(book.id);
                          }}
                          className={`absolute left-2 top-2 z-20 rounded-full border p-1.5 shadow-md transition-colors ${
                            isSelected
                              ? 'border-blue-500 bg-blue-600 text-white'
                              : 'border-white/80 bg-white/90 text-gray-500 hover:text-blue-600'
                          }`}
                          title={isSelected ? '取消选择' : '选择书籍'}
                        >
                          {isSelected ? <CheckCircle2 size={15} /> : <Circle size={15} />}
                        </button>
                      )}

                      {/* Cover surface gloss */}
                      <div className="absolute inset-0 pointer-events-none book-cover-gloss" />

                      {importActive && (
                        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/65 px-3 text-white">
                          <div className="text-center">
                            <Loader size={26} className="mx-auto mb-2 animate-spin" />
                            <div className="text-xs font-semibold">
                              {book.import_status === 'pending' ? '等待解析' : '正在解析'}
                            </div>
                            <div className="mt-1 text-[10px] text-slate-200">可离开此页面，任务会在后台继续</div>
                          </div>
                        </div>
                      )}

                      {importFailed && (
                        <div
                          className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-red-950/70 px-3 text-white"
                          title={book.import_error || '书籍解析失败'}
                        >
                          <div className="text-center">
                            <AlertCircle size={26} className="mx-auto mb-2" />
                            <div className="text-xs font-semibold">解析失败</div>
                            <div className="mt-1 line-clamp-3 text-[10px] text-red-100">
                              {book.import_error || '请从更多操作中重试'}
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Batch progress overlay */}
                      {!importActive && !importFailed && batchStatus[book.id] && (
                        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                          <div className="text-center text-white">
                            <Loader size={24} className="animate-spin mx-auto mb-2" />
                            <span className="text-xs font-medium">{batchStatus[book.id].progress}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Minimal info bar below the book */}
                  <div className="mt-2 px-0.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <div
                        className={`inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold ${translationDisplay.badgeClass}`}
                        title={`翻译进度：${translationDisplay.detail}`}
                      >
                        {translationDisplay.state === 'active' ? (
                          <Loader size={12} className="animate-spin shrink-0" />
                        ) : translationDisplay.state === 'complete' ? (
                          <CheckCircle2 size={12} className="shrink-0" />
                        ) : translationDisplay.state === 'failed' ? (
                          <AlertCircle size={12} className="shrink-0" />
                        ) : (
                          <Circle size={10} className="shrink-0" />
                        )}
                        <span className="truncate">{translationDisplay.label}</span>
                      </div>

                      {/* Context menu trigger */}
                      {!isSelectionMode && (
                      <div className="relative shrink-0">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setContextMenuId(contextMenuId === book.id ? null : book.id);
                            setMoveMenuOpenId(null);
                            setStatusMenuOpenId(null);
                          }}
                          className="book-context-trigger text-gray-400 hover:text-gray-600 p-1 rounded-full hover:bg-gray-200/60 transition-colors"
                          title="更多操作"
                        >
                          <MoreHorizontal size={16} />
                        </button>

                        {/* Context menu dropdown */}
                        {contextMenuId === book.id && (
                          <div className="book-context-menu absolute right-0 bottom-full mb-1 w-44 bg-white/95 backdrop-blur-xl border border-gray-200/80 rounded-xl shadow-xl z-20 overflow-visible py-1">
                            {importFailed && (
                              <>
                                <button
                                  onClick={() => void handleRetryImport(book.id)}
                                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm font-medium text-red-700 hover:bg-red-50"
                                  title={book.import_error || '重新解析原始上传文件'}
                                >
                                  <Loader size={14} className="text-red-500" />
                                  重新解析
                                </button>
                                <div className="my-1 h-px bg-gray-200/80" />
                              </>
                            )}

                              {/* Pin / Unpin */}
                              <button
                                onClick={() => { handleTogglePin(book.id, book.is_pinned); setContextMenuId(null); setStatusMenuOpenId(null); }}
                                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100/80 flex items-center gap-2.5"
                              >
                                <Pin size={14} className={book.is_pinned ? 'text-amber-500' : 'text-gray-400'} />
                                {book.is_pinned ? '取消置顶' : '置顶'}
                              </button>

                            {/* Reading status - with sub-menu */}
                            <div className="relative">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setStatusMenuOpenId(statusMenuOpenId === book.id ? null : book.id);
                                  setMoveMenuOpenId(null);
                                }}
                                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100/80 flex items-center gap-2.5"
                              >
                                <BookOpen size={14} className="text-gray-400" />
                                标记状态
                              </button>

                              {statusMenuOpenId === book.id && (
                                <div className="absolute right-full top-0 mr-1 w-36 bg-white/95 backdrop-blur-xl border border-gray-200/80 rounded-xl shadow-xl z-30 overflow-hidden py-1">
                                  {READING_STATUS_OPTIONS.map((status) => (
                                    <button
                                      key={status}
                                      onClick={() => {
                                        void handleUpdateReadingStatus(book.id, status);
                                        setContextMenuId(null);
                                        setStatusMenuOpenId(null);
                                      }}
                                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100/80 flex items-center gap-2 ${
                                        readingStatus === status ? 'text-blue-600 font-medium' : 'text-gray-700'
                                      }`}
                                    >
                                      <span className={`h-2.5 w-2.5 rounded-full ${READING_STATUS_DISPLAY[status].dotClassName}`} />
                                      <span>{READING_STATUS_DISPLAY[status].label}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Move to folder - with sub-menu */}
                            <div className="relative">
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setMoveMenuOpenId(moveMenuOpenId === book.id ? null : book.id);
                                  setStatusMenuOpenId(null);
                                }}
                                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100/80 flex items-center gap-2.5"
                              >
                                <FolderInput size={14} className="text-gray-400" />
                                移动到文件夹
                              </button>

                              {moveMenuOpenId === book.id && (
                                <div className="absolute right-full top-0 mr-1 w-40 bg-white/95 backdrop-blur-xl border border-gray-200/80 rounded-xl shadow-xl z-30 max-h-60 overflow-y-auto py-1">
                                  <button
                                    onClick={() => { handleMoveBook(book.id, null); setContextMenuId(null); setMoveMenuOpenId(null); setStatusMenuOpenId(null); }}
                                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100/80 ${
                                      book.folder_id === null ? 'text-blue-600 font-medium' : 'text-gray-700'
                                    }`}
                                  >
                                    未分类
                                  </button>
                                  {folders.map((folder) => (
                                    <button
                                      key={folder.id}
                                      onClick={() => { handleMoveBook(book.id, folder.id); setContextMenuId(null); setMoveMenuOpenId(null); setStatusMenuOpenId(null); }}
                                      className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-100/80 flex items-center gap-2 ${
                                        book.folder_id === folder.id ? 'text-blue-600 font-medium' : 'text-gray-700'
                                      }`}
                                    >
                                      <span
                                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                        style={{ backgroundColor: folder.color }}
                                      />
                                      <span className="truncate">{folder.name}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Reading guide */}
                            <button
                              onClick={() => {
                                if (!textFeaturesAvailable) return;
                                setReadingGuideBook(book);
                                setContextMenuId(null);
                              }}
                              disabled={!textFeaturesAvailable}
                              className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100/80 flex items-center gap-2.5 disabled:cursor-not-allowed disabled:text-gray-400 disabled:hover:bg-transparent"
                              title={textFeaturesAvailable ? '生成或查看AI摘要' : '扫描版 PDF 未检测到可提取文字'}
                            >
                              <FileText size={14} className="text-gray-400" />
                              AI摘要
                            </button>

                            {/* Stop batch translation */}
                            {batchStatus[book.id] && (
                              <button
                                onClick={() => { stopBatchTranslation(book.id); setContextMenuId(null); }}
                                className="w-full text-left px-3 py-2 text-sm text-amber-700 hover:bg-amber-50 flex items-center gap-2.5"
                              >
                                <Square size={14} className="text-amber-500" />
                                停止翻译
                              </button>
                            )}

                            {!batchStatus[book.id] && !textFeaturesAvailable && (
                              <button
                                disabled
                                className="w-full cursor-not-allowed px-3 py-2 text-left text-sm text-gray-400 flex items-center gap-2.5"
                                title="扫描版 PDF 未检测到可提取文字"
                              >
                                <Globe size={14} className="text-gray-300" />
                                扫描版不可翻译
                              </button>
                            )}

                            {/* Batch translate */}
                            {!batchStatus[book.id] && textFeaturesAvailable && (book.translated_pages !== book.total_pages || book.total_pages === 0) && (
                              <button
                                onClick={() => { startBatchTranslation(book.id); setContextMenuId(null); }}
                                className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100/80 flex items-center gap-2.5"
                              >
                                <Globe size={14} className="text-gray-400" />
                                {(book.translated_pages ?? 0) > 0 ? '继续翻译' : '一键全本翻译'}
                              </button>
                            )}

                            {/* Divider */}
                            <div className="h-px bg-gray-200/80 my-1" />

                            {/* Delete */}
                            <button
                              onClick={() => { handleDeleteClick(book.id); setContextMenuId(null); }}
                              disabled={deleteConfirmLoading}
                              className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2.5 disabled:opacity-50"
                            >
                              <Trash2 size={14} />
                              删除书籍
                            </button>
                          </div>
                        )}
                      </div>
                      )}
                    </div>

                    <div
                      className="h-1.5 overflow-hidden rounded-full bg-gray-200"
                      title={`翻译进度：${translationDisplay.detail}`}
                    >
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${translationDisplay.barClass}`}
                        style={{ width: `${translationDisplay.percent}%` }}
                      />
                    </div>

                    <div className="flex items-center">
                      <button
                        onClick={() => {
                          if (isSelectionMode) {
                            toggleBookSelection(book.id);
                            return;
                          }
                          setReadingGuideBook(book);
                        }}
                        disabled={!isSelectionMode && !textFeaturesAvailable}
                        className={`inline-flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors hover:bg-white disabled:cursor-not-allowed disabled:hover:bg-slate-100 ${readingGuideDisplay.className}`}
                        title={readingGuideDisplay.title}
                      >
                        {readingGuideDisplay.state === 'active' ? (
                          <Loader size={10} className="animate-spin shrink-0" />
                        ) : readingGuideDisplay.state === 'complete' ? (
                          <CheckCircle2 size={10} className="shrink-0" />
                        ) : readingGuideDisplay.state === 'failed' ? (
                          <AlertCircle size={10} className="shrink-0" />
                        ) : (
                          <Circle size={9} className="shrink-0" />
                        )}
                        <span className="truncate">{readingGuideDisplay.label}</span>
                      </button>
                    </div>

                    <div className="flex items-center justify-between text-[10px] font-medium text-gray-400">
                      <span>阅读进度 {readPercent}%</span>
                      <span>
                        第 {Math.min(book.last_read_page || 1, book.total_pages || 1)}/{book.total_pages || 0} 页
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Empty State */}
          {displayedBooks.length === 0 && !uploading && (
            <div className="text-center py-16">
              <div className="inline-block p-4 bg-blue-100 rounded-full mb-4">
                <BookOpen className="text-blue-600" size={40} />
              </div>
              {books.length > 0 ? (
                <>
                  <h2 className="text-xl font-bold text-gray-900 mb-2">没有符合条件的书籍</h2>
                  <p className="text-gray-600">试试调整筛选条件或搜索关键词</p>
                </>
              ) : (
                <>
                  <h2 className="text-xl font-bold text-gray-900 mb-2">
                    {selectedFolderId === 'all' ? '还没有书籍' : selectedFolderId === null ? '没有未分类的书籍' : '该文件夹为空'}
                  </h2>
                  <p className="text-gray-600 mb-4">
                    {selectedFolderId === 'all'
                      ? '点击上方的 "上传书籍" 按钮开始添加'
                      : '可以将其他书籍移动到此处'}
                  </p>
                  {selectedFolderId === 'all' && (
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 max-w-md mx-auto">
                      <p className="text-sm text-blue-900">
                        支持 EPUB、PDF 格式的图书
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Create Folder Dialog */}
      <CreateFolderDialog
        isOpen={showCreateFolder}
        onClose={() => setShowCreateFolder(false)}
        onCreated={(folder) => {
          addFolder(folder);
          setShowCreateFolder(false);
        }}
      />

      <ReadingGuideDialog
        isOpen={readingGuideBook !== null}
        book={readingGuideBook}
        onClose={() => setReadingGuideBook(null)}
        onStartTranslation={startBatchTranslation}
        onDelete={handleDeleteClick}
        onGuideChange={updateBookReadingGuide}
      />

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteConfirmId !== null}
        title="删除书籍"
        message={`确定要删除《${getBookName()}》吗？删除后将无法恢复。`}
        confirmText="删除"
        cancelText="取消"
        isDangerous={true}
        isLoading={deleteConfirmLoading}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  );
}
