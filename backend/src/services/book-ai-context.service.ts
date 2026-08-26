import { db } from '../config/database';
import { summaryService } from './summary.service';
import {
  assertBookTextAvailable,
  isMeaningfulExtractedText,
} from './book-text-capability.service';

// Shared retrieval and prompt context for both EPUB and PDF books.

export type AiChatIntent = 'qa' | 'summarize_page' | 'explain_concepts' | 'translate_selection';
export type AiSourceReason = 'current' | 'adjacent' | 'chapter' | 'search' | 'selection';

export interface AiSource {
  pageNumber: number;
  reason: AiSourceReason;
  title?: string;
}

interface BookRow {
  id: number;
  original_name: string;
  file_type: string;
  total_pages: number;
  metadata?: string | null;
}

interface PageRow {
  page_number: number;
  original_text: string;
  translated_text: string | null;
}

interface ChapterRange {
  id: string;
  title: string;
  pageStart: number;
  pageEnd: number;
  isContent: boolean;
}

export interface BookAiContext {
  book: BookRow;
  author: string;
  currentChapter?: ChapterRange;
  contextText: string;
  sources: AiSource[];
  selectedText?: string;
}

const SOURCE_PRIORITY: Record<AiSourceReason, number> = {
  selection: 0,
  current: 1,
  adjacent: 2,
  chapter: 3,
  search: 4,
};

const AI_SEARCH_INDEX_VERSION = 2;

const STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'book', 'chapter', 'does', 'from',
  'have', 'into', 'page', 'that', 'the', 'this', 'what', 'when', 'where',
  'which', 'with', 'you', 'your',
]);

function tableExists(tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(tableName)
  );
}

function decodeHtmlEntities(text: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return text
    .replace(/&#(\d+);/g, (_match, code) => {
      const value = Number.parseInt(code, 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : ' ';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const value = Number.parseInt(code, 16);
      return Number.isFinite(value) ? String.fromCodePoint(value) : ' ';
    })
    .replace(/&([a-z]+);/gi, (match, name) => namedEntities[name.toLowerCase()] ?? match);
}

