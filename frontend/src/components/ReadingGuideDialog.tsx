import { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Languages, Loader, RefreshCw, Sparkles, Square, Trash2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { Book, ReadingGuide } from '../types';
import { readingGuideApi } from '../services/api';
import { getApiErrorMessage } from '../utils/error';
import { canUseBookTextFeatures } from '../utils/bookCapabilities';
import { useTtsPlayerStore } from '../stores/useTtsPlayerStore';
import TtsSpeakButton from './TtsSpeakButton';

interface ReadingGuideDialogProps {
  book: Book | null;
  isOpen: boolean;
  onClose: () => void;
  onStartTranslation: (bookId: number) => Promise<void> | void;
  onDelete: (bookId: number) => void;
  onGuideChange?: (bookId: number, guide: ReadingGuide | null) => void;
}

const GUIDE_SECTION_TITLES = new Set([
  '一句话总览',
  '核心摘要',
  '核心观点',
  '内容脉络',
  '关键概念/方法',
  '关键概念与方法',
  '精读建议',
  '适合与不适合',
  '可信度说明',
]);

function normalizeGuideMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      const titleCandidate = trimmed
        .replace(/^(\d+|[一二三四五六七八九十]+)[.、]\s*/, '')
        .replace(/^\*\*/, '')
        .replace(/\*\*$/, '')
        .replace(/[:：]$/, '')
        .replace(/^["“”「『【[]/, '')
        .replace(/["“”」』】\]]$/, '')
        .replace(/[:：]$/, '')
        .trim();

      return GUIDE_SECTION_TITLES.has(titleCandidate) ? `## ${titleCandidate}` : line;
    })
    .join('\n');
}

export default function ReadingGuideDialog({
  book,
  isOpen,
  onClose,
  onStartTranslation,
  onDelete,
  onGuideChange,
}: ReadingGuideDialogProps) {
  const [guide, setGuide] = useState<ReadingGuide | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startingTranslation, setStartingTranslation] = useState(false);
  const [cancellingGuide, setCancellingGuide] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 全局播放器：关闭弹窗后合成与播放在后台继续，由右下角迷你播放条控制
  const tts = useTtsPlayerStore();

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const fetchGuide = useCallback(async () => {
    if (!book || !canUseBookTextFeatures(book)) return null;
    const response = await readingGuideApi.get(book.id);
    const nextGuide = response.data.data;
    setGuide(nextGuide);
    onGuideChange?.(book.id, nextGuide);
    return nextGuide;
  }, [book, onGuideChange]);

  const ensureGuide = useCallback(async (force = false) => {
    if (!book || !canUseBookTextFeatures(book)) return;

    try {
      setLoading(true);
      setError(null);

      if (!force) {
        const existingGuide = await fetchGuide();
        if (existingGuide) {
          if (existingGuide.status === 'completed' && existingGuide.guide_text) return;
          if (existingGuide.status === 'pending' || existingGuide.status === 'generating') return;
          if (existingGuide.status === 'failed' || existingGuide.status === 'cancelled') return;
        }
      }

      const response = await readingGuideApi.generate(book.id, force);
      const nextGuide = response.data.data;
      setGuide(nextGuide);
      onGuideChange?.(book.id, nextGuide);
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, '生成解读失败'));
    } finally {
      setLoading(false);
    }
  }, [book, fetchGuide, onGuideChange]);

  useEffect(() => {
    if (!isOpen || !book) {
      clearPoll();
      return;
    }

    void ensureGuide(false);

    return () => {
      clearPoll();
    };
  }, [isOpen, book, ensureGuide, clearPoll]);

  useEffect(() => {
    if (!isOpen || !book || !guide || !['pending', 'generating'].includes(guide.status)) {
      clearPoll();
      return;
    }

    clearPoll();
    pollRef.current = setInterval(async () => {
      try {
        const nextGuide = await fetchGuide();
        if (!nextGuide || ['completed', 'failed', 'cancelled'].includes(nextGuide.status)) {
          clearPoll();
        }
      } catch (err: unknown) {
        clearPoll();
        setError(getApiErrorMessage(err, '读取解读状态失败'));
      }
    }, 2500);

    return () => {
      clearPoll();
    };
  }, [isOpen, book, guide, fetchGuide, clearPoll]);

  const handleStartTranslation = async () => {
    if (!book || startingTranslation) return;

    try {
      setStartingTranslation(true);
      await onStartTranslation(book.id);
      onClose();
    } finally {
      setStartingTranslation(false);
    }
  };

  const handleCancelGuide = async () => {
    if (!book || cancellingGuide) return;

    try {
      setCancellingGuide(true);
      setError(null);
      const response = await readingGuideApi.cancel(book.id);
      const nextGuide = response.data.data;
      setGuide(nextGuide);
      onGuideChange?.(book.id, nextGuide);
      clearPoll();
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, '取消AI摘要失败'));
    } finally {
      setCancellingGuide(false);
    }
  };

  const handleDelete = () => {
    if (!book) return;
    onDelete(book.id);
    onClose();
  };

  if (!isOpen || !book) return null;

  const guideIsActive = guide?.status === 'pending' || guide?.status === 'generating';
  const textFeaturesAvailable = canUseBookTextFeatures(book);
  const isReadingGuide = loading && !guideIsActive && !guide?.guide_text;
  const isGenerating = guideIsActive;
  const canTranslate = textFeaturesAvailable && !loading && !isGenerating && !startingTranslation;
  const renderedGuideText = guide?.guide_text ? normalizeGuideMarkdown(guide.guide_text) : '';

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
        aria-label="关闭AI摘要"
      />

      <div className="fixed inset-0 z-40 flex items-center justify-center p-4 pointer-events-none">
        <div
          className="pointer-events-auto flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reading-guide-title"
        >
          <div className="flex items-start justify-between gap-4 border-b border-gray-200 bg-gradient-to-b from-white to-slate-50 px-6 py-5 sm:px-8">
            <div className="flex min-w-0 items-start gap-4">
              <div className="mt-0.5 flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white shadow-lg shadow-blue-600/20">
                <Sparkles size={22} />
              </div>
              <div className="min-w-0">
                <h2 id="reading-guide-title" className="text-2xl font-bold tracking-tight text-gray-950">
                  AI摘要
                </h2>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-gray-500">
                  <span className="inline-flex max-w-[680px] items-center gap-1.5 truncate rounded-full bg-gray-100 px-3 py-1.5">
                    <BookOpen size={12} />
                    <span className="truncate">{book.original_name}</span>
                  </span>
                  <span className="rounded-full bg-gray-100 px-3 py-1.5">{book.total_pages} 页</span>
                </div>
              </div>
            </div>
            <div className="flex flex-shrink-0 items-center gap-1">
              {guide?.status === 'completed' && (
                <TtsSpeakButton
                  player={tts}
                  ttsId={`guide:${book.id}`}
                  text={guide.guide_text}
                  ariaLabel="朗读AI摘要"
                  label={`AI摘要 · ${book.original_name}`}
                  size={16}
                  accent="blue"
                  variant="labeled"
                />
              )}
              {tts.activeId != null && tts.status !== 'idle' && (
                <button
                  onClick={() => tts.stop()}
                  aria-label="停止朗读"
                  title="停止朗读"
                  className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-500"
                >
                  <Square size={18} />
                </button>
              )}
              <button
                onClick={onClose}
                className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                aria-label="关闭"
              >
                <X size={20} />
              </button>
            </div>
          </div>

          <div className="reading-guide-scroll flex-1 overflow-y-auto bg-slate-50/80 px-4 py-6 sm:px-8">
            {(error || tts.error) && (
              <div className="mx-auto mb-4 max-w-4xl rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error || tts.error}
              </div>
            )}

            {!textFeaturesAvailable ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                <BookOpen size={32} className="mb-3 text-slate-400" />
                <p className="text-sm font-semibold text-gray-800">扫描版 PDF，仅可原版阅读</p>
                <p className="mt-2 max-w-md text-sm text-gray-500">
                  未检测到可提取文字，因此翻译、AI摘要和其他文本能力已禁用。
                </p>
              </div>
            ) : isGenerating ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                <Loader size={28} className="mb-3 animate-spin text-blue-600" />
                <p className="text-sm font-semibold text-gray-800">正在生成AI摘要</p>
                <p className="mt-1 text-xs text-gray-500">完成后再决定是否启动中文翻译</p>
              </div>
            ) : isReadingGuide ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                <Loader size={28} className="mb-3 animate-spin text-blue-600" />
                <p className="text-sm font-semibold text-gray-800">正在读取AI摘要</p>
              </div>
            ) : guide?.status === 'failed' ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                <p className="text-sm font-semibold text-gray-800">解读生成失败</p>
                <p className="mt-2 max-w-md text-sm text-gray-500">{guide.error_message || '未知错误'}</p>
                <button
                  onClick={() => ensureGuide(true)}
                  className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
                >
                  <RefreshCw size={15} />
                  重新生成
                </button>
              </div>
            ) : guide?.status === 'cancelled' ? (
              <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                <p className="text-sm font-semibold text-gray-800">AI摘要已取消</p>
                <p className="mt-2 max-w-md text-sm text-gray-500">这本书当前没有可查看的AI摘要。</p>
                <button
                  onClick={() => ensureGuide(true)}
                  className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700"
                >
                  <RefreshCw size={15} />
                  重新生成
                </button>
              </div>
            ) : guide?.guide_text ? (
              <div className="reading-guide-paper mx-auto max-w-4xl rounded-lg border border-slate-200 bg-white px-5 py-6 shadow-sm sm:px-8 sm:py-8">
                <div className="reading-guide-markdown">
                  <ReactMarkdown>{renderedGuideText}</ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="flex min-h-[260px] flex-col items-center justify-center text-center">
                <p className="text-sm text-gray-500">尚未生成解读</p>
                <button
                  onClick={() => void ensureGuide(false)}
                  disabled={loading}
                  className="mt-5 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <RefreshCw size={15} />
                  {error ? '重试生成' : '生成AI摘要'}
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 border-t border-gray-200 bg-white px-6 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-8">
            <button
              onClick={handleDelete}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-red-200 bg-white px-4 py-2.5 text-sm font-semibold text-red-600 transition-colors hover:bg-red-50"
            >
              <Trash2 size={16} />
              删除书籍
            </button>

            <div className="flex flex-col gap-2 sm:flex-row">
              {guideIsActive && (
                <button
                  onClick={handleCancelGuide}
                  disabled={cancellingGuide}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-amber-200 bg-white px-4 py-2.5 text-sm font-semibold text-amber-700 transition-colors hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {cancellingGuide ? <Loader size={16} className="animate-spin" /> : <Square size={16} />}
                  取消AI摘要
                </button>
              )}
              <button
                onClick={onClose}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-100"
              >
                暂不翻译
              </button>
              <button
                onClick={handleStartTranslation}
                disabled={!canTranslate}
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {startingTranslation ? <Loader size={16} className="animate-spin" /> : <Languages size={16} />}
                开始中文翻译
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
