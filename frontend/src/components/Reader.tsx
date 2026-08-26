import { useEffect, useState, useRef, useCallback, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent } from 'react';
import { useBookStore } from '../stores/useBookStore';
import { bookApi, translationApi } from '../services/api';
import { ChevronLeft, ChevronRight, Loader, Home, AlertCircle, Menu, X, Maximize2, Minimize2, Languages, BookOpen, SunMedium, Leaf, Moon, Coffee, MonitorSmartphone, Sparkles, FileText, Network, Settings } from 'lucide-react';
import { TableOfContents, type TOCEntry } from './TableOfContents';
import PdfReaderPane from './PdfReaderPane';
import AiChatPanel from './AiChatPanel';
import SummaryPanel from './SummaryPanel';
import MindMapPanel from './MindMapPanel';
import { BACKEND_ORIGIN } from '../config/backend';
import type { Page as BookPage } from '../types';
import { getCancellationInfo, getErrorMessage } from '../utils/error';
import { getVisibleText, hasRenderableEpubContent, sanitizeEpubHtml } from '../utils/sanitize';
import {
  canUseBookTextFeatures,
  getDefaultReadingMode,
  type ReadingMode,
} from '../utils/bookCapabilities';

interface ReaderProps {
  onNavigateHome: () => void;
  onNavigateSettings: () => void;
}

type ReaderTheme = 'paper' | 'eye-care' | 'night' | 'sepia' | 'amoled';
type HighlightRegistry = {
  delete: (name: string) => void;
  set: (name: string, highlight: unknown) => void;
};
type CssWithHighlights = typeof CSS & { highlights?: HighlightRegistry };
type WindowWithHighlight = Window & typeof globalThis & {
  Highlight?: new (...ranges: Range[]) => unknown;
};
type DocumentWithCaretFromPoint = Document & {
  caretPositionFromPoint?: (x: number, y: number) => {
    offset: number;
    offsetNode: Node;
  } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};
type LastReadTarget = {
  bookId: number;
  pageNumber: number;
};
type DragSelectionGesture = {
  startX: number;
  startY: number;
  target: EventTarget | null;
};

const PAGE_COLUMN_GAP = 56;
const CJK_TEXT_PATTERN = /[\u3400-\u9fff]/;
const TOUCH_SWIPE_MIN_DISTANCE = 56;
const TOUCH_SWIPE_MAX_DURATION_MS = 650;
const TOUCH_SWIPE_AXIS_RATIO = 1.35;
const FRONT_MATTER_TITLE_MAP: Record<string, string> = {
  cover: '封面',
  contents: '目录',
  'table of contents': '目录',
  'title page': '标题页',
  copyright: '版权页',
  dedication: '献词',
  acknowledgments: '致谢',
  acknowledgements: '致谢',
  foreword: '序言',
  'in gratitude': '致谢',
  introduction: '导言',
  preface: '前言',
  "publisher's note": '出版者说明',
};

const READER_THEME_STORAGE_KEY = 'mt-reader-theme';

const VALID_THEMES: ReaderTheme[] = ['paper', 'eye-care', 'night', 'sepia', 'amoled'];

const readerThemeOptions: Array<{
  id: ReaderTheme;
  label: string;
  icon: typeof SunMedium;
}> = [
  { id: 'paper', label: '默认', icon: SunMedium },
  { id: 'sepia', label: '暖色', icon: Coffee },
  { id: 'eye-care', label: '护眼', icon: Leaf },
  { id: 'night', label: '夜晚', icon: Moon },
  { id: 'amoled', label: '纯黑', icon: MonitorSmartphone },
];

const isSameLastReadTarget = (a: LastReadTarget | null, b: LastReadTarget) =>
  a?.bookId === b.bookId && a.pageNumber === b.pageNumber;

const readerThemeStyles: Record<ReaderTheme, CSSProperties> = {
  paper: {
    '--reader-shell-bg': '#eef2f7',
    '--reader-header-bg': 'rgba(255, 255, 255, 0.9)',
    '--reader-header-border': 'rgba(148, 163, 184, 0.2)',
    '--reader-surface-bg': '#ffffff',
    '--reader-surface-alt-bg': 'linear-gradient(180deg, #f8fafc 0%, #eef2ff 100%)',
    '--reader-surface-border': 'rgba(148, 163, 184, 0.18)',
    '--reader-divider': 'linear-gradient(180deg, rgba(203, 213, 225, 0.85) 0%, rgba(59, 130, 246, 0.45) 50%, rgba(203, 213, 225, 0.85) 100%)',
    '--reader-text': '#0f172a',
    '--reader-muted-text': '#64748b',
    '--reader-progress-track': 'rgba(148, 163, 184, 0.22)',
    '--reader-progress-fill': 'linear-gradient(90deg, #2563eb 0%, #3b82f6 100%)',
    '--reader-button-hover': 'rgba(226, 232, 240, 0.9)',
    '--reader-button-active-bg': 'rgba(219, 234, 254, 1)',
    '--reader-button-active-text': '#2563eb',
    '--reader-accent': '#2563eb',
    '--reader-chip-bg': 'rgba(255, 255, 255, 0.82)',
    '--reader-chip-border': 'rgba(148, 163, 184, 0.24)',
    '--reader-pdf-frame': '#e2e8f0',
    '--reader-pdf-surface': '#ffffff',
    '--reader-nav-bg': 'rgba(37, 99, 235, 0.24)',
    '--reader-nav-hover-bg': 'rgba(37, 99, 235, 0.92)',
    '--reader-tip-bg': 'rgba(239, 246, 255, 0.92)',
    '--reader-tip-border': 'rgba(147, 197, 253, 0.48)',
  } as CSSProperties,
  'eye-care': {
    '--reader-shell-bg': '#dce8d3',
    '--reader-header-bg': 'rgba(240, 247, 233, 0.9)',
    '--reader-header-border': 'rgba(101, 163, 13, 0.18)',
    '--reader-surface-bg': '#f6faee',
    '--reader-surface-alt-bg': 'linear-gradient(180deg, #f0f7e9 0%, #e7f1de 100%)',
    '--reader-surface-border': 'rgba(132, 204, 22, 0.14)',
    '--reader-divider': 'linear-gradient(180deg, rgba(163, 230, 53, 0.18) 0%, rgba(101, 163, 13, 0.65) 50%, rgba(163, 230, 53, 0.18) 100%)',
    '--reader-text': '#334155',
    '--reader-muted-text': '#5f6f52',
    '--reader-progress-track': 'rgba(101, 163, 13, 0.16)',
    '--reader-progress-fill': 'linear-gradient(90deg, #65a30d 0%, #84cc16 100%)',
    '--reader-button-hover': 'rgba(220, 252, 231, 0.82)',
    '--reader-button-active-bg': 'rgba(220, 252, 231, 1)',
    '--reader-button-active-text': '#4d7c0f',
    '--reader-accent': '#65a30d',
    '--reader-chip-bg': 'rgba(246, 250, 238, 0.92)',
    '--reader-chip-border': 'rgba(132, 204, 22, 0.2)',
    '--reader-pdf-frame': '#d9e7ca',
    '--reader-pdf-surface': '#f8fcf2',
    '--reader-nav-bg': 'rgba(101, 163, 13, 0.24)',
    '--reader-nav-hover-bg': 'rgba(101, 163, 13, 0.9)',
    '--reader-tip-bg': 'rgba(236, 253, 245, 0.9)',
    '--reader-tip-border': 'rgba(132, 204, 22, 0.4)',
  } as CSSProperties,
  night: {
    '--reader-shell-bg': '#111827',
    '--reader-header-bg': 'rgba(15, 23, 42, 0.88)',
    '--reader-header-border': 'rgba(71, 85, 105, 0.45)',
    '--reader-surface-bg': '#172033',
    '--reader-surface-alt-bg': 'linear-gradient(180deg, #192236 0%, #101828 100%)',
    '--reader-surface-border': 'rgba(71, 85, 105, 0.32)',
    '--reader-divider': 'linear-gradient(180deg, rgba(30, 41, 59, 0.95) 0%, rgba(59, 130, 246, 0.52) 50%, rgba(30, 41, 59, 0.95) 100%)',
    '--reader-text': '#e5edf6',
    '--reader-muted-text': '#94a3b8',
    '--reader-progress-track': 'rgba(100, 116, 139, 0.28)',
    '--reader-progress-fill': 'linear-gradient(90deg, #38bdf8 0%, #2563eb 100%)',
    '--reader-button-hover': 'rgba(30, 41, 59, 0.92)',
    '--reader-button-active-bg': 'rgba(30, 64, 175, 0.28)',
    '--reader-button-active-text': '#7dd3fc',
    '--reader-accent': '#38bdf8',
    '--reader-chip-bg': 'rgba(15, 23, 42, 0.76)',
    '--reader-chip-border': 'rgba(71, 85, 105, 0.44)',
    '--reader-pdf-frame': '#0f172a',
    '--reader-pdf-surface': '#f8fafc',
    '--reader-nav-bg': 'rgba(56, 189, 248, 0.22)',
    '--reader-nav-hover-bg': 'rgba(56, 189, 248, 0.88)',
    '--reader-tip-bg': 'rgba(15, 23, 42, 0.72)',
    '--reader-tip-border': 'rgba(56, 189, 248, 0.28)',
  } as CSSProperties,
  sepia: {
    '--reader-shell-bg': '#e8dcc8',
    '--reader-header-bg': 'rgba(245, 235, 220, 0.92)',
    '--reader-header-border': 'rgba(180, 150, 110, 0.22)',
    '--reader-surface-bg': '#faf5eb',
    '--reader-surface-alt-bg': 'linear-gradient(180deg, #f5edde 0%, #efe4d0 100%)',
    '--reader-surface-border': 'rgba(180, 150, 110, 0.16)',
    '--reader-divider': 'linear-gradient(180deg, rgba(210, 185, 150, 0.3) 0%, rgba(184, 134, 11, 0.6) 50%, rgba(210, 185, 150, 0.3) 100%)',
    '--reader-text': '#3d2e1e',
    '--reader-muted-text': '#7c6a55',
    '--reader-progress-track': 'rgba(180, 150, 110, 0.2)',
    '--reader-progress-fill': 'linear-gradient(90deg, #b8860b 0%, #d4a017 100%)',
    '--reader-button-hover': 'rgba(235, 220, 195, 0.85)',
    '--reader-button-active-bg': 'rgba(255, 243, 224, 1)',
    '--reader-button-active-text': '#8b6914',
    '--reader-accent': '#b8860b',
    '--reader-chip-bg': 'rgba(250, 245, 235, 0.88)',
    '--reader-chip-border': 'rgba(180, 150, 110, 0.22)',
    '--reader-pdf-frame': '#ddd0bb',
    '--reader-pdf-surface': '#fdf8f0',
    '--reader-nav-bg': 'rgba(184, 134, 11, 0.22)',
    '--reader-nav-hover-bg': 'rgba(184, 134, 11, 0.88)',
    '--reader-tip-bg': 'rgba(255, 248, 235, 0.92)',
    '--reader-tip-border': 'rgba(212, 160, 23, 0.4)',
  } as CSSProperties,
  amoled: {
    '--reader-shell-bg': '#000000',
    '--reader-header-bg': 'rgba(0, 0, 0, 0.96)',
    '--reader-header-border': 'rgba(55, 55, 55, 0.6)',
    '--reader-surface-bg': '#050505',
    '--reader-surface-alt-bg': '#0a0a0a',
    '--reader-surface-border': 'rgba(55, 55, 55, 0.4)',
    '--reader-divider': 'linear-gradient(180deg, rgba(40, 40, 40, 0.95) 0%, rgba(139, 92, 246, 0.5) 50%, rgba(40, 40, 40, 0.95) 100%)',
    '--reader-text': '#d4d4d4',
    '--reader-muted-text': '#737373',
    '--reader-progress-track': 'rgba(82, 82, 82, 0.32)',
    '--reader-progress-fill': 'linear-gradient(90deg, #a78bfa 0%, #8b5cf6 100%)',
    '--reader-button-hover': 'rgba(38, 38, 38, 0.95)',
    '--reader-button-active-bg': 'rgba(88, 28, 235, 0.22)',
    '--reader-button-active-text': '#c4b5fd',
    '--reader-accent': '#a78bfa',
    '--reader-chip-bg': 'rgba(10, 10, 10, 0.85)',
    '--reader-chip-border': 'rgba(55, 55, 55, 0.55)',
    '--reader-pdf-frame': '#0a0a0a',
    '--reader-pdf-surface': '#fafafa',
    '--reader-nav-bg': 'rgba(139, 92, 246, 0.2)',
    '--reader-nav-hover-bg': 'rgba(139, 92, 246, 0.85)',
    '--reader-tip-bg': 'rgba(10, 10, 10, 0.8)',
    '--reader-tip-border': 'rgba(139, 92, 246, 0.3)',
  } as CSSProperties,
};