export function cleanBookText(input: string | null | undefined): string {
  if (!input) return '';

  const withBreaks = input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<[^>]*epub:type=["']pagebreak["'][^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|section|article|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return decodeHtmlEntities(withBreaks)
    .replace(/\r/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trim()}...`;
}

function getAuthor(book: BookRow): string {
  if (!book.metadata) return '未知作者';
  try {
    const metadata = JSON.parse(book.metadata);
    return metadata.author || metadata.creator || '未知作者';
  } catch {
    return '未知作者';
  }
}

function getPageWithTranslation(bookId: number, pageNumber: number): PageRow | undefined {
  return db.prepare(`
    SELECT
      p.page_number,
      p.original_text,
      COALESCE(p.translated_text, pc.translated_text) as translated_text
    FROM pages p
    LEFT JOIN page_cache pc ON pc.id = (
      SELECT pc2.id FROM page_cache pc2
      WHERE pc2.page_hash = p.page_hash
      ORDER BY pc2.updated_at DESC, pc2.id DESC
      LIMIT 1
    )
    WHERE p.book_id = ? AND p.page_number = ?
  `).get(bookId, pageNumber) as PageRow | undefined;
}

function getPagesWithTranslation(bookId: number, pageNumbers: number[]): PageRow[] {
  const uniquePageNumbers = [...new Set(pageNumbers)].filter((page) => page > 0);
  if (uniquePageNumbers.length === 0) return [];

  const placeholders = uniquePageNumbers.map(() => '?').join(',');
  return db.prepare(`
    SELECT
      p.page_number,
      p.original_text,
      COALESCE(p.translated_text, pc.translated_text) as translated_text
    FROM pages p
    LEFT JOIN page_cache pc ON pc.id = (
      SELECT pc2.id FROM page_cache pc2
      WHERE pc2.page_hash = p.page_hash
      ORDER BY pc2.updated_at DESC, pc2.id DESC
      LIMIT 1
    )
    WHERE p.book_id = ? AND p.page_number IN (${placeholders})
    ORDER BY p.page_number
  `).all(bookId, ...uniquePageNumbers) as PageRow[];
}

function getContentFingerprint(bookId: number): { pageCount: number; fingerprint: string } {
  const row = db.prepare(`
    SELECT
      COUNT(*) as page_count,
      COALESCE(MAX(p.updated_at), '') as pages_updated_at,
      COALESCE(MAX(pc.updated_at), '') as cache_updated_at
    FROM pages p
    LEFT JOIN page_cache pc ON pc.id = (
      SELECT pc2.id FROM page_cache pc2
      WHERE pc2.page_hash = p.page_hash
      ORDER BY pc2.updated_at DESC, pc2.id DESC
      LIMIT 1
    )
    WHERE p.book_id = ?
  `).get(bookId) as { page_count: number; pages_updated_at: string; cache_updated_at: string };

  return {
    pageCount: row.page_count,
    fingerprint: `${AI_SEARCH_INDEX_VERSION}:${row.page_count}:${row.pages_updated_at}:${row.cache_updated_at}`,
  };
}

function getPagesForIndex(bookId: number): PageRow[] {
  return db.prepare(`
    SELECT
      p.page_number,
      p.original_text,
      COALESCE(p.translated_text, pc.translated_text) as translated_text
    FROM pages p
    LEFT JOIN page_cache pc ON pc.id = (
      SELECT pc2.id FROM page_cache pc2
      WHERE pc2.page_hash = p.page_hash
      ORDER BY pc2.updated_at DESC, pc2.id DESC
      LIMIT 1
    )
    WHERE p.book_id = ?
    ORDER BY p.page_number
  `).all(bookId) as PageRow[];
}

function extractSearchTerms(text: string): string[] {
  const matches = cleanBookText(text).toLowerCase().match(/[a-z0-9]{3,}|[\u3400-\u9fff]{2,}/g) || [];
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const match of matches) {
    if (STOP_WORDS.has(match) || seen.has(match)) continue;
    seen.add(match);
    terms.push(match);
    if (terms.length >= 8) break;
  }

  return terms;
}

function buildFtsQuery(text: string): string | null {
  const terms = extractSearchTerms(text);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

function buildLikePatterns(text: string): string[] {
  const terms = extractSearchTerms(text);
  if (terms.length > 0) return terms.slice(0, 4).map((term) => `%${term}%`);

  const cleaned = cleanBookText(text).slice(0, 60);
  return cleaned ? [`%${cleaned}%`] : [];
}

function addSource(sources: Map<number, AiSource>, source: AiSource): void {
  const existing = sources.get(source.pageNumber);
  if (!existing || SOURCE_PRIORITY[source.reason] < SOURCE_PRIORITY[existing.reason]) {
    sources.set(source.pageNumber, source);
  }
}

function formatPageSection(title: string, page: PageRow, maxChars: number): string | null {
  const original = truncateText(cleanBookText(page.original_text), maxChars);
  const translated = truncateText(cleanBookText(page.translated_text), Math.floor(maxChars * 0.8));
  if (!original && !translated) return null;
  const lines = [`## ${title} [第 ${page.page_number} 页]`];

  if (original) {
    lines.push(`原文：\n${original}`);
  }
  if (translated) {
    lines.push(`中文译文：\n${translated}`);
  }
  return lines.join('\n\n');
}

function isUsablePageForFormat(fileType: string, page: PageRow): boolean {
  return fileType !== 'pdf' || isMeaningfulExtractedText(page.original_text);
}

export class BookAiContextService {
  ensureSearchIndex(bookId: number): boolean {
    if (!tableExists('ai_page_search') || !tableExists('ai_page_search_meta')) {
      return false;
    }

    const { pageCount, fingerprint } = getContentFingerprint(bookId);
    const meta = db.prepare(`
      SELECT page_count, content_fingerprint
      FROM ai_page_search_meta
      WHERE book_id = ?
    `).get(bookId) as { page_count: number; content_fingerprint: string } | undefined;

    if (meta && meta.page_count === pageCount && meta.content_fingerprint === fingerprint) {
      return true;
    }

    const book = db.prepare('SELECT file_type FROM books WHERE id = ?').get(bookId) as {
      file_type: string;
    } | undefined;
    if (!book) return false;
    const pages = getPagesForIndex(bookId);
    const rebuild = db.transaction(() => {
      db.prepare('DELETE FROM ai_page_search WHERE book_id = ?').run(bookId);
      const insert = db.prepare(`
        INSERT INTO ai_page_search (book_id, page_number, original_text, translated_text)
        VALUES (?, ?, ?, ?)
      `);

      for (const page of pages) {
        if (!isUsablePageForFormat(book.file_type, page)) continue;
        const originalText = cleanBookText(page.original_text);
        const translatedText = cleanBookText(page.translated_text);
        if (!originalText && !translatedText) continue;
        insert.run(
          bookId,
          page.page_number,
          originalText,
          translatedText
        );
      }

      db.prepare(`
        INSERT INTO ai_page_search_meta (book_id, page_count, content_fingerprint, indexed_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(book_id) DO UPDATE SET
          page_count = excluded.page_count,
          content_fingerprint = excluded.content_fingerprint,
          indexed_at = CURRENT_TIMESTAMP
      `).run(bookId, pageCount, fingerprint);
    });

    rebuild();
    return true;
  }

  searchRelevantPages(bookId: number, query: string, excludePages: Set<number>, limit = 6): PageRow[] {
    const selected = new Map<number, PageRow>();
    const book = db.prepare('SELECT file_type FROM books WHERE id = ?').get(bookId) as {
      file_type: string;
    } | undefined;
    if (!book) return [];
    const ftsQuery = buildFtsQuery(query);

    let ftsReady = false;
    if (ftsQuery) {
      try {
        ftsReady = this.ensureSearchIndex(bookId);
      } catch (error) {
        console.warn('[AI Search] Could not prepare FTS index, falling back to LIKE:', error instanceof Error ? error.message : error);
      }
    }

    if (ftsQuery && ftsReady) {
      try {
        const rows = db.prepare(`
          SELECT page_number
          FROM ai_page_search
          WHERE ai_page_search MATCH ? AND book_id = ?
          ORDER BY bm25(ai_page_search)
          LIMIT ?
        `).all(ftsQuery, bookId, limit * 2) as Array<{ page_number: number | string }>;

        const pageNumbers = rows
          .map((row) => Number(row.page_number))
          .filter((pageNumber) => Number.isFinite(pageNumber) && !excludePages.has(pageNumber))
          .slice(0, limit);

        for (const page of getPagesWithTranslation(bookId, pageNumbers)) {
          if (!isUsablePageForFormat(book.file_type, page)) continue;
          selected.set(page.page_number, page);
        }
      } catch (error) {
        console.warn('[AI Search] FTS query failed, falling back to LIKE:', error instanceof Error ? error.message : error);
      }
    }

    if (selected.size < limit) {
      for (const pattern of buildLikePatterns(query)) {
        const rows = db.prepare(`
          SELECT
            p.page_number,
            p.original_text,
            COALESCE(p.translated_text, pc.translated_text) as translated_text
          FROM pages p
          LEFT JOIN page_cache pc ON pc.id = (
            SELECT pc2.id FROM page_cache pc2
            WHERE pc2.page_hash = p.page_hash
            ORDER BY pc2.updated_at DESC, pc2.id DESC
            LIMIT 1
          )
          WHERE p.book_id = ?
            AND (p.original_text LIKE ? OR COALESCE(p.translated_text, pc.translated_text, '') LIKE ?)
          ORDER BY p.page_number
          LIMIT ?
        `).all(bookId, pattern, pattern, limit * 2) as PageRow[];

        for (const row of rows) {
          if (!isUsablePageForFormat(book.file_type, row)) continue;
          if (excludePages.has(row.page_number) || selected.has(row.page_number)) continue;
          selected.set(row.page_number, row);
          if (selected.size >= limit) break;
        }
        if (selected.size >= limit) break;
      }
    }

    return [...selected.values()].slice(0, limit);
  }

  buildContext(bookId: number, pageNumber: number, question: string, selectedText: string | undefined, intent: AiChatIntent): BookAiContext {
    const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) as BookRow | undefined;
    if (!book) {
      throw new Error('书籍不存在');
    }
    assertBookTextAvailable(bookId);

    const currentPage = getPageWithTranslation(bookId, pageNumber);
    if (!currentPage) {
      throw new Error('页面不存在');
    }

    try {
      this.ensureSearchIndex(bookId);
    } catch (error) {
      console.warn('[AI Context] Could not prepare FTS index:', error instanceof Error ? error.message : error);
    }

    const author = getAuthor(book);
    const sources = new Map<number, AiSource>();
    const formatLabel = book.file_type.toUpperCase();
    const sections: string[] = [
      `# 图书\n书名：${book.original_name}\n作者：${author}\n格式：${formatLabel}\n当前页：${pageNumber} / ${book.total_pages}`,
    ];

    let chapter: ChapterRange | undefined;
    try {
      chapter = summaryService.calculateChapterRanges(bookId)
        .find((range) => pageNumber >= range.pageStart && pageNumber <= range.pageEnd);
    } catch (error) {
      console.warn('[AI Context] Could not calculate chapter ranges:', error instanceof Error ? error.message : error);
    }

    if (chapter) {
      sections.push(`# 当前章节\n${chapter.title}（第 ${chapter.pageStart}–${chapter.pageEnd} 页）`);
    }

    if (selectedText?.trim()) {
      addSource(sources, { pageNumber, reason: 'selection', title: '选中文本' });
      sections.push(`# 第 ${pageNumber} 页选中文本\n${truncateText(cleanBookText(selectedText), 2500)}`);
    }

    const currentSection = isUsablePageForFormat(book.file_type, currentPage)
      ? formatPageSection('当前页', currentPage, intent === 'summarize_page' ? 7000 : 4500)
      : null;
    if (currentSection) {
      addSource(sources, { pageNumber, reason: 'current', title: '当前页' });
      sections.push(currentSection);
    } else if (intent === 'summarize_page') {
      const error = new Error('当前 PDF 页面未检测到可提取文字') as Error & {
        status?: number;
        code?: string;
        expose?: boolean;
      };
      error.status = 422;
      error.code = 'PAGE_TEXT_UNAVAILABLE';
      error.expose = true;
      throw error;
    }

    const adjacentPages = getPagesWithTranslation(bookId, [pageNumber - 1, pageNumber + 1]);
    for (const page of adjacentPages) {
      if (!isUsablePageForFormat(book.file_type, page)) continue;
      const section = formatPageSection('相邻页上下文', page, 1200);
      if (!section) continue;
      addSource(sources, { pageNumber: page.page_number, reason: 'adjacent', title: '相邻页' });
      sections.push(section);
    }

    const usedPages = new Set(sources.keys());
    if (chapter && intent !== 'summarize_page' && intent !== 'translate_selection') {
      const chapterSampleNumbers = [
        chapter.pageStart,
        Math.max(chapter.pageStart, pageNumber - 2),
        Math.min(chapter.pageEnd, pageNumber + 2),
        chapter.pageEnd,
      ].filter((candidate) => candidate >= chapter!.pageStart && candidate <= chapter!.pageEnd && !usedPages.has(candidate));

      const chapterPages = getPagesWithTranslation(bookId, chapterSampleNumbers)
        .filter((page) => isUsablePageForFormat(book.file_type, page))
        .slice(0, 3);
      for (const page of chapterPages) {
        const section = formatPageSection(`章节抽样：${chapter.title}`, page, 1100);
        if (!section) continue;
        addSource(sources, { pageNumber: page.page_number, reason: 'chapter', title: chapter.title });
        usedPages.add(page.page_number);
        sections.push(section);
      }
    }

    if (intent === 'qa' || intent === 'explain_concepts') {
      const searchQuery = selectedText ? `${question}\n${selectedText}` : question;
      for (const page of this.searchRelevantPages(bookId, searchQuery, usedPages, 6)) {
        const section = formatPageSection('全书检索结果', page, 1600);
        if (!section) continue;
        addSource(sources, { pageNumber: page.page_number, reason: 'search', title: '全书检索结果' });
        usedPages.add(page.page_number);
        sections.push(section);
      }
    }

    return {
      book,
      author,
      currentChapter: chapter,
      contextText: sections.join('\n\n---\n\n'),
      sources: [...sources.values()].sort((a, b) => a.pageNumber - b.pageNumber),
      selectedText,
    };
  }
}

export const bookAiContextService = new BookAiContextService();
