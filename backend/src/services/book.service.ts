import { db } from '../config/database';
import { parseEPUB } from './epub.service';
import { parsePDF } from './pdf.service';
import { deduplicationService } from './deduplication.service';
import { cacheService } from './cache.service';
import { fileStorageService } from './file-storage.service';
import { bookAiContextService } from './book-ai-context.service';
import { runtimeConfig } from '../config/env';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  getBookTextCapabilities,
  getBookTextCapability,
  isMeaningfulExtractedText,
} from './book-text-capability.service';

const execFileAsync = promisify(execFile);

export function userCanAccessBook(userId: number, bookId: number): boolean {
  const book = db.prepare('SELECT id FROM books WHERE id = ? AND user_id = ?').get(bookId, userId);
  return Boolean(book);
}

export function assertBookAccess(userId: number, bookId: number): void {
  if (!userCanAccessBook(userId, bookId)) {
    const error = new Error('书籍不存在') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
}

export type ReadingStatus = 'unread' | 'reading' | 'paused' | 'finished' | 'abandoned';
export type BookImportStatus = 'pending' | 'processing' | 'ready' | 'failed';

export interface UploadBookResult {
  id: number;
  filename: string;
  originalName: string;
  fileType: string;
  totalPages: number;
  toc: unknown;
  text_extraction_status: 'ready' | 'partial' | 'unavailable';
  text_page_count: number;
  import_status: BookImportStatus;
  import_stage: string | null;
  import_error: string | null;
  duplicate: boolean;
}

export interface StagedBookUpload {
  book: UploadBookResult;
  shouldEnqueue: boolean;
}

const READING_STATUSES = new Set<ReadingStatus>(['unread', 'reading', 'paused', 'finished', 'abandoned']);

async function calculateFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function cleanupUploadedFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.warn(`Failed to remove duplicate upload file ${filePath}:`, error);
  }
}

async function findExistingBookForUpload(
  userId: number,
  originalName: string,
  fileType: string,
  fileSize: number,
  fileHash: string
) {
  const byHash = db.prepare(`
    SELECT id, filename, original_name, file_path, file_type, file_size, file_hash,
           total_pages, table_of_contents, import_status, import_stage, import_error
    FROM books
    WHERE user_id = ? AND file_hash = ?
    ORDER BY upload_time DESC, id DESC
    LIMIT 1
  `).get(userId, fileHash) as any;

  if (byHash) return byHash;

  const legacyCandidates = db.prepare(`
    SELECT id, filename, original_name, file_path, file_type, file_size, file_hash,
           total_pages, table_of_contents, import_status, import_stage, import_error
    FROM books
    WHERE user_id = ? AND file_hash IS NULL AND file_size = ?
    ORDER BY upload_time DESC, id DESC
  `).all(userId, fileSize) as any[];

  for (const candidate of legacyCandidates) {
    const candidatePath = resolveBookFilePath(candidate.file_path);
    if (!fs.existsSync(candidatePath)) continue;

    try {
      if (await calculateFileHash(candidatePath) === fileHash) {
        db.prepare('UPDATE books SET file_hash = ? WHERE id = ? AND user_id = ? AND file_hash IS NULL')
          .run(fileHash, candidate.id, userId);
        return candidate;
      }
    } catch (error) {
      console.warn(`Failed to hash existing book file ${candidate.file_path}:`, error);
    }
  }

  // Last resort for pre-hash records whose file is no longer on disk, so their
  // hash can never be recomputed. Rows that DO have a hash were already checked
  // above; matching them on name/type/size would discard a genuinely different
  // upload that merely shares those attributes.
  return db.prepare(`
    SELECT id, filename, original_name, file_path, file_type, file_size, file_hash,
           total_pages, table_of_contents, import_status, import_stage, import_error
    FROM books
    WHERE user_id = ? AND file_hash IS NULL
      AND original_name = ? AND file_type = ? AND file_size = ?
    ORDER BY upload_time DESC, id DESC
    LIMIT 1
  `).get(userId, originalName, fileType, fileSize) as any;
}

function parseStoredToc(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toUploadBookResult(book: any, duplicate: boolean): UploadBookResult {
  const importStatus = (book.import_status || 'ready') as BookImportStatus;
  const capability = importStatus === 'ready' ? getBookTextCapability(book.id) : null;
  return {
    id: book.id,
    filename: book.filename,
    originalName: book.original_name,
    fileType: book.file_type,
    totalPages: book.total_pages || 0,
    toc: parseStoredToc(book.table_of_contents),
    text_extraction_status: capability?.textExtractionStatus || 'ready',
    text_page_count: capability?.textPageCount ?? (importStatus === 'ready' ? book.total_pages || 0 : 0),
    import_status: importStatus,
    import_stage: book.import_stage || null,
    import_error: book.import_error || null,
    duplicate,
  };
}

function getImportFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || '未知错误');
  return message.replace(/^Error:\s*/i, '').slice(0, 1000) || '书籍解析失败';
}