export default function Reader({ onNavigateHome, onNavigateSettings }: ReaderProps) {
  const themeKey = READER_THEME_STORAGE_KEY;
  const {
    currentBook,
    currentPage,
    pages,
    setPage,
    setCurrentPage,
    setLoading,
    setError,
  } = useBookStore();
  const currentBookId = currentBook?.id ?? null;
  const isPdf = currentBook?.file_type === 'pdf';
  const isEpub = currentBook?.file_type === 'epub';
  const textFeaturesAvailable = canUseBookTextFeatures(currentBook);

  // Use default values for display preferences (Settings UI removed)
  const fontSize = 18;
  const lineHeight = '1.95';

  const [isTocOpen, setIsTocOpen] = useState(false);
  const [tableOfContents, setTableOfContents] = useState<TOCEntry[] | null>(null);
  const [localizedTableOfContents, setLocalizedTableOfContents] = useState<TOCEntry[] | null>(null);
  const [showReaderHeader, setShowReaderHeader] = useState(true);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isAiPanelOpen, setIsAiPanelOpen] = useState(false);
  const isAiPanelOpenRef = useRef(false);
  const [isSummaryPanelOpen, setIsSummaryPanelOpen] = useState(false);
  const [isMindMapPanelOpen, setIsMindMapPanelOpen] = useState(false);
  const [selectedText, setSelectedText] = useState<string>('');
  const [selectionPosition, setSelectionPosition] = useState<{ x: number; y: number } | null>(null);
  const highlightRangeRef = useRef<Range | null>(null);
  const selectionUpdateTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const selectionFallbackHoldUntilRef = useRef(0);
  const isProgrammaticSelectionActiveRef = useRef(false);
  const selectedElementRef = useRef<HTMLElement | null>(null);
  const swipeGestureRef = useRef<{
    startTime: number;
    startX: number;
    startY: number;
  } | null>(null);
  const pointerTapRef = useRef<{
    startX: number;
    startY: number;
    target: EventTarget | null;
  } | null>(null);
  const mouseDragSelectionRef = useRef<DragSelectionGesture | null>(null);
  const pointerDragSelectionRef = useRef<(DragSelectionGesture & {
    pointerId: number;
  }) | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [readingMode, setReadingMode] = useState<ReadingMode>('translated');
  const [pageSegmentIndex, setPageSegmentIndex] = useState(0);
  const [pageSegmentCount, setPageSegmentCount] = useState(1);
  const [pageColumnWidth, setPageColumnWidth] = useState(0);
  const [pageColumnStride, setPageColumnStride] = useState(0);
  const [isPageMetricsReady, setIsPageMetricsReady] = useState(true);
  const [isPageFlowTransitionSuppressed, setIsPageFlowTransitionSuppressed] = useState(false);
  const [readerTheme, setReaderTheme] = useState<ReaderTheme>(() => {
    if (typeof window === 'undefined') return 'paper';
    const savedTheme = window.localStorage.getItem(themeKey);
    return VALID_THEMES.includes(savedTheme as ReaderTheme) ? (savedTheme as ReaderTheme) : 'paper';
  });

  const currentBookRef = useRef(currentBook);
  const currentPageRef = useRef(currentPage);
  const lastQueuedReadRef = useRef<LastReadTarget | null>(null);
  const lastPersistedReadRef = useRef<LastReadTarget | null>(null);
  const lastReadSavePromiseRef = useRef<Promise<void>>(Promise.resolve());
  const pageFlowTransitionFrameRef = useRef<number | null>(null);

  const readerContainerRef = useRef<HTMLDivElement>(null);
  const pageViewportRef = useRef<HTMLDivElement>(null);
  const pageContentRef = useRef<HTMLDivElement>(null);
  const loadingPageRef = useRef<number | null>(null); // Track which page we're currently loading from backend
  const [isTouchSelectionDevice, setIsTouchSelectionDevice] = useState(() => (
    typeof window !== 'undefined' &&
    (window.matchMedia('(hover: none) and (pointer: coarse)').matches || navigator.maxTouchPoints > 1)
  ));

  // Construct PDF URL using the backend base URL (defined early for use in useEffect)
  const getPdfUrl = () => {
    if (!currentBook?.file_url) return '';
    return `${BACKEND_ORIGIN}${currentBook.file_url}`;
  };
  const pdfFileUrl = getPdfUrl();
  const isPdfOriginalMode = isPdf && readingMode === 'original';
  const readerThemeStyle = readerThemeStyles[readerTheme];

  useEffect(() => {
    currentBookRef.current = currentBook;
    currentPageRef.current = currentPage;
  }, [currentBook, currentPage]);

  const suppressPageFlowTransition = useCallback(() => {
    if (pageFlowTransitionFrameRef.current !== null) {
      window.cancelAnimationFrame(pageFlowTransitionFrameRef.current);
    }

    setIsPageFlowTransitionSuppressed(true);
    pageFlowTransitionFrameRef.current = window.requestAnimationFrame(() => {
      pageFlowTransitionFrameRef.current = window.requestAnimationFrame(() => {
        pageFlowTransitionFrameRef.current = null;
        setIsPageFlowTransitionSuppressed(false);
      });
    });
  }, []);

  useEffect(() => () => {
    if (pageFlowTransitionFrameRef.current !== null) {
      window.cancelAnimationFrame(pageFlowTransitionFrameRef.current);
    }
  }, []);

  const queueLastReadSave = useCallback((bookId: number, pageNumber: number) => {
    const safePageNumber = Math.max(1, Math.floor(pageNumber));
    const target = { bookId, pageNumber: safePageNumber };

    if (
      isSameLastReadTarget(lastQueuedReadRef.current, target) ||
      isSameLastReadTarget(lastPersistedReadRef.current, target)
    ) {
      return lastReadSavePromiseRef.current;
    }

    lastQueuedReadRef.current = target;
    const savePromise = lastReadSavePromiseRef.current
      .catch(() => undefined)
      .then(async () => {
        if (!isSameLastReadTarget(lastQueuedReadRef.current, target)) return;

        try {
          await bookApi.updateLastRead(bookId, safePageNumber);
          lastPersistedReadRef.current = target;
        } catch (error) {
          console.error('Failed to update last read page:', error);
        } finally {
          if (isSameLastReadTarget(lastQueuedReadRef.current, target)) {
            lastQueuedReadRef.current = null;
          }
        }
      });

    lastReadSavePromiseRef.current = savePromise;
    return savePromise;
  }, []);

  const handleNavigateHome = useCallback(() => {
    if (!currentBook) {
      onNavigateHome();
      return;
    }

    const bookId = currentBook.id;
    const pageNumber = currentPage;
    onNavigateHome();
    void queueLastReadSave(bookId, pageNumber);
  }, [currentBook, currentPage, onNavigateHome, queueLastReadSave]);

  const handleNavigateSettings = useCallback(() => {
    if (!currentBook) {
      onNavigateSettings();
      return;
    }

    const bookId = currentBook.id;
    const pageNumber = currentPage;
    onNavigateSettings();
    void queueLastReadSave(bookId, pageNumber);
  }, [currentBook, currentPage, onNavigateSettings, queueLastReadSave]);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(hover: none) and (pointer: coarse)');
    const updateTouchSelectionDevice = () => {
      setIsTouchSelectionDevice(mediaQuery.matches || navigator.maxTouchPoints > 1);
    };

    updateTouchSelectionDevice();
    mediaQuery.addEventListener('change', updateTouchSelectionDevice);
    return () => mediaQuery.removeEventListener('change', updateTouchSelectionDevice);
  }, []);
  const renderedPageNumbers = [currentPage];

  useEffect(() => {
    window.localStorage.setItem(themeKey, readerTheme);
  }, [readerTheme, themeKey]);

  // Translation configuration is now managed via .env environment variables
  // No need to check config from API anymore

  // Load table of contents when book changes
  useEffect(() => {
    if (!currentBook) {
      setTableOfContents(null);
      return;
    }

    if (currentBook.tableOfContents) {
      setTableOfContents(currentBook.tableOfContents);
    } else {
      setTableOfContents(null);
    }
    setLocalizedTableOfContents(null);
  }, [currentBook]);

  useEffect(() => {
    setReadingMode(getDefaultReadingMode(currentBook?.file_type));
    if (!textFeaturesAvailable) {
      isAiPanelOpenRef.current = false;
      setIsAiPanelOpen(false);
      setIsSummaryPanelOpen(false);
      setIsMindMapPanelOpen(false);
    }
  }, [currentBook?.file_type, currentBookId, textFeaturesAvailable]);

  // Load page data - always reload to get fresh translation status
  useEffect(() => {
    if (!currentBook) return;

    const loadPage = async () => {
      try {
        setLoading(true);
        loadingPageRef.current = currentPage; // Track which page we're loading

        const response = await bookApi.getPages(currentBook.id, currentPage);
        const pageData = response.data.data;

        // CRITICAL FIX: Check if we're still loading the same page
        // If user navigated away, don't update stale data
        if (loadingPageRef.current !== currentPage) {
          return;
        }

        if (pageData) {
          // Always use backend data as the authoritative source
          setPage(pageData);
        } else {
          console.warn(`[Page Loading] 第 ${currentPage} 页无数据`);
        }
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        console.error(`[Page Loading] 加载第 ${currentPage} 页失败: ${message}`);
        setError(`加载页面失败: ${message}`);
      } finally {
        setLoading(false);
      }
    };

    // Always load the page to ensure we have the latest translation status.
    loadPage();
  }, [currentBook, currentPage, setError, setLoading, setPage]);

  // Toggle fullscreen mode
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      // Enter fullscreen
      document.documentElement.requestFullscreen().then(() => {
        setIsFullscreen(true);
        setShowReaderHeader(false); // Hide header in fullscreen for immersive reading
      }).catch((err) => {
        console.error('Failed to enter fullscreen:', err);
      });
    } else {
      // Exit fullscreen
      document.exitFullscreen().then(() => {
        setIsFullscreen(false);
        setShowReaderHeader(true); // Show header when exiting fullscreen
      }).catch((err) => {
        console.error('Failed to exit fullscreen:', err);
      });
    }
  }, []);

  // Listen for fullscreen change events (e.g., user presses ESC)
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isNowFullscreen = !!document.fullscreenElement;
      setIsFullscreen(isNowFullscreen);
      if (!isNowFullscreen) {
        setShowReaderHeader(true); // Restore header when exiting fullscreen
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const goToBookPage = useCallback((page: number) => {
    if (!currentBook) return;
    suppressPageFlowTransition();
    setPageSegmentIndex(0);
    setPageSegmentCount(1);
    setPageColumnStride(0);
    setIsPageMetricsReady(false);
    setCurrentPage(Math.max(1, Math.min(page, currentBook.total_pages)));
  }, [currentBook, setCurrentPage, suppressPageFlowTransition]);

  const handleToggleReadingMode = useCallback(() => {
    if (!textFeaturesAvailable) return;
    suppressPageFlowTransition();
    setReadingMode((mode) => mode === 'translated' ? 'original' : 'translated');
  }, [suppressPageFlowTransition, textFeaturesAvailable]);

  // In single-column mode, arrows turn screen fragments first, then book pages.
  const handleNextPage = useCallback(() => {
    if (!currentBook || !isPageMetricsReady) return;

    if (pageSegmentIndex < pageSegmentCount - 1) {
      setPageSegmentIndex((index) => Math.min(index + 1, pageSegmentCount - 1));
      return;
    }

    if (currentPage >= currentBook.total_pages) return;
    goToBookPage(currentPage + 1);
  }, [currentBook, currentPage, goToBookPage, isPageMetricsReady, pageSegmentCount, pageSegmentIndex]);

  const handlePreviousPage = useCallback(() => {
    if (!isPageMetricsReady) return;

    if (pageSegmentIndex > 0) {
      setPageSegmentIndex((index) => Math.max(index - 1, 0));
      return;
    }

    if (currentPage <= 1) return;
    goToBookPage(currentPage - 1);
  }, [currentPage, goToBookPage, isPageMetricsReady, pageSegmentIndex]);

  const shouldIgnoreSwipeTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;

    return Boolean(target.closest(
      'button, a, input, textarea, select, [role="button"], [data-ai-popup]'
    ));
  }, []);

  const handleReaderTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
    if (!isTouchSelectionDevice || event.touches.length !== 1 || shouldIgnoreSwipeTarget(event.target)) {
      swipeGestureRef.current = null;
      return;
    }

    const touch = event.touches[0];
    swipeGestureRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      startTime: Date.now(),
    };
  }, [isTouchSelectionDevice, shouldIgnoreSwipeTarget]);

  const handleReaderTouchEnd = useCallback((event: TouchEvent<HTMLDivElement>) => {
    const gesture = swipeGestureRef.current;
    swipeGestureRef.current = null;

    if (!isTouchSelectionDevice || !gesture || event.changedTouches.length !== 1) return;

    // If a text selection exists, the gesture belonged to selection handles rather than page navigation.
    if (window.getSelection()?.toString().trim()) return;

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - gesture.startX;
    const deltaY = touch.clientY - gesture.startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const elapsed = Date.now() - gesture.startTime;

    if (
      elapsed > TOUCH_SWIPE_MAX_DURATION_MS ||
      absX < TOUCH_SWIPE_MIN_DISTANCE ||
      absX < absY * TOUCH_SWIPE_AXIS_RATIO
    ) {
      return;
    }

    if (deltaX < 0) {
      handleNextPage();
    } else {
      handlePreviousPage();
    }
  }, [handleNextPage, handlePreviousPage, isTouchSelectionDevice]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        handlePreviousPage();
      } else if (e.key === 'ArrowRight') {
        handleNextPage();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'j') {
        if (!textFeaturesAvailable) return;
        e.preventDefault();
        isAiPanelOpenRef.current = true;
        setIsAiPanelOpen(true);
      } else if (e.key === 'f' || e.key === 'F') {
        // Don't trigger fullscreen when typing in an input
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
          return;
        }
        e.preventDefault();
        toggleFullscreen();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNextPage, handlePreviousPage, textFeaturesAvailable, toggleFullscreen]);

  useEffect(() => {
    setPageSegmentIndex(0);
    setPageSegmentCount(1);
    setPageColumnStride(0);
    setIsPageMetricsReady(isPdfOriginalMode);
  }, [currentPage, isPdfOriginalMode, readingMode]);

  // Keep the user's per-book reading position current without writing on every render.
  useEffect(() => {
    if (!currentBookId) return;

    const timer = window.setTimeout(() => {
      void queueLastReadSave(currentBookId, currentPage);
    }, 600);
    return () => clearTimeout(timer);
  }, [currentBookId, currentPage, queueLastReadSave]);

  useEffect(() => {
    return () => {
      const book = currentBookRef.current;
      if (book) {
        void queueLastReadSave(book.id, currentPageRef.current);
      }
    };
  }, [queueLastReadSave]);

  // Handle retry translation for failed translations
  const handleRetryTranslation = async () => {
    if (!currentBook || !pages[currentPage]) return;

    setIsRetrying(true);
    try {
      const translateResult = await translationApi.translatePage(currentBook.id, currentPage);

      // CRITICAL FIX: Re-fetch latest page data from store to avoid stale closures
      const latestPageData = useBookStore.getState().pages[currentPage];
      if (latestPageData) {
        setPage({
          ...latestPageData,
          translated_text: translateResult.data.data.translatedText,
          translation_status: 'completed'
        });
      }
    } catch (error: unknown) {
      const cancellationInfo = getCancellationInfo(error);

      if (!cancellationInfo.isCancelled) {
        console.error(`[Retry] Retry failed:`, error);
        console.error(`[Retry] 错误详情: name=${cancellationInfo.name}, code=${cancellationInfo.code}, message=${getErrorMessage(error)}`);
      }
    } finally {
      setIsRetrying(false);
    }
  };


  // Handle TOC navigation
  const handleTocNavigate = (pageNumber: number) => {
    goToBookPage(pageNumber);
  };

  // Helper to apply CSS custom highlight
  const applyHighlight = useCallback((range: Range) => {
    try {
      const HighlightConstructor = (window as WindowWithHighlight).Highlight;
      const highlightRegistry = (CSS as CssWithHighlights).highlights;
      if (HighlightConstructor && highlightRegistry) {
        const highlight = new HighlightConstructor(range);
        highlightRegistry.set('ai-selection', highlight);
      }
    } catch {
      // CSS Highlight is optional; native selection remains available.
    }
  }, []);

  const clearHighlight = useCallback(() => {
    try {
      const highlightRegistry = (CSS as CssWithHighlights).highlights;
      if (highlightRegistry) {
        highlightRegistry.delete('ai-selection');
      }
    } catch {
      // Ignore browsers without a writable highlight registry.
    }
  }, []);

  const clearSelectedElementHighlight = useCallback(() => {
    selectedElementRef.current?.classList.remove('reader-paragraph-ai-selected');
    selectedElementRef.current = null;
  }, []);

  const clearSelectedTextState = useCallback(() => {
    setSelectionPosition(null);
    if (!isAiPanelOpenRef.current) {
      isProgrammaticSelectionActiveRef.current = false;
      clearHighlight();
      clearSelectedElementHighlight();
      highlightRangeRef.current = null;
      setSelectedText('');
    }
  }, [clearHighlight, clearSelectedElementHighlight]);

  const getSelectionPopupPosition = useCallback((range: Range) => {
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0
    );
    const rect = rects[0] ?? range.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;

    const horizontalPadding = 72;
    const x = Math.min(
      Math.max(rect.left + rect.width / 2, horizontalPadding),
      window.innerWidth - horizontalPadding
    );
    const y = Math.max(56, rect.top - 10);

    return { x, y };
  }, []);

  const getCaretRangeFromPoint = useCallback((x: number, y: number): Range | null => {
    const caretDocument = document as DocumentWithCaretFromPoint;

    if (caretDocument.caretPositionFromPoint) {
      const position = caretDocument.caretPositionFromPoint(x, y);
      if (!position) return null;

      const range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }

    return caretDocument.caretRangeFromPoint?.(x, y) ?? null;
  }, []);

  const isSelectionInsideReader = useCallback((range: Range) => {
    const container = readerContainerRef.current;
    if (!container) return false;

    const rangeNode = range.commonAncestorContainer;
    const rangeElement = rangeNode.nodeType === Node.ELEMENT_NODE
      ? rangeNode as Element
      : rangeNode.parentElement;

    return Boolean(rangeElement && container.contains(rangeElement));
  }, []);

  const getSelectableTextElement = useCallback((target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof HTMLElement) || shouldIgnoreSwipeTarget(target)) return null;

    const content = pageContentRef.current;
    if (!content || !content.contains(target)) return null;
    const textBlockSelector = '.textLayer span, p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th, div';
    const isSelectableTextBlock = (element: HTMLElement) => {
      if (
        element.classList.contains('epub-container') ||
        element.classList.contains('reader-book-page') ||
        element.classList.contains('reader-page-flow')
      ) {
        return false;
      }

      return Boolean(element.innerText.trim());
    };

    const directCandidate = target.closest(
      textBlockSelector
    ) as HTMLElement | null;
    if (directCandidate && content.contains(directCandidate) && isSelectableTextBlock(directCandidate)) {
      return directCandidate;
    }

    const textBlocks = Array.from(content.querySelectorAll<HTMLElement>(
      textBlockSelector
    ));
    return textBlocks.find((element) => element.contains(target) && isSelectableTextBlock(element)) ?? null;
  }, [shouldIgnoreSwipeTarget]);

  const selectTextElementForAi = useCallback((element: HTMLElement) => {
    const text = element.innerText.trim();
    if (!text) return;

    const range = document.createRange();
    range.selectNodeContents(element);
    const position = getSelectionPopupPosition(range);
    if (!position) return;

    clearSelectedElementHighlight();
    element.classList.add('reader-paragraph-ai-selected');
    selectedElementRef.current = element;

    const selection = window.getSelection();
    try {
      isProgrammaticSelectionActiveRef.current = true;
      selectionFallbackHoldUntilRef.current = Date.now() + 800;
      selection?.removeAllRanges();
      selection?.addRange(range);
    } catch {
      // The custom highlight still communicates the selected paragraph.
    }

    const clonedRange = range.cloneRange();
    setSelectedText(text);
    setSelectionPosition(position);
    highlightRangeRef.current = clonedRange;
    applyHighlight(clonedRange);
  }, [applyHighlight, clearSelectedElementHighlight, getSelectionPopupPosition]);

  // Handle text selection across desktop mouse, keyboard selection, and iPad touch handles.
  const handleTextSelection = useCallback((e?: Event) => {
    // Don't process if the user is tapping the AI selection popup.
    if ((e?.target as HTMLElement | null)?.closest?.('[data-ai-popup]')) {
      return;
    }

    const selection = window.getSelection();
    const text = selection?.toString().trim();

    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !text) {
      if (
        (isProgrammaticSelectionActiveRef.current || Date.now() < selectionFallbackHoldUntilRef.current) &&
        highlightRangeRef.current
      ) {
        return;
      }
      clearSelectedTextState();
      return;
    }

    const range = selection.getRangeAt(0);
    if (!isSelectionInsideReader(range)) {
      clearSelectedTextState();
      return;
    }

    const position = getSelectionPopupPosition(range);
    if (!position) {
      clearSelectedTextState();
      return;
    }

    const clonedRange = range.cloneRange();
    clearSelectedElementHighlight();
    setSelectedText(text);
    setSelectionPosition(position);
    highlightRangeRef.current = clonedRange;
    applyHighlight(clonedRange);
  }, [
    applyHighlight,
    clearSelectedElementHighlight,
    clearSelectedTextState,
    getSelectionPopupPosition,
    isSelectionInsideReader,
  ]);

  const scheduleTextSelectionCheck = useCallback((e?: Event) => {
    if ((e?.target as HTMLElement | null)?.closest?.('[data-ai-popup]')) {
      return;
    }

    if (selectionUpdateTimerRef.current) {
      window.clearTimeout(selectionUpdateTimerRef.current);
    }

    // iPadOS finalizes Selection API state shortly after touchend/selectionchange.
    selectionUpdateTimerRef.current = window.setTimeout(() => {
      selectionUpdateTimerRef.current = null;
      handleTextSelection(e);
    }, 80);
  }, [handleTextSelection]);

  // Add listeners for text selection. iPad selection handles don't reliably emit mouseup.
  useEffect(() => {
    document.addEventListener('mouseup', scheduleTextSelectionCheck);
    document.addEventListener('keyup', scheduleTextSelectionCheck);
    document.addEventListener('pointerup', scheduleTextSelectionCheck);
    document.addEventListener('touchend', scheduleTextSelectionCheck, { passive: true });
    document.addEventListener('selectionchange', scheduleTextSelectionCheck);
    window.addEventListener('scroll', scheduleTextSelectionCheck, true);

    return () => {
      document.removeEventListener('mouseup', scheduleTextSelectionCheck);
      document.removeEventListener('keyup', scheduleTextSelectionCheck);
      document.removeEventListener('pointerup', scheduleTextSelectionCheck);
      document.removeEventListener('touchend', scheduleTextSelectionCheck);
      document.removeEventListener('selectionchange', scheduleTextSelectionCheck);
      window.removeEventListener('scroll', scheduleTextSelectionCheck, true);
      if (selectionUpdateTimerRef.current) {
        window.clearTimeout(selectionUpdateTimerRef.current);
        selectionUpdateTimerRef.current = null;
      }
    };
  }, [scheduleTextSelectionCheck]);

  const applyPointerDragSelectionFallback = useCallback((
    gesture: DragSelectionGesture,
    endX: number,
    endY: number,
  ) => {
    const deltaX = Math.abs(endX - gesture.startX);
    const deltaY = Math.abs(endY - gesture.startY);
    if (deltaX < 4 && deltaY < 4) return false;

    const startRange = getCaretRangeFromPoint(gesture.startX, gesture.startY);
    const endRange = getCaretRangeFromPoint(endX, endY);
    if (!startRange || !endRange) return false;

    const range = document.createRange();
    const startsBeforeEnd = startRange.compareBoundaryPoints(Range.START_TO_START, endRange) <= 0;

    try {
      if (startsBeforeEnd) {
        range.setStart(startRange.startContainer, startRange.startOffset);
        range.setEnd(endRange.startContainer, endRange.startOffset);
      } else {
        range.setStart(endRange.startContainer, endRange.startOffset);
        range.setEnd(startRange.startContainer, startRange.startOffset);
      }
    } catch {
      return false;
    }

    if (!range.toString().trim() || !isSelectionInsideReader(range)) {
      return false;
    }

    const selection = window.getSelection();
    if (!selection) return false;

    try {
      isProgrammaticSelectionActiveRef.current = true;
      selectionFallbackHoldUntilRef.current = Date.now() + 800;
      selection.removeAllRanges();
      selection.addRange(range);
      handleTextSelection();
      return true;
    } catch {
      return false;
    }
  }, [getCaretRangeFromPoint, handleTextSelection, isSelectionInsideReader]);

  const finishMouseSelectionFallback = useCallback((
    gesture: DragSelectionGesture,
    endX: number,
    endY: number,
  ) => {
    window.setTimeout(() => {
      if (window.getSelection()?.toString().trim()) return;
      if (applyPointerDragSelectionFallback(gesture, endX, endY)) return;

      const element = getSelectableTextElement(gesture.target);
      if (element) {
        selectTextElementForAi(element);
      }
    }, 0);
  }, [applyPointerDragSelectionFallback, getSelectableTextElement, selectTextElementForAi]);

  const handleReaderMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    mouseDragSelectionRef.current = null;
    isProgrammaticSelectionActiveRef.current = false;
    selectionFallbackHoldUntilRef.current = 0;

    if (event.button !== 0 || shouldIgnoreSwipeTarget(event.target)) {
      return;
    }

    const selectableElement = getSelectableTextElement(event.target);
    if (selectableElement) {
      mouseDragSelectionRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        target: event.target,
      };
    } else {
      clearSelectedTextState();
    }
  }, [clearSelectedTextState, getSelectableTextElement, shouldIgnoreSwipeTarget]);

  const handleReaderMouseUp = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const gesture = mouseDragSelectionRef.current;
    mouseDragSelectionRef.current = null;

    if (!gesture || shouldIgnoreSwipeTarget(event.target)) return;
    finishMouseSelectionFallback(gesture, event.clientX, event.clientY);
  }, [finishMouseSelectionFallback, shouldIgnoreSwipeTarget]);

  const handleReaderPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    pointerDragSelectionRef.current = null;
    isProgrammaticSelectionActiveRef.current = false;
    selectionFallbackHoldUntilRef.current = 0;

    if (event.button !== 0 || shouldIgnoreSwipeTarget(event.target)) {
      pointerTapRef.current = null;
      return;
    }

    const selectableElement = getSelectableTextElement(event.target);
    if (event.pointerType !== 'touch' && selectableElement) {
      pointerDragSelectionRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        target: event.target,
      };
    } else if (!selectableElement) {
      clearSelectedTextState();
    }

    if (!isTouchSelectionDevice) {
      pointerTapRef.current = null;
      return;
    }

    pointerTapRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      target: event.target,
    };
  }, [clearSelectedTextState, getSelectableTextElement, isTouchSelectionDevice, shouldIgnoreSwipeTarget]);

  const handleReaderPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragGesture = pointerDragSelectionRef.current;
    pointerDragSelectionRef.current = null;

    if (
      dragGesture &&
      dragGesture.pointerId === event.pointerId &&
      event.pointerType !== 'touch' &&
      !shouldIgnoreSwipeTarget(event.target)
    ) {
      const endX = event.clientX;
      const endY = event.clientY;

      finishMouseSelectionFallback(dragGesture, endX, endY);
    }

    const gesture = pointerTapRef.current;
    pointerTapRef.current = null;

    if (!isTouchSelectionDevice || !gesture || shouldIgnoreSwipeTarget(event.target)) return;

    const deltaX = Math.abs(event.clientX - gesture.startX);
    const deltaY = Math.abs(event.clientY - gesture.startY);
    if (deltaX > 8 || deltaY > 8) return;

    const target = gesture.target;
    window.setTimeout(() => {
      const nativeSelectionText = window.getSelection()?.toString().trim();
      if (nativeSelectionText && nativeSelectionText !== selectedText) return;

      const element = getSelectableTextElement(target);
      if (element) {
        selectTextElementForAi(element);
      }
    }, 120);
  }, [
    getSelectableTextElement,
    isTouchSelectionDevice,
    finishMouseSelectionFallback,
    selectedText,
    selectTextElementForAi,
    shouldIgnoreSwipeTarget,
  ]);

  // Open AI panel with current selection
  const handleAskAi = () => {
    if (!textFeaturesAvailable) return;
    isAiPanelOpenRef.current = true;
    setIsAiPanelOpen(true);
    setSelectionPosition(null);
    // Clear native selection - custom highlight will persist
    window.getSelection()?.removeAllRanges();
  };

  // Clear selection when AI panel closes
  const handleClearSelection = () => {
    setSelectedText('');
    setSelectionPosition(null);
    clearHighlight();
    clearSelectedElementHighlight();
    highlightRangeRef.current = null;
    window.getSelection()?.removeAllRanges();
  };



  const renderedPageData = renderedPageNumbers.map((pageNumber) => pages[pageNumber]);
  const renderedPagesSignature = renderedPageData
    .map((pageData, index) => [
      renderedPageNumbers[index],
      pageData?.original_text?.length ?? 0,
      pageData?.translated_text?.length ?? 0,
      pageData?.translation_status ?? 'missing',
    ].join(':'))
	    .join('|');
  const prepareEpubHtml = sanitizeEpubHtml;

  const normalizeTitle = useCallback((text: string): string => (
    text
      .replace(/\s+/g, ' ')
      .replace(/^[\s\d.、:：Chapter章节第部篇一二三四五六七八九十]+/, '')
      .trim()
  ), []);

  const getMappedTocTitle = useCallback((title: string): string | null => {
    const normalized = title.trim().toLowerCase().replace(/[‘’]/g, "'");
    return FRONT_MATTER_TITLE_MAP[normalized] ?? null;
  }, []);

  const extractChineseTitlesFromPage = useCallback((pageData?: BookPage): string[] => {
    const translatedText = pageData?.translated_text;
    if (!translatedText) return [];

    if (typeof document !== 'undefined' && translatedText.includes('<')) {
      const container = document.createElement('div');
      container.innerHTML = translatedText;
      const headingTitles = Array.from(container.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .map((node) => normalizeTitle(node.textContent || ''))
        .filter((title) => CJK_TEXT_PATTERN.test(title));

      if (headingTitles.length > 0) {
        return headingTitles;
      }
    }

    return translatedText
      .split(/\n+/)
      .map((line) => normalizeTitle(getVisibleText(line)))
      .filter((line) => CJK_TEXT_PATTERN.test(line) && line.length >= 2 && line.length <= 36)
      .slice(0, 3);
  }, [normalizeTitle]);

  const buildLocalizedToc = useCallback((
    toc: TOCEntry[] | null,
    pageMap: Record<number, BookPage>,
  ): TOCEntry[] | null => {
    if (!toc) return null;

    const pageTitleCache = new Map<number, string[]>();
    const pageTitleUsage = new Map<number, number>();

    const getLocalizedTitle = (entry: TOCEntry): string => {
      const mappedTitle = getMappedTocTitle(entry.title);
      if (mappedTitle) return mappedTitle;

      if (!entry.pageNumber) return entry.title;

      if (!pageTitleCache.has(entry.pageNumber)) {
        pageTitleCache.set(entry.pageNumber, extractChineseTitlesFromPage(pageMap[entry.pageNumber]));
      }

      const titles = pageTitleCache.get(entry.pageNumber) || [];
      const usedCount = pageTitleUsage.get(entry.pageNumber) || 0;
      pageTitleUsage.set(entry.pageNumber, usedCount + 1);

      return titles[usedCount] || titles[0] || entry.title;
    };

    const localizeEntries = (entries: TOCEntry[]): TOCEntry[] => entries.map((entry) => ({
      ...entry,
      title: getLocalizedTitle(entry),
      children: entry.children ? localizeEntries(entry.children) : undefined,
    }));

    return localizeEntries(toc);
  }, [extractChineseTitlesFromPage, getMappedTocTitle]);

  useEffect(() => {
    if (!currentBook || !tableOfContents || !isTocOpen) return;

    let isCancelled = false;

    const loadLocalizedToc = async () => {
      try {
        const response = await bookApi.getPages(currentBook.id);
        if (isCancelled) return;

        const allPages = response.data.data as BookPage[];
        const pageMap = allPages.reduce((acc, page) => {
          acc[page.page_number] = page;
          return acc;
        }, {} as Record<number, BookPage>);

        setLocalizedTableOfContents(buildLocalizedToc(tableOfContents, pageMap));
      } catch (error) {
        console.error('[TOC] 加载中文目录失败:', error);
        setLocalizedTableOfContents(buildLocalizedToc(tableOfContents, pages));
      }
    };

    loadLocalizedToc();

    return () => {
      isCancelled = true;
    };
  }, [buildLocalizedToc, currentBook, isTocOpen, pages, tableOfContents]);

  const updatePageMetrics = useCallback(() => {
    const viewport = pageViewportRef.current;
    const content = pageContentRef.current;
    if (!viewport || !content) {
      setIsPageMetricsReady(true);
      return;
    }

    const viewportWidth = viewport.clientWidth;
    if (viewportWidth <= 0) {
      setIsPageMetricsReady(true);
      return;
    }

    setPageColumnWidth(viewportWidth);

    window.requestAnimationFrame(() => {
      const totalWidth = content.scrollWidth;
      const columnStride = viewportWidth + PAGE_COLUMN_GAP;
      const nextSegmentCount = Math.max(
        1,
        Math.ceil(Math.max(0, totalWidth - viewportWidth) / columnStride) + 1,
      );

      setPageSegmentCount(nextSegmentCount);
      setPageColumnStride(columnStride);
      setPageSegmentIndex((index) => Math.min(index, nextSegmentCount - 1));
      setIsPageMetricsReady(true);
    });
  }, []);

  useEffect(() => {
    if (isPdfOriginalMode) {
      setPageSegmentCount(1);
      setPageSegmentIndex(0);
      setIsPageMetricsReady(true);
      return;
    }

    const viewport = pageViewportRef.current;
    if (!viewport) return;

    setIsPageMetricsReady(false);
    const rafId = window.requestAnimationFrame(updatePageMetrics);
    const resizeObserver = new ResizeObserver(updatePageMetrics);
    resizeObserver.observe(viewport);

    return () => {
      window.cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
    };
  }, [
    currentPage,
    isFullscreen,
    readingMode,
    renderedPagesSignature,
    showReaderHeader,
    isPdfOriginalMode,
    updatePageMetrics,
  ]);

  useEffect(() => {
    if (isPdfOriginalMode) {
      setIsPageMetricsReady(true);
      return;
    }

    const content = pageContentRef.current;
    if (!content) return;

    let isActive = true;
    let rafId = 0;
    const scheduleMetricsUpdate = () => {
      if (!isActive) return;
      setIsPageMetricsReady(false);
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      rafId = window.requestAnimationFrame(updatePageMetrics);
    };

    const images = Array.from(content.querySelectorAll('img')) as HTMLImageElement[];
    images.forEach((image) => {
      image.addEventListener('load', scheduleMetricsUpdate);
      image.addEventListener('error', scheduleMetricsUpdate);

      if (image.complete) {
        scheduleMetricsUpdate();
      } else if (typeof image.decode === 'function') {
        image.decode().then(scheduleMetricsUpdate).catch(() => {
          // The load/error listeners above still cover failed image decodes.
        });
      }
    });

    scheduleMetricsUpdate();

    return () => {
      isActive = false;
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
      images.forEach((image) => {
        image.removeEventListener('load', scheduleMetricsUpdate);
        image.removeEventListener('error', scheduleMetricsUpdate);
      });
    };
  }, [isPdfOriginalMode, readingMode, renderedPagesSignature, updatePageMetrics]);

  const readerTextStyle: CSSProperties = {
    fontSize: `${fontSize}px`,
    lineHeight: lineHeight || '1.95',
    wordSpacing: '0.05em',
    letterSpacing: '0.02em',
    color: 'var(--reader-text)',
  };

  const renderOriginalContent = (
    pageData: BookPage | undefined,
    pageNumber = currentPage,
    isContinuation = false,
  ) => {
    if (!currentBook) return null;

    if (isPdf) {
      return <PdfReaderPane fileUrl={pdfFileUrl} pageNumber={pageNumber} />;
    }

    if (!pageData?.original_text) {
      if (isContinuation) return null;
      return (
        <div className="reader-page-status">
          <Loader size={32} className="animate-spin reader-accent-text" />
          <span className="reader-muted ml-3">加载中...</span>
        </div>
      );
    }

    if (isEpub && pageData.original_text.includes('<') && hasRenderableEpubContent(pageData.original_text)) {
      return (
        <div
          className="epub-container cursor-text"
          style={readerTextStyle}
          dangerouslySetInnerHTML={{ __html: prepareEpubHtml(pageData.original_text) }}
        />
      );
    }

    return (
      <p className="whitespace-pre-wrap leading-relaxed cursor-text" style={readerTextStyle}>
        {getVisibleText(pageData.original_text) || '（此页为索引导航页，无可读内容）'}
      </p>
    );
  };

  const renderTranslatedContent = (
    pageData: BookPage | undefined,
    pageNumber = currentPage,
    isContinuation = false,
  ) => {
    if (!pageData) {
      if (isContinuation) return null;
      return (
        <div className="reader-page-status">
          <Loader size={40} className="mb-4 animate-spin reader-accent-text" />
          <p className="reader-muted text-center">页面加载中...</p>
        </div>
      );
    }

    if (isPdf && (!pageData.original_text.trim() || pageData.translation_status === 'skipped')) {
      if (isContinuation) return null;
      return (
        <div className="reader-page-status flex-col py-16">
          <BookOpen size={40} className="mb-4 reader-muted" />
          <h3 className="text-lg font-semibold mb-2 text-center" style={{ color: 'var(--reader-text)' }}>
            此页未检测到可提取文字
          </h3>
          <p className="reader-muted max-w-sm text-center text-sm">
            该物理页已跳过翻译。请切换到原文查看 PDF 页面。
          </p>
        </div>
      );
    }

    if (pageData.translated_text && pageData.translated_text.includes('<') && isEpub && hasRenderableEpubContent(pageData.translated_text)) {
      return (
        <div
          className="epub-container cursor-text"
          style={readerTextStyle}
          dangerouslySetInnerHTML={{ __html: prepareEpubHtml(pageData.translated_text) }}
        />
      );
    }

    if (pageData.translated_text) {
      return (
        <p className="whitespace-pre-wrap leading-relaxed cursor-text" style={readerTextStyle}>
          {getVisibleText(pageData.translated_text) || pageData.translated_text}
        </p>
      );
    }

    if (pageData.translation_status === 'translating') {
      if (isContinuation) return null;
      return (
        <div className="reader-page-status flex-col py-16">
          <div className="mb-6 relative">
            <div className="absolute inset-0 bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full blur-lg opacity-50 animate-pulse"></div>
            <div className="relative bg-gradient-to-br from-blue-600 to-cyan-600 rounded-full p-6 shadow-2xl">
              <div className="text-white">AI</div>
            </div>
          </div>
          <h3 className="text-xl font-bold mb-2 text-center" style={{ color: 'var(--reader-text)' }}>
            AI 正在翻译中
          </h3>
          <p className="reader-muted text-center mb-6 max-w-sm">
            正在处理第 {pageNumber} 页，完成后会自动显示译文。
          </p>
          <div className="flex items-center gap-1 mb-6">
            <div className="w-2 h-8 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0s' }}></div>
            <div className="w-2 h-8 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
            <div className="w-2 h-8 bg-blue-700 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }}></div>
            <div className="w-2 h-8 bg-cyan-600 rounded-full animate-bounce" style={{ animationDelay: '0.6s' }}></div>
          </div>
          <div className="reader-tip rounded-lg p-4 max-w-sm">
            <p className="text-xs text-center leading-relaxed reader-accent-text">
              可先切换到原文，或继续翻到其他页面阅读。
            </p>
          </div>
        </div>
      );
    }

    if (pageData.translation_status === 'failed') {
      if (isContinuation) return null;
      return (
        <div className="reader-page-status flex-col py-12">
          <div className="text-4xl mb-4">!</div>
          <p className="text-red-600 dark:text-red-400 text-center font-semibold mb-2">
            翻译失败
          </p>
          <p className="reader-muted text-center text-sm mb-6">
            网络出现问题，请稍后重试
          </p>
          <button
            onClick={handleRetryTranslation}
            disabled={isRetrying}
            className="reader-primary-button mb-6 px-6 py-2 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center gap-2"
          >
            {isRetrying ? (
              <>
                <Loader size={18} className="animate-spin" />
                重新尝试中...
              </>
            ) : (
              <>重新翻译</>
            )}
          </button>
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
            <p className="text-xs text-red-700 dark:text-red-300">
              如果问题持续，请检查网络连接。
            </p>
          </div>
        </div>
      );
    }

    if (isContinuation) return null;

    return (
      <div className="reader-page-status flex-col py-16">
        <AlertCircle size={40} className="mb-4 reader-accent-text" />
        <h3 className="text-lg font-semibold mb-2 text-center" style={{ color: 'var(--reader-text)' }}>
          此页暂无译文
        </h3>
        <p className="reader-muted text-center text-sm max-w-xs">
          第 {pageNumber} 页尚未完成翻译，可切换到原文阅读，或回到书架启动一键全本翻译。
        </p>
        <button
          onClick={handleNavigateHome}
          className="mt-5 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors"
          style={{
            background: 'var(--reader-button-active-bg)',
            color: 'var(--reader-button-active-text)',
          }}
        >
          <Home size={16} />
          返回书架
        </button>
      </div>
    );
  };

  const canGoPrevious = isPageMetricsReady && (currentPage > 1 || pageSegmentIndex > 0);
  const canGoNext = isPageMetricsReady && !!currentBook && (currentPage < currentBook.total_pages || pageSegmentIndex < pageSegmentCount - 1);
  const pageOffset = pageSegmentIndex * (pageColumnStride || pageColumnWidth + PAGE_COLUMN_GAP);
  const pageSegmentLabel = pageSegmentCount > 1 ? ` · 屏 ${pageSegmentIndex + 1}/${pageSegmentCount}` : '';

  if (!currentBook) {
    return (
      <div className="h-screen flex flex-col items-center justify-center bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800">
        <Home size={48} className="text-gray-400 mb-4" />
        <p className="text-xl text-gray-600 dark:text-gray-400">请选择一本书开始阅读</p>
      </div>
    );
  }

  return (
    <div className="reader-shell h-screen flex flex-col" style={readerThemeStyle}>
      {/* Header - 单行合并工具栏 */}
      {showReaderHeader && (
        <div className="reader-header px-3 py-1.5 shadow-sm">
          <div className="flex items-center gap-2">
            {/* 左侧：导航和功能按钮 */}
            <div className="flex items-center gap-1">
              <button
                onClick={handleNavigateHome}
                className="reader-icon-button p-1.5 rounded-lg transition-colors"
                title="返回首页"
                aria-label="返回首页"
              >
                <Home size={18} />
              </button>
              <button
                onClick={handleNavigateSettings}
                className="reader-icon-button p-1.5 rounded-lg transition-colors"
                title="模型服务设置"
                aria-label="模型服务设置"
              >
                <Settings size={18} />
              </button>
              {tableOfContents && (
                <button
                  onClick={() => setIsTocOpen(!isTocOpen)}
                  className="reader-icon-button p-1.5 rounded-lg transition-colors"
                  title="打开目录"
                  aria-label="打开目录"
                >
                  <Menu size={18} />
                </button>
              )}
              <div className="w-px h-5 mx-0.5 reader-separator" />
              <button
                onClick={handleToggleReadingMode}
                disabled={!textFeaturesAvailable}
                className={`p-1.5 rounded-lg transition-colors ${
                  readingMode === 'original'
                    ? 'reader-icon-button reader-icon-button-active'
                    : 'reader-icon-button'
                } disabled:cursor-not-allowed disabled:opacity-40`}
                title={!textFeaturesAvailable
                  ? '扫描版 PDF 未检测到可提取文字，仅支持原版阅读'
                  : readingMode === 'translated' ? '切换到原文单栏' : '切换到译文单栏'}
                aria-label={readingMode === 'translated' ? '切换到原文单栏' : '切换到译文单栏'}
              >
                {readingMode === 'translated' ? (
                  <Languages size={18} />
                ) : (
                  <BookOpen size={18} />
                )}
              </button>
              {isPdf && currentBook.text_extraction_status !== 'ready' && (
                <span
                  className={`ml-1 rounded-full border px-2 py-1 text-[10px] font-semibold ${
                    currentBook.text_extraction_status === 'unavailable'
                      ? 'border-slate-400/40 bg-slate-500/15 reader-muted'
                      : 'border-amber-400/40 bg-amber-400/10 text-amber-600'
                  }`}
                  title={currentBook.text_extraction_status === 'unavailable'
                    ? '未检测到可提取文字，翻译和 AI 功能不可用'
                    : `检测到 ${currentBook.text_page_count}/${currentBook.total_pages} 页文字，空白页将自动跳过`}
                >
                  {currentBook.text_extraction_status === 'unavailable' ? '扫描版，仅可阅读' : '部分页面无文字'}
                </span>
              )}
              <div className="ml-2 flex items-center gap-1.5 rounded-full px-1.5 py-1 reader-theme-switch">
                {readerThemeOptions.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setReaderTheme(id)}
                    className={`reader-theme-chip px-2.5 py-1.5 rounded-full text-xs font-medium transition-colors ${
                      readerTheme === id ? 'reader-theme-chip-active' : ''
                    }`}
                    title={`切换到${label}主题`}
                    aria-label={`切换到${label}主题`}
                  >
                    <span className="flex items-center gap-1.5">
                      <Icon size={14} />
                      {label}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* 中间：进度条和页码 */}
            <div className="flex items-center gap-3 flex-1 mx-4">
              <div className="reader-progress-track flex-1 h-1.5 rounded-full overflow-hidden">
                <div
                  className="reader-progress-fill h-full transition-all duration-300 rounded-full"
                  style={{
                    width: `${(currentPage / currentBook.total_pages) * 100}%`,
                  }}
                />
              </div>
              <span className="reader-muted text-sm font-medium whitespace-nowrap">
                {currentPage} / {currentBook.total_pages}
              </span>
            </div>

            {/* 右侧：摘要、AI助手、全屏、隐藏 */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setIsSummaryPanelOpen(true)}
                disabled={!textFeaturesAvailable}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium transition-all duration-200 bg-gradient-to-r from-teal-500 to-cyan-500 text-white shadow-sm hover:shadow-md hover:from-teal-600 hover:to-cyan-600 hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:from-slate-400 disabled:to-slate-400 disabled:opacity-50 disabled:hover:scale-100"
                title={textFeaturesAvailable ? '智能摘要' : '扫描版 PDF 未检测到可提取文字'}
                aria-label="智能摘要"
              >
                <FileText size={14} />
                <span>摘要</span>
              </button>
              <button
                onClick={() => setIsMindMapPanelOpen(true)}
                disabled={!textFeaturesAvailable}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium transition-all duration-200 bg-gradient-to-r from-blue-500 to-purple-500 text-white shadow-sm hover:shadow-md hover:from-blue-600 hover:to-purple-600 hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:from-slate-400 disabled:to-slate-400 disabled:opacity-50 disabled:hover:scale-100"
                title={textFeaturesAvailable ? '思维导图' : '扫描版 PDF 未检测到可提取文字'}
                aria-label="思维导图"
              >
                <Network size={14} />
                <span>导图</span>
              </button>
              <button
                onClick={() => { isAiPanelOpenRef.current = true; setIsAiPanelOpen(true); }}
                disabled={!textFeaturesAvailable}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium transition-all duration-200 bg-gradient-to-r from-violet-500 to-indigo-500 text-white shadow-sm hover:shadow-md hover:from-violet-600 hover:to-indigo-600 hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:from-slate-400 disabled:to-slate-400 disabled:opacity-50 disabled:hover:scale-100"
                title={textFeaturesAvailable ? 'AI 问答助手 (⌘J)' : '扫描版 PDF 未检测到可提取文字'}
                aria-label="AI 问答助手"
              >
                <Sparkles size={14} />
                <span>AI</span>
              </button>
              <div className="w-px h-5 mx-0.5 reader-separator" />
              <button
                onClick={toggleFullscreen}
                className="reader-icon-button p-1.5 rounded-lg transition-colors"
                title={isFullscreen ? "退出全屏阅读 (F)" : "进入全屏阅读 (F)"}
                aria-label={isFullscreen ? "退出全屏阅读" : "进入全屏阅读"}
              >
                {isFullscreen ? (
                  <Minimize2 size={18} />
                ) : (
                  <Maximize2 size={18} />
                )}
              </button>
              <button
                onClick={() => setShowReaderHeader(false)}
                className="reader-icon-button p-1.5 rounded-lg transition-colors"
                title="隐藏工具栏（点击页面顶部显示）"
                aria-label="隐藏工具栏"
              >
                <X size={18} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Show header trigger - appears at top when header is hidden */}
      {!showReaderHeader && (
        <div
          onClick={() => setShowReaderHeader(true)}
          className="reader-header-trigger h-2 cursor-pointer transition-colors"
          title="点击显示阅读头部"
        />
      )}

	      {/* Reader content */}
	      <div className="reader-reading-stage flex-1 overflow-hidden px-2 py-2 sm:px-4" ref={readerContainerRef}>
	        <div
	          className="reader-single-panel reader-panel relative group h-full w-full mx-auto overflow-hidden rounded-2xl shadow-sm"
	          onMouseDown={handleReaderMouseDown}
	          onMouseUp={handleReaderMouseUp}
	          onPointerDown={handleReaderPointerDown}
	          onPointerUp={handleReaderPointerUp}
	          onTouchStart={handleReaderTouchStart}
	          onTouchEnd={handleReaderTouchEnd}
	        >
		          <div className="reader-page-viewport-shell h-full">
                {isPdfOriginalMode ? (
                  <div ref={pageContentRef} className="h-full w-full">
                    <PdfReaderPane fileUrl={pdfFileUrl} pageNumber={currentPage} />
                  </div>
                ) : (
		            <div ref={pageViewportRef} className="reader-page-viewport h-full overflow-hidden">
	              <div
	                ref={pageContentRef}
	                className={`reader-page-flow prose-custom h-full ${isTouchSelectionDevice ? 'reader-page-flow-touch' : ''}`}
	                style={{
	                  columnWidth: pageColumnWidth ? `${pageColumnWidth}px` : undefined,
	                  columnGap: `${PAGE_COLUMN_GAP}px`,
	                  width: pageColumnWidth ? `${pageColumnWidth}px` : undefined,
	                  marginLeft: isTouchSelectionDevice ? `-${pageOffset}px` : undefined,
	                  transform: isTouchSelectionDevice ? undefined : `translate3d(-${pageOffset}px, 0, 0)`,
	                  transition: isPageFlowTransitionSuppressed ? 'none' : undefined,
	                }}
	              >
                {renderedPageNumbers.map((pageNumber, index) => {
                  const pageData = pages[pageNumber];
                  return (
                    <section key={pageNumber} className="reader-book-page" data-page-number={pageNumber}>
                      {readingMode === 'translated'
                        ? renderTranslatedContent(pageData, pageNumber, index > 0)
                        : renderOriginalContent(pageData, pageNumber, index > 0)}
                    </section>
                  );
	                })}
	              </div>
	            </div>
                )}
            </div>

          <button
            onClick={(e) => {
              e.stopPropagation();
              handlePreviousPage();
            }}
            disabled={!canGoPrevious}
	            className={`reader-nav-arrow absolute left-4 top-1/2 -translate-y-1/2 z-30 disabled:cursor-not-allowed rounded-full p-2.5 shadow-lg backdrop-blur-sm transition-all duration-300 opacity-0 hover:opacity-100 group-hover:opacity-100 ${
	              isTouchSelectionDevice ? 'reader-nav-arrow-touch' : ''
	            }`}
            aria-label="上一页"
          >
            <ChevronLeft size={24} />
          </button>

          <button
            onClick={(e) => {
              e.stopPropagation();
              handleNextPage();
            }}
            disabled={!canGoNext}
	            className={`reader-nav-arrow absolute right-4 top-1/2 -translate-y-1/2 z-30 disabled:cursor-not-allowed rounded-full p-2.5 shadow-lg backdrop-blur-sm transition-all duration-300 opacity-0 hover:opacity-100 group-hover:opacity-100 ${
	              isTouchSelectionDevice ? 'reader-nav-arrow-touch' : ''
	            }`}
            aria-label="下一页"
          >
            <ChevronRight size={24} />
          </button>
        </div>
      </div>

      {/* Fullscreen floating navigation - appears on hover at the bottom */}
      {isFullscreen && (
        <div
          className="fixed bottom-0 left-0 right-0 z-50 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity duration-300"
        >
          <div className="bg-gradient-to-t from-black/80 via-black/50 to-transparent pb-6 pt-16">
            <div className="flex justify-center items-center gap-8 max-w-2xl mx-auto">
              <button
                onClick={handlePreviousPage}
                disabled={!canGoPrevious}
                className="flex items-center gap-2 px-5 py-2.5 bg-white/10 backdrop-blur-md border border-white/20 text-white rounded-full hover:bg-white/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all font-medium shadow-lg"
              >
                <ChevronLeft size={18} />
                上一页
              </button>

              <div className="flex items-center gap-3">
                <span className="text-white/90 text-sm font-medium bg-white/10 backdrop-blur-md px-4 py-2 rounded-full border border-white/20">
                  {currentPage} / {currentBook.total_pages}{pageSegmentLabel}
                </span>
                <button
                  onClick={toggleFullscreen}
                  className="p-2.5 bg-white/10 backdrop-blur-md border border-white/20 text-white rounded-full hover:bg-white/20 transition-all shadow-lg"
                  title="退出全屏阅读 (F / ESC)"
                  aria-label="退出全屏阅读"
                >
                  <Minimize2 size={18} />
                </button>
              </div>

              <button
                onClick={handleNextPage}
                disabled={!canGoNext}
                className="flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-blue-500/80 to-cyan-500/80 backdrop-blur-md border border-white/20 text-white rounded-full hover:from-blue-600/90 hover:to-cyan-600/90 disabled:opacity-30 disabled:cursor-not-allowed transition-all font-medium shadow-lg"
              >
                下一页
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table of Contents Sidebar */}
      <TableOfContents
        toc={localizedTableOfContents || tableOfContents}
        isOpen={isTocOpen}
        onClose={() => setIsTocOpen(false)}
        onNavigate={handleTocNavigate}
        currentPage={currentPage}
      />

      {/* Text Selection Popup */}
      {textFeaturesAvailable && selectionPosition && selectedText && (
        <div
          data-ai-popup
          className="fixed z-50 transform -translate-x-1/2 -translate-y-full"
          style={{
            left: selectionPosition.x,
            top: selectionPosition.y,
          }}
        >
          <button
            onMouseDown={(e) => e.preventDefault()}
            onTouchStart={(e) => e.stopPropagation()}
            onClick={handleAskAi}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gradient-to-r from-violet-500 to-indigo-600 hover:from-violet-600 hover:to-indigo-700 text-white rounded-full shadow-lg shadow-violet-500/30 text-sm font-medium transition-all hover:shadow-xl hover:scale-105 active:scale-95"
          >
            <Sparkles size={14} />
            问 AI
          </button>
          <div className="absolute left-1/2 -translate-x-1/2 -bottom-1.5 w-3 h-3 bg-indigo-600 rotate-45 rounded-sm" />
        </div>
      )}

      {/* AI Chat Panel */}
      {textFeaturesAvailable && <AiChatPanel
        isOpen={isAiPanelOpen}
        onClose={() => {
          isAiPanelOpenRef.current = false;
          setIsAiPanelOpen(false);
          handleClearSelection();
        }}
        bookId={currentBook.id}
        bookTitle={currentBook.original_name}
        currentPage={currentPage}
        totalPages={currentBook.total_pages}
        selectedText={selectedText}
        onClearSelection={handleClearSelection}
        onNavigateToPage={(page) => {
          goToBookPage(page);
        }}
      />}

      {/* Summary Panel */}
      {textFeaturesAvailable && <SummaryPanel
        isOpen={isSummaryPanelOpen}
        onClose={() => setIsSummaryPanelOpen(false)}
        bookId={currentBook.id}
        bookTitle={currentBook.original_name}
        totalPages={currentBook.total_pages}
        onNavigateToPage={(page) => {
          goToBookPage(page);
        }}
      />}

      {/* MindMap Panel */}
      {textFeaturesAvailable && <MindMapPanel
        isOpen={isMindMapPanelOpen}
        onClose={() => setIsMindMapPanelOpen(false)}
        bookId={currentBook.id}
        bookTitle={currentBook.original_name}
        totalPages={currentBook.total_pages}
        onNavigateToPage={(page) => {
          goToBookPage(page);
        }}
      />}
    </div>
  );
}
