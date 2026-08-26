import { db } from '../config/database';

export const TEXT_EXTRACTION_UNAVAILABLE_CODE = 'TEXT_EXTRACTION_UNAVAILABLE';
export const MIN_EXTRACTED_TEXT_LENGTH = 20;

export type TextExtractionStatus = 'ready' | 'partial' | 'unavailable';

export interface BookTextCapability {
  bookId: number;
  fileType: string;
  textExtractionStatus: TextExtractionStatus;
  textPageCount: number;
  totalPages: number;
}

interface BookCapabilityRow {
  id: number;
  file_type: string;
  total_pages: number;
}

interface PageCapabilityRow {
  book_id: number;
  original_text: string;
}

export class TextExtractionUnavailableError extends Error {
  readonly status = 422;
  readonly code = TEXT_EXTRACTION_UNAVAILABLE_CODE;
  readonly expose = true;

  constructor() {
    super('未检测到可提取文字；扫描版 PDF 仅支持原版阅读');
    this.name = 'TextExtractionUnavailableError';
  }
}

export function isMeaningfulExtractedText(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.replace(/\s/g, '').length >= MIN_EXTRACTED_TEXT_LENGTH;
}

export function getBookTextCapabilities(bookIds: number[]): Map<number, BookTextCapability> {
  const normalizedIds = [...new Set(bookIds.filter((id) => Number.isInteger(id) && id > 0))];
  const capabilities = new Map<number, BookTextCapability>();
  if (normalizedIds.length === 0) return capabilities;

  const placeholders = normalizedIds.map(() => '?').join(',');
  const books = db.prepare(`
    SELECT id, file_type, total_pages
    FROM books
    WHERE id IN (${placeholders})
  `).all(...normalizedIds) as BookCapabilityRow[];

  const pdfBooks = books.filter((book) => book.file_type === 'pdf');
  const textCounts = new Map<number, number>();

  if (pdfBooks.length > 0) {
    const pdfPlaceholders = pdfBooks.map(() => '?').join(',');
    const pageRows = db.prepare(`
      SELECT book_id, original_text
      FROM pages
      WHERE book_id IN (${pdfPlaceholders})
    `).all(...pdfBooks.map((book) => book.id)) as PageCapabilityRow[];

    for (const page of pageRows) {
      if (!isMeaningfulExtractedText(page.original_text)) continue;
      textCounts.set(page.book_id, (textCounts.get(page.book_id) || 0) + 1);
    }
  }

  for (const book of books) {
    const totalPages = Math.max(0, book.total_pages || 0);
    if (book.file_type !== 'pdf') {
      capabilities.set(book.id, {
        bookId: book.id,
        fileType: book.file_type,
        textExtractionStatus: totalPages > 0 ? 'ready' : 'unavailable',
        textPageCount: totalPages,
        totalPages,
      });
      continue;
    }

    const textPageCount = textCounts.get(book.id) || 0;
    const textExtractionStatus: TextExtractionStatus = textPageCount === 0
      ? 'unavailable'
      : textPageCount < totalPages
        ? 'partial'
        : 'ready';

    capabilities.set(book.id, {
      bookId: book.id,
      fileType: book.file_type,
      textExtractionStatus,
      textPageCount,
      totalPages,
    });
  }

  return capabilities;
}

export function getBookTextCapability(bookId: number): BookTextCapability | null {
  return getBookTextCapabilities([bookId]).get(bookId) || null;
}

export function assertBookTextAvailable(bookId: number): BookTextCapability {
  const capability = getBookTextCapability(bookId);
  if (!capability) {
    const error = new Error('书籍不存在') as Error & { status?: number; expose?: boolean };
    error.status = 404;
    error.expose = true;
    throw error;
  }

  if (capability.textExtractionStatus === 'unavailable') {
    throw new TextExtractionUnavailableError();
  }

  return capability;
}