export async function stageBookUpload(
  file: Express.Multer.File,
  folderId: number | null = null,
  userId: number
): Promise<StagedBookUpload> {
  const fileType = path.extname(file.originalname).toLowerCase().replace('.', '');

  if (fileType !== 'epub' && fileType !== 'pdf') {
    cleanupUploadedFile(file.path);
    throw new Error('目前仅支持 EPUB 或 PDF 格式的文件');
  }

  if (folderId !== null) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').get(folderId, userId);
    if (!folder) {
      cleanupUploadedFile(file.path);
      throw new Error('文件夹不存在');
    }
  }

  let fileHash: string;
  try {
    fileHash = await calculateFileHash(file.path);
  } catch (error) {
    cleanupUploadedFile(file.path);
    throw error;
  }

  const existingBook = await findExistingBookForUpload(
    userId,
    file.originalname,
    fileType,
    file.size,
    fileHash,
  );
  if (existingBook) {
    let shouldEnqueue = existingBook.import_status !== 'ready';

    if (existingBook.import_status === 'failed') {
      const existingPath = resolveBookFilePath(existingBook.file_path);
      if (fs.existsSync(existingPath)) {
        cleanupUploadedFile(file.path);
      } else {
        db.prepare(`
          UPDATE books
          SET filename = ?, original_name = ?, file_path = ?, file_type = ?, file_size = ?, file_hash = ?
          WHERE id = ? AND user_id = ?
        `).run(
          file.filename,
          file.originalname,
          file.path,
          fileType,
          file.size,
          fileHash,
          existingBook.id,
          userId,
        );
        existingBook.filename = file.filename;
        existingBook.original_name = file.originalname;
        existingBook.file_path = file.path;
        existingBook.file_size = file.size;
      }

      db.prepare(`
        UPDATE books
        SET import_status = 'pending', import_stage = 'queued', import_error = NULL,
            import_started_at = NULL, import_completed_at = NULL
        WHERE id = ? AND user_id = ?
      `).run(existingBook.id, userId);
      existingBook.import_status = 'pending';
      existingBook.import_stage = 'queued';
      existingBook.import_error = null;
      shouldEnqueue = true;
    } else {
      cleanupUploadedFile(file.path);
    }

    if (folderId !== null) {
      moveBookToFolder(userId, existingBook.id, folderId);
    }

    console.log(`Duplicate upload skipped: ExistingID=${existingBook.id}, Name=${file.originalname}`);
    return {
      book: toUploadBookResult(existingBook, true),
      shouldEnqueue,
    };
  }

  let bookId: number;
  try {
    const insertBook = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO books (
          filename, original_name, file_path, file_type, file_size, file_hash,
          total_pages, user_id, table_of_contents, folder_id, cover_image_path,
          import_status, import_stage
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, NULL, 'pending', 'queued')
      `).run(
        file.filename,
        file.originalname,
        file.path,
        fileType,
        file.size,
        fileHash,
        userId,
        folderId,
      );
      const id = Number(result.lastInsertRowid);

      if (folderId !== null) {
        db.prepare(`
          INSERT OR REPLACE INTO user_book_folders (user_id, book_id, folder_id)
          VALUES (?, ?, ?)
        `).run(userId, id, folderId);
      }
      return id;
    });
    bookId = insertBook();
  } catch (error) {
    cleanupUploadedFile(file.path);
    throw error;
  }

  const stagedBook = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any;
  return {
    book: toUploadBookResult(stagedBook, false),
    shouldEnqueue: true,
  };
}

export async function processBookImport(bookId: number): Promise<UploadBookResult> {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any;
  if (!book) throw new Error('书籍不存在');
  if (book.import_status === 'ready') return toUploadBookResult(book, false);

  const filePath = resolveBookFilePath(book.file_path);
  const createdResourcePaths: string[] = [];

  try {
    if (!fs.existsSync(filePath)) {
      throw new Error('上传文件不存在，无法继续解析');
    }

    db.prepare(`
      UPDATE books
      SET import_status = 'processing', import_stage = 'validating', import_error = NULL,
          import_started_at = CURRENT_TIMESTAMP, import_completed_at = NULL
      WHERE id = ?
    `).run(bookId);

    db.prepare("UPDATE books SET import_stage = 'parsing' WHERE id = ?").run(bookId);
    const parsedBook = book.file_type === 'pdf'
      ? await parsePDF(filePath)
      : await parseEPUB(filePath);
    const { pages, totalPages, toc } = parsedBook;
    let { coverImagePath } = parsedBook;
    createdResourcePaths.push(...parsedBook.createdResourcePaths);

    if (book.file_type === 'pdf') {
      const renderedCover = await renderPdfCover(filePath);
      if (renderedCover) {
        coverImagePath = renderedCover.url;
        createdResourcePaths.push(renderedCover.filePath);
      }
    }

    db.prepare("UPDATE books SET import_stage = 'persisting' WHERE id = ?").run(bookId);
    const storageResult = await fileStorageService.persistUploadedFile(bookId, filePath);
    if (!storageResult.success) {
      throw new Error(storageResult.error || '书籍文件保存失败');
    }

    const saveBookRecords = db.transaction(() => {
      db.prepare('DELETE FROM pages WHERE book_id = ?').run(bookId);
      db.prepare('DELETE FROM ai_page_search WHERE book_id = ?').run(bookId);
      db.prepare('DELETE FROM ai_page_search_meta WHERE book_id = ?').run(bookId);

      const insertPage = db.prepare(`
        INSERT INTO pages (book_id, page_number, original_text, page_hash)
        VALUES (?, ?, ?, ?)
      `);
      for (const page of pages) {
        const pageHash = book.file_type === 'pdf' && !isMeaningfulExtractedText(page.text)
          ? null
          : deduplicationService.calculatePageHash(page.text);
        insertPage.run(bookId, page.pageNumber, page.text, pageHash);
      }

      if (!coverImagePath && pages.length > 0) {
        coverImagePath = extractCoverFromHtml(pages[0].text);
      }

      db.prepare(`
        UPDATE books
        SET total_pages = ?, table_of_contents = ?, cover_image_path = ?, import_stage = 'indexing'
        WHERE id = ?
      `).run(totalPages, toc ? JSON.stringify(toc) : null, coverImagePath, bookId);
    });
    saveBookRecords();

    try {
      bookAiContextService.ensureSearchIndex(bookId);
    } catch (error) {
      console.warn(`Failed to build AI search index for book ${bookId}:`, error instanceof Error ? error.message : error);
    }

    db.prepare(`
      UPDATE books
      SET import_status = 'ready', import_stage = 'complete', import_error = NULL,
          import_completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(bookId);

    const completedBook = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId) as any;
    return toUploadBookResult(completedBook, false);
  } catch (error) {
    for (const resourcePath of createdResourcePaths) {
      try {
        fs.rmSync(resourcePath, { force: true });
      } catch {
        // Preserve the parser/persistence failure as the primary error.
      }
    }

    db.transaction(() => {
      db.prepare('DELETE FROM pages WHERE book_id = ?').run(bookId);
      db.prepare('DELETE FROM ai_page_search WHERE book_id = ?').run(bookId);
      db.prepare('DELETE FROM ai_page_search_meta WHERE book_id = ?').run(bookId);
      db.prepare(`
        UPDATE books
        SET total_pages = 0, table_of_contents = NULL, cover_image_path = NULL,
            import_status = 'failed', import_stage = 'failed', import_error = ?,
            import_completed_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(getImportFailureMessage(error), bookId);
    })();
    throw error;
  }
}

export function prepareBookImportRetry(bookId: number, userId: number): UploadBookResult {
  const book = db.prepare('SELECT * FROM books WHERE id = ? AND user_id = ?').get(bookId, userId) as any;
  if (!book) {
    const error = new Error('书籍不存在') as Error & { status?: number; expose?: boolean };
    error.status = 404;
    error.expose = true;
    throw error;
  }
  if (book.import_status !== 'failed') {
    const error = new Error('只有解析失败的书籍可以重试') as Error & { status?: number; expose?: boolean };
    error.status = 409;
    error.expose = true;
    throw error;
  }

  const filePath = resolveBookFilePath(book.file_path);
  if (!fs.existsSync(filePath)) {
    const error = new Error('原始上传文件不存在，请重新上传') as Error & { status?: number; expose?: boolean };
    error.status = 409;
    error.expose = true;
    throw error;
  }

  db.prepare(`
    UPDATE books
    SET import_status = 'pending', import_stage = 'queued', import_error = NULL,
        import_started_at = NULL, import_completed_at = NULL
    WHERE id = ? AND user_id = ?
  `).run(bookId, userId);
  book.import_status = 'pending';
  book.import_stage = 'queued';
  book.import_error = null;
  return toUploadBookResult(book, false);
}

export async function saveBook(file: Express.Multer.File, folderId: number | null = null, userId: number) {
  const staged = await stageBookUpload(file, folderId, userId);
  if (!staged.shouldEnqueue) return staged.book;

  try {
    const imported = await processBookImport(staged.book.id);
    return { ...imported, duplicate: staged.book.duplicate };
  } catch (error) {
    // Preserve the historical synchronous service contract for internal
    // callers. The HTTP upload route uses stageBookUpload + the queue and keeps
    // failed records so users can inspect and retry them.
    if (!staged.book.duplicate) {
      await fileStorageService.deleteFile(staged.book.id);
      db.prepare('DELETE FROM books WHERE id = ? AND user_id = ?').run(staged.book.id, userId);
    }
    throw error;
  }
}

export function getBookById(id: number, userId: number) {
  const book = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM pages WHERE book_id = b.id AND translation_status IN ('completed', 'skipped')) as translated_pages,
      (SELECT status FROM book_reading_guides WHERE book_id = b.id LIMIT 1) as reading_guide_status,
      (SELECT CASE WHEN status = 'completed' AND guide_text IS NOT NULL THEN 1 ELSE 0 END FROM book_reading_guides WHERE book_id = b.id LIMIT 1) as has_reading_guide,
      COALESCE(ubp.last_read_page, 1) as last_read_page,
      COALESCE(ubp.is_pinned, 0) as is_pinned,
      COALESCE(ubp.reading_status, 'unread') as reading_status,
      ubf.folder_id as user_folder_id,
      f.name as folder_name,
      f.color as folder_color
    FROM books b
    LEFT JOIN user_book_progress ubp ON ubp.book_id = b.id AND ubp.user_id = ?
    LEFT JOIN user_book_folders ubf ON ubf.book_id = b.id AND ubf.user_id = ?
    LEFT JOIN folders f ON ubf.folder_id = f.id
    WHERE b.id = ? AND b.user_id = ?
  `).get(userId, userId, id, userId) as any;

  if (book) {
    const parsedToc = book.table_of_contents ? JSON.parse(book.table_of_contents) : null;
    const capability = book.import_status === 'ready' ? getBookTextCapability(book.id) : null;
    const { file_path: _filePath, ...publicBook } = book;
    return {
      ...publicBook,
      file_url: `/uploads/${encodeURIComponent(book.filename)}`,
      folder_id: book.user_folder_id ?? null,
      tableOfContents: parsedToc,
      text_extraction_status: capability?.textExtractionStatus || 'ready',
      text_page_count: capability?.textPageCount ?? (book.import_status === 'ready' ? book.total_pages : 0),
      translatedPages: book.translated_pages,
      translationProgress: book.total_pages > 0 ? (book.translated_pages / book.total_pages * 100).toFixed(2) : 0,
    };
  }

  return null;
}

export function getAllBooks(userId: number) {
  return getBooksByFolder(userId, 'all');
}

export function getPagesByBookId(bookId: number, userId: number, pageNumber?: number) {
  assertBookAccess(userId, bookId);

  if (pageNumber) {
    return db.prepare(`
      SELECT
        p.id,
        p.book_id,
        p.page_number,
        p.original_text,
        p.translation_status,
        p.page_hash,
        p.is_cached,
        p.created_at,
        p.updated_at,
        COALESCE(p.translated_text, pc.translated_text) as translated_text,
        CASE WHEN p.is_cached = 1 OR (p.translated_text IS NULL AND pc.id IS NOT NULL) THEN 'cached' ELSE 'stored' END as translation_source
      FROM pages p
      INNER JOIN books b ON b.id = p.book_id
      LEFT JOIN page_cache pc ON pc.id = (
        SELECT pc2.id FROM page_cache pc2
        WHERE pc2.page_hash = p.page_hash
        ORDER BY pc2.updated_at DESC, pc2.id DESC
        LIMIT 1
      )
      WHERE p.book_id = ? AND p.page_number = ?
    `).get(bookId, pageNumber);
  }
  return db.prepare(`
    SELECT
      p.id,
      p.book_id,
      p.page_number,
      p.original_text,
      p.translation_status,
      p.page_hash,
      p.is_cached,
      p.created_at,
      p.updated_at,
      COALESCE(p.translated_text, pc.translated_text) as translated_text,
      CASE WHEN p.is_cached = 1 OR (p.translated_text IS NULL AND pc.id IS NOT NULL) THEN 'cached' ELSE 'stored' END as translation_source
    FROM pages p
    INNER JOIN books b ON b.id = p.book_id
    LEFT JOIN page_cache pc ON pc.id = (
      SELECT pc2.id FROM page_cache pc2
      WHERE pc2.page_hash = p.page_hash
      ORDER BY pc2.updated_at DESC, pc2.id DESC
      LIMIT 1
    )
    WHERE p.book_id = ?
    ORDER BY p.page_number
  `).all(bookId);
}

export function updateLastReadPage(userId: number, bookId: number, pageNumber: number) {
  assertBookAccess(userId, bookId);
  const book = db.prepare('SELECT total_pages FROM books WHERE id = ?').get(bookId) as { total_pages: number } | undefined;
  const totalPages = book?.total_pages || 0;
  const inferredStatus: ReadingStatus = totalPages > 0 && pageNumber >= totalPages
    ? 'finished'
    : pageNumber > 1
      ? 'reading'
      : 'unread';

  return db.prepare(`
    INSERT INTO user_book_progress (user_id, book_id, last_read_page, reading_status, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, book_id) DO UPDATE SET
      last_read_page = ?,
      reading_status = CASE
        WHEN reading_status IN ('paused', 'abandoned') THEN reading_status
        WHEN reading_status = 'finished' THEN reading_status
        WHEN ? > 0 AND ? >= ? THEN 'finished'
        WHEN (reading_status IS NULL OR reading_status = 'unread') AND ? > 1 THEN 'reading'
        ELSE reading_status
      END,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, bookId, pageNumber, inferredStatus, pageNumber, totalPages, pageNumber, totalPages, pageNumber);
}

export async function deleteBook(bookId: number, userId: number) {
  // Verify book exists
  const book = db.prepare(`
    SELECT id, cover_image_path
    FROM books
    WHERE id = ? AND user_id = ?
  `).get(bookId, userId) as { id: number; cover_image_path: string | null } | undefined;
  if (!book) {
    throw new Error('书籍不存在');
  }

  // Clear cache for this book
  cacheService.clearByBookId(bookId);

  // Delete file from storage
  await fileStorageService.deleteFile(bookId);

  // Remove generated cover assets (including PDF first-page previews).
  if (book.cover_image_path) {
    removeLocalUploadAsset(book.cover_image_path);
  }

  // Clean up extracted EPUB images if any.
  try {
    const pages = db.prepare('SELECT original_text FROM pages WHERE book_id = ?').all(bookId) as any[];
    const imgRegex = /\/uploads\/(epub-resources\/[^"']+)/g;
    const uploadsDir = runtimeConfig.uploadDir;
    const resolvedUploadsDir = path.resolve(uploadsDir);

    for (const page of pages) {
      let match;
      while ((match = imgRegex.exec(page.original_text)) !== null) {
        const imagePath = match[1];
        const fullPath = path.resolve(uploadsDir, imagePath);
        // Path traversal protection: ensure resolved path is within uploads dir
        if (fullPath !== resolvedUploadsDir && !fullPath.startsWith(`${resolvedUploadsDir}${path.sep}`)) {
          continue;
        }
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }
    }
  } catch (err) {
    console.error(`Failed to cleanup EPUB images for book ${bookId}:`, err);
  }

  const deleteBookRecords = db.transaction(() => {
    db.prepare(`
      DELETE FROM alignment_configs
      WHERE page_id IN (SELECT id FROM pages WHERE book_id = ?)
    `).run(bookId);

    db.prepare(`
      DELETE FROM sentence_mappings
      WHERE book_id = ?
         OR page_id IN (SELECT id FROM pages WHERE book_id = ?)
    `).run(bookId, bookId);

    db.prepare('DELETE FROM translation_jobs WHERE book_id = ?').run(bookId);
    db.prepare('DELETE FROM book_summaries WHERE book_id = ?').run(bookId);
    db.prepare('DELETE FROM book_mindmaps WHERE book_id = ?').run(bookId);
    db.prepare('DELETE FROM book_reading_guides WHERE book_id = ?').run(bookId);
    deleteFromOptionalBookTable('selection_history', bookId);
    deleteFromOptionalBookTable('vocabulary_records', bookId);
    db.prepare('DELETE FROM user_book_progress WHERE book_id = ?').run(bookId);
    db.prepare('DELETE FROM user_book_folders WHERE book_id = ?').run(bookId);
    db.prepare('DELETE FROM pages WHERE book_id = ?').run(bookId);

    const result = db.prepare('DELETE FROM books WHERE id = ?').run(bookId);

    db.prepare(`
      DELETE FROM page_cache
      WHERE page_hash NOT IN (
        SELECT DISTINCT page_hash FROM pages WHERE page_hash IS NOT NULL
      )
    `).run();

    db.prepare(`
      UPDATE cache_metadata
      SET total_cached_pages = (SELECT COUNT(*) FROM page_cache),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `).run();

    return result;
  });

  return deleteBookRecords();
}

function deleteFromOptionalBookTable(tableName: string, bookId: number): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  if (!table) return;

  db.prepare(`DELETE FROM ${tableName} WHERE book_id = ?`).run(bookId);
}

/**
 * Get page with translation and cache metadata
 */
export async function getPageWithTranslation(bookId: number, pageNumber: number, userId: number) {
  assertBookAccess(userId, bookId);

  const page = db.prepare(`
    SELECT
      p.id,
      p.book_id,
      p.page_number,
      p.original_text,
      p.translation_status,
      p.page_hash,
      p.is_cached,
      p.created_at,
      p.updated_at,
      COALESCE(p.translated_text, pc.translated_text) as translated_text,
      CASE WHEN p.is_cached = 1 OR (p.translated_text IS NULL AND pc.id IS NOT NULL) THEN 'cached' ELSE 'stored' END as translation_source
    FROM pages p
    INNER JOIN books b ON b.id = p.book_id
    LEFT JOIN page_cache pc ON pc.id = (
      SELECT pc2.id FROM page_cache pc2
      WHERE pc2.page_hash = p.page_hash
      ORDER BY pc2.updated_at DESC, pc2.id DESC
      LIMIT 1
    )
    WHERE p.book_id = ? AND p.page_number = ?
  `).get(bookId, pageNumber) as any;

  return page;
}

/**
 * Get cache statistics for a book
 */
export function getBookCacheStats(bookId: number, userId: number) {
  assertBookAccess(userId, bookId);
  const stats = db.prepare(`
    SELECT
    COUNT(*) as total_pages,
    SUM(CASE WHEN translation_status IN ('completed', 'skipped') THEN 1 ELSE 0 END) as translated_pages,
    SUM(CASE WHEN is_cached = 1 THEN 1 ELSE 0 END) as cached_pages,
    COUNT(DISTINCT page_hash) as unique_pages
    FROM pages
    WHERE book_id = ?
  `).get(bookId) as any;

  return {
    bookId,
    totalPages: stats.total_pages || 0,
    translatedPages: stats.translated_pages || 0,
    cachedPages: stats.cached_pages || 0,
    uniquePages: stats.unique_pages || 0,
    translationProgress: stats.total_pages > 0 ? ((stats.translated_pages / stats.total_pages) * 100).toFixed(2) : 0,
    cacheHitRate: stats.translated_pages > 0 ? ((stats.cached_pages / stats.translated_pages) * 100).toFixed(2) : 0,
  };
}

/**
 * Get deduplication opportunities for a book
 */
export async function getBookDeduplicationOpportunities(bookId: number, userId: number) {
  assertBookAccess(userId, bookId);
  const opportunities = await deduplicationService.findOptimizationOpportunities(2, userId);

  // Filter to only this book
  const bookOpportunities = [];
  for (const opp of opportunities) {
    const bookPages = db.prepare(`
      SELECT COUNT(*) as count FROM pages WHERE book_id = ? AND page_hash = ?
    `).get(bookId, opp.pageHash) as any;

    if (bookPages.count > 0) {
      bookOpportunities.push({
        ...opp,
        bookCount: bookPages.count,
      });
    }
  }

  return bookOpportunities;
}

/**
 * Get file storage info for a book
 */
export function getBookStorageInfo(bookId: number, userId: number) {
  assertBookAccess(userId, bookId);

  const book = db.prepare(`
    SELECT file_size, use_blob_storage, COALESCE(blob_size, 0) as blob_size
    FROM books WHERE id = ?
  `).get(bookId) as any;

  if (!book) {
    return null;
  }

  return {
    bookId,
    diskSize: book.file_size,
    blobSize: book.blob_size,
    useBlob: book.use_blob_storage === 1,
    totalSize: book.file_size + book.blob_size,
  };
}

/**
 * Get books filtered by folder
 * @param folderId - folder id, null for uncategorized, 'all' for all books
 */
export function getBooksByFolder(userId: number, folderId: number | null | 'all') {
  let whereClause = 'WHERE b.user_id = ?';
  const params: Array<number> = [userId, userId, userId];

  if (folderId === null) {
    whereClause += `
      AND NOT EXISTS (
        SELECT 1
        FROM user_book_folders folder_assignment
        WHERE folder_assignment.user_id = ?
          AND folder_assignment.book_id = b.id
          AND folder_assignment.folder_id IS NOT NULL
      )
    `;
    params.push(userId);
  } else if (folderId !== 'all') {
    whereClause += ' AND ubf.folder_id = ?';
    params.push(folderId);
  }

  const books = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM pages WHERE book_id = b.id AND translation_status IN ('completed', 'skipped')) as translated_pages,
      (SELECT status FROM book_reading_guides WHERE book_id = b.id LIMIT 1) as reading_guide_status,
      (SELECT CASE WHEN status = 'completed' AND guide_text IS NOT NULL THEN 1 ELSE 0 END FROM book_reading_guides WHERE book_id = b.id LIMIT 1) as has_reading_guide,
      COALESCE(ubp.last_read_page, 1) as last_read_page,
      COALESCE(ubp.is_pinned, 0) as is_pinned,
      COALESCE(ubp.reading_status, 'unread') as reading_status,
      ubf.folder_id as user_folder_id,
      f.name as folder_name,
      f.color as folder_color
    FROM books b
    LEFT JOIN user_book_folders ubf ON ubf.book_id = b.id AND ubf.user_id = ?
    LEFT JOIN folders f ON ubf.folder_id = f.id
    LEFT JOIN user_book_progress ubp ON ubp.book_id = b.id AND ubp.user_id = ?
    ${whereClause}
    ORDER BY COALESCE(is_pinned, 0) DESC, upload_time DESC, id DESC
  `).all(...params) as any[];

  const capabilities = getBookTextCapabilities(books.map((book) => book.id));
  return books.map((book) => {
    const capability = book.import_status === 'ready' ? capabilities.get(book.id) : null;
    const { file_path: _filePath, ...publicBook } = book;
    return {
      ...publicBook,
      file_url: `/uploads/${encodeURIComponent(book.filename)}`,
      folder_id: book.user_folder_id ?? null,
      tableOfContents: book.table_of_contents ? JSON.parse(book.table_of_contents) : null,
      text_extraction_status: capability?.textExtractionStatus || 'ready',
      text_page_count: capability?.textPageCount ?? (book.import_status === 'ready' ? book.total_pages : 0),
    };
  });
}

/**
 * Move a book to a folder
 * @param bookId - book id
 * @param folderId - target folder id, null for uncategorized
 */
/**
 * Get adjacent page context for sliding window translation
 * Returns tail of previous page and head of next page as context
 */
export function getAdjacentPageContext(bookId: number, pageNumber: number, charLimit: number = 200): { prevContext: string | null; nextContext: string | null } {
  const rows = db.prepare(`
    SELECT page_number, original_text FROM pages
    WHERE book_id = ? AND page_number IN (?, ?)
  `).all(bookId, pageNumber - 1, pageNumber + 1) as { page_number: number; original_text: string }[];

  let prevContext: string | null = null;
  let nextContext: string | null = null;

  for (const row of rows) {
    if (row.page_number === pageNumber - 1 && row.original_text) {
      prevContext = extractTail(row.original_text, charLimit);
    } else if (row.page_number === pageNumber + 1 && row.original_text) {
      nextContext = extractHead(row.original_text, charLimit);
    }
  }

  return { prevContext, nextContext };
}

function extractTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const tail = text.slice(-limit);
  // Look for a sentence/paragraph boundary to break at
  const breakMatch = tail.match(/.*[。．.！!？?\n]|.*<\/p>/s);
  if (breakMatch && breakMatch.index !== undefined) {
    const breakEnd = breakMatch.index + breakMatch[0].length;
    if (breakEnd < tail.length) {
      return tail.slice(breakEnd);
    }
  }
  return tail;
}

function extractHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  // Look for the last sentence/paragraph boundary
  const breakPoints = [...head.matchAll(/[。．.！!？?\n]|<\/p>/g)];
  if (breakPoints.length > 0) {
    const lastBreak = breakPoints[breakPoints.length - 1];
    const breakEnd = lastBreak.index! + lastBreak[0].length;
    if (breakEnd > 0) {
      return head.slice(0, breakEnd);
    }
  }
  return head;
}

export function moveBookToFolder(userId: number, bookId: number, folderId: number | null): void {
  // Validate folder exists if folderId is provided
  if (folderId !== null) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').get(folderId, userId);
    if (!folder) {
      throw new Error('文件夹不存在');
    }
  }

  assertBookAccess(userId, bookId);

  if (folderId === null) {
    // Remove the user_book_folders record (uncategorize)
    db.prepare('DELETE FROM user_book_folders WHERE user_id = ? AND book_id = ?').run(userId, bookId);
  } else {
    // UPSERT user_book_folders
    db.prepare(`
      INSERT INTO user_book_folders (user_id, book_id, folder_id)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, book_id) DO UPDATE SET folder_id = ?
    `).run(userId, bookId, folderId, folderId);
  }
}

/**
 * Move multiple books to a folder
 * @param bookIds - array of book ids
 * @param folderId - target folder id, null for uncategorized
 */
export function moveBooksToFolder(userId: number, bookIds: number[], folderId: number | null): void {
  if (bookIds.length === 0) {
    return;
  }

  // Validate folder exists if folderId is provided
  if (folderId !== null) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').get(folderId, userId);
    if (!folder) {
      throw new Error('文件夹不存在');
    }
  }

  for (const bookId of bookIds) {
    assertBookAccess(userId, bookId);
    if (folderId === null) {
      db.prepare('DELETE FROM user_book_folders WHERE user_id = ? AND book_id = ?').run(userId, bookId);
    } else {
      db.prepare(`
        INSERT INTO user_book_folders (user_id, book_id, folder_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id, book_id) DO UPDATE SET folder_id = ?
      `).run(userId, bookId, folderId, folderId);
    }
  }
}

/**
 * Extract the first image URL from HTML content to use as cover
 */
function extractCoverFromHtml(html: string): string | null {
  // Match <img src="...">, <image href="...">, <image xlink:href="...">
  const imgMatch = html.match(/<(?:img|image)[^>]*(?:src|href|xlink:href)=["']([^"']+)["']/i);
  if (imgMatch && imgMatch[1]) {
    const src = imgMatch[1];
    // Only use if it's a local uploads path
    if (src.startsWith('/uploads/')) {
      return src;
    }
  }
  return null;
}

/**
 * Resolve a book's file_path to an absolute path on disk
 */
function resolveBookFilePath(filePath: string): string {
  if (path.isAbsolute(filePath)) return filePath;
  // file_path in DB may be relative like "uploads/xxx.epub"
  // Try multiple base directories
  const candidates = [
    path.resolve(filePath),
    path.resolve('backend', filePath),
    path.resolve(process.env.UPLOAD_DIR || './uploads', '..', filePath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.resolve(filePath);
}

function removeLocalUploadAsset(assetUrl: string): void {
  if (!assetUrl.startsWith('/uploads/')) return;

  try {
    const relativePath = decodeURIComponent(assetUrl.slice('/uploads/'.length));
    const resolvedUploadsDir = path.resolve(runtimeConfig.uploadDir);
    const fullPath = path.resolve(resolvedUploadsDir, relativePath);
    if (fullPath === resolvedUploadsDir || !fullPath.startsWith(`${resolvedUploadsDir}${path.sep}`)) return;
    fs.rmSync(fullPath, { force: true });
  } catch (error) {
    console.warn(`Failed to remove generated book asset ${assetUrl}:`, error);
  }
}

/**
 * Extract cover image directly from an EPUB file on disk
 */
async function extractCoverFromEpubFile(filePath: string): Promise<string | null> {
  const resolvedPath = resolveBookFilePath(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.log(`  ⚠️  EPUB file not found: ${resolvedPath}`);
    return null;
  }

  try {
    const EPub = (await import('epub')).default;
    const epub = new EPub(resolvedPath);
    await epub.parse();
    const manifest = epub.manifest;
    const coverImageId = Object.keys(manifest).find((key) => {
      const item = manifest[key];
      const isImage = item['media-type']?.startsWith('image/');
      return Boolean(isImage && (
        item.properties === 'cover-image' || key === 'cover-image' || item.id === 'cover-image'
      ));
    });

    if (!coverImageId) return null;

    const coverImageExt = path.extname(manifest[coverImageId].href) || '.jpg';
    const coverRelPath = `epub-resources/${Date.now()}-cover${coverImageExt}`;
    const epubResourcesDir = path.join(runtimeConfig.uploadDir, 'epub-resources');
    fs.mkdirSync(epubResourcesDir, { recursive: true });
    const coverData = (await epub.getImage(coverImageId)).data;
    fs.writeFileSync(path.join(runtimeConfig.uploadDir, coverRelPath), coverData);
    return `/uploads/${coverRelPath}`;
  } catch {
    return null;
  }
}

/**
 * Extract cover from PDF by rendering the first page using pdftoppm
 */
async function renderPdfCover(filePath: string): Promise<{ url: string; filePath: string } | null> {
  const resolvedPath = resolveBookFilePath(filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.log(`  ⚠️  PDF file not found: ${resolvedPath}`);
    return null;
  }

  const pdfResourcesDir = path.join(runtimeConfig.uploadDir, 'pdf-resources');
  const coverBaseName = `${crypto.randomUUID()}-cover`;
  const outputPrefix = path.join(pdfResourcesDir, coverBaseName);
  const outputFile = `${outputPrefix}.jpg`;

  try {
    fs.mkdirSync(pdfResourcesDir, { recursive: true, mode: 0o700 });
    await execFileAsync('pdftoppm', [
      '-jpeg',
      '-f', '1',
      '-l', '1',
      '-r', '150',
      '-singlefile',
      resolvedPath,
      outputPrefix,
    ], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });

    if (fs.existsSync(outputFile)) {
      return {
        url: `/uploads/pdf-resources/${coverBaseName}.jpg`,
        filePath: outputFile,
      };
    }
    return null;
  } catch (err) {
    fs.rmSync(outputFile, { force: true });
    console.warn('PDF cover extraction failed; using the default cover:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function extractCoverFromPdf(filePath: string): Promise<string | null> {
  return (await renderPdfCover(filePath))?.url || null;
}

/**
 * Backfill cover images for existing books that don't have one
 */
export async function backfillBookCovers(): Promise<void> {
  const books = db.prepare(`
    SELECT b.id, b.file_path, b.file_type FROM books b
    WHERE b.cover_image_path IS NULL AND b.import_status = 'ready'
  `).all() as { id: number; file_path: string; file_type: string }[];

  if (books.length === 0) return;

  console.log(`📚 Backfilling covers for ${books.length} books...`);
  let updated = 0;

  for (const book of books) {
    // Strategy 1: Extract from first page HTML (img tags)
    const page = db.prepare(`
      SELECT original_text FROM pages
      WHERE book_id = ? AND page_number = 1
    `).get(book.id) as { original_text: string } | undefined;

    if (page) {
      const coverPath = extractCoverFromHtml(page.original_text);
      if (coverPath) {
        db.prepare('UPDATE books SET cover_image_path = ? WHERE id = ?').run(coverPath, book.id);
        updated++;
        continue;
      }
    }

    // Strategy 2: Re-extract cover from EPUB file on disk
    if (book.file_type === 'epub') {
      const coverPath = await extractCoverFromEpubFile(book.file_path);
      if (coverPath) {
        db.prepare('UPDATE books SET cover_image_path = ? WHERE id = ?').run(coverPath, book.id);
        updated++;
        continue;
      }
    }

    // Strategy 3: Render PDF first page as cover image
    if (book.file_type === 'pdf') {
      const coverPath = await extractCoverFromPdf(book.file_path);
      if (coverPath) {
        db.prepare('UPDATE books SET cover_image_path = ? WHERE id = ?').run(coverPath, book.id);
        updated++;
      }
    }
  }

  console.log(`📚 Backfilled ${updated}/${books.length} book covers`);
}

export function toggleBookPin(userId: number, bookId: number, pinned: boolean) {
  assertBookAccess(userId, bookId);
  return db.prepare(`
    INSERT INTO user_book_progress (user_id, book_id, is_pinned, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, book_id) DO UPDATE SET is_pinned = ?, updated_at = CURRENT_TIMESTAMP
  `).run(userId, bookId, pinned ? 1 : 0, pinned ? 1 : 0);
}

export function updateReadingStatus(userId: number, bookId: number, status: ReadingStatus) {
  assertBookAccess(userId, bookId);
  if (!READING_STATUSES.has(status)) {
    const error = new Error('无效的阅读状态') as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  db.prepare(`
    INSERT INTO user_book_progress (user_id, book_id, reading_status, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, book_id) DO UPDATE SET reading_status = ?, updated_at = CURRENT_TIMESTAMP
  `).run(userId, bookId, status, status);

  return getBookById(bookId, userId);
}
