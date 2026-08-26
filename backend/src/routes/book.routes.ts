import { Router } from 'express';
import {
  getBookById,
  getPagesByBookId,
  updateLastReadPage,
  deleteBook,
  getPageWithTranslation,
  getBookCacheStats,
  getBookStorageInfo,
  getBookDeduplicationOpportunities,
  getBooksByFolder,
  moveBookToFolder,
  moveBooksToFolder,
  toggleBookPin,
  updateReadingStatus,
} from '../services/book.service';
import type { ReadingStatus } from '../services/book.service';
import { getErrorMessage } from '../utils/errors';

const router = Router();
const READING_STATUS_VALUES: ReadingStatus[] = ['unread', 'reading', 'paused', 'finished', 'abandoned'];

// Get all books with cache stats, optionally filtered by folder
router.get('/', (req, res, next) => {
  try {
    const { folderId } = req.query;
    const userId = req.userId!;
    let books: any[];

    if (folderId === undefined || folderId === 'all') {
      // Return all books
      books = getBooksByFolder(userId, 'all');
    } else if (folderId === 'null' || folderId === '') {
      // Return uncategorized books
      books = getBooksByFolder(userId, null);
    } else {
      // Return books in specific folder
      const parsedFolderId = parseInt(folderId as string);
      if (isNaN(parsedFolderId)) {
        return res.status(400).json({ success: false, error: '无效的文件夹ID' });
      }
      books = getBooksByFolder(userId, parsedFolderId);
    }

    res.json({ success: true, data: books });
  } catch (error) {
    next(error);
  }
});

// Batch move books to folder (must be before /:id routes)
router.put('/batch/folder', (req, res, next) => {
  try {
    const { bookIds, folderId } = req.body;

    if (!Array.isArray(bookIds) || bookIds.length === 0) {
      return res.status(400).json({ success: false, error: '请选择要移动的书籍' });
    }

    const targetFolderId = folderId === null || folderId === undefined ? null : parseInt(folderId);
    moveBooksToFolder(req.userId!, bookIds.map((id: unknown) => Number.parseInt(String(id), 10)), targetFolderId);

    res.json({ success: true, message: `已移动 ${bookIds.length} 本书籍` });
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    if (message === '文件夹不存在') {
      return res.status(404).json({ success: false, error: message });
    }
    next(error);
  }
});

// Get book by ID with detailed information
router.get('/:id', (req, res, next) => {
  try {
    const bookId = parseInt(req.params.id);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }
    const book = getBookById(bookId, req.userId!);

    if (!book) {
      return res.status(404).json({ error: '书籍不存在' });
    }

    const cacheStats = getBookCacheStats(bookId, req.userId!);
    const storageInfo = getBookStorageInfo(bookId, req.userId!);

    res.json({
      success: true,
      data: {
        ...book,
        cacheStats,
        storageInfo,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Get pages by book ID
router.get('/:id/pages', (req, res, next) => {
  try {
    const bookId = parseInt(req.params.id);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }
    const pageNumber = req.query.page ? parseInt(req.query.page as string) : undefined;
    const pages = getPagesByBookId(bookId, req.userId!, pageNumber);
    res.json({ success: true, data: pages });
  } catch (error) {
    next(error);
  }
});

// Get specific page with translation and cache info
router.get('/:id/page/:pageNumber', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.id);
    const pageNumber = parseInt(req.params.pageNumber);
    if (isNaN(bookId) || isNaN(pageNumber)) {
      return res.status(400).json({ success: false, error: '无效的参数' });
    }

    const page = await getPageWithTranslation(bookId, pageNumber, req.userId!);

    if (!page) {
      return res.status(404).json({ error: '页面不存在' });
    }

    res.json({
      success: true,
      data: page,
    });
  } catch (error) {
    next(error);
  }
});

// Get cache statistics for a book
router.get('/:id/cache-stats', (req, res, next) => {
  try {
    const bookId = parseInt(req.params.id);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }
    const stats = getBookCacheStats(bookId, req.userId!);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

// Get storage information for a book
router.get('/:id/storage-info', (req, res, next) => {
  try {
    const bookId = parseInt(req.params.id);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }
    const info = getBookStorageInfo(bookId, req.userId!);

    if (!info) {
      return res.status(404).json({ error: '书籍不存在' });
    }

    res.json({
      success: true,
      data: info,
    });
  } catch (error) {
    next(error);
  }
});

// Get deduplication opportunities for a book
router.get('/:id/dedup-opportunities', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.id);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }
    const opportunities = await getBookDeduplicationOpportunities(bookId, req.userId!);

    res.json({
      success: true,
      data: {
        bookId,
        count: opportunities.length,
        opportunities,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Toggle book pin
router.put('/:id/pin', (req, res, next) => {
  try {
    const bookId = parseInt(req.params.id);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }
    const { pinned } = req.body;
    toggleBookPin(req.userId!, bookId, !!pinned);
    res.json({ success: true, message: pinned ? '已置顶' : '已取消置顶' });
  } catch (error) {
    next(error);
  }
});

// Update user-scoped reading status
router.put('/:id/reading-status', (req, res, next) => {
  try {
    const bookId = parseInt(req.params.id);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }

    const status = req.body.status as ReadingStatus;
    if (!READING_STATUS_VALUES.includes(status)) {
      return res.status(400).json({ success: false, error: '无效的阅读状态' });
    }

    const book = updateReadingStatus(req.userId!, bookId, status);
    res.json({ success: true, message: '阅读状态已更新', data: book });
  } catch (error) {
    next(error);
  }
});

// Move book to folder
router.put('/:id/folder', (req, res, next) => {
  try {
    const bookId = parseInt(req.params.id);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }
    const { folderId } = req.body;

    const targetFolderId = folderId === null || folderId === undefined ? null : parseInt(folderId);
    moveBookToFolder(req.userId!, bookId, targetFolderId);

    res.json({ success: true, message: '书籍已移动' });
  } catch (error: unknown) {
    const message = getErrorMessage(error);
    if (message === '文件夹不存在' || message === '书籍不存在') {
      return res.status(404).json({ success: false, error: message });
    }
    next(error);
  }
});

// Update last read page
router.put('/:id/last-read', (req, res, next) => {
  try {
    const bookId = parseInt(req.params.id);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }
    const { pageNumber } = req.body;
    if (!pageNumber) {
      return res.status(400).json({ error: '缺少页码参数' });
    }
    updateLastReadPage(req.userId!, bookId, pageNumber);
    res.json({ success: true, message: '阅读进度已更新' });
  } catch (error) {
    next(error);
  }
});

// Delete book
router.delete('/:id', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.id);
    if (isNaN(bookId)) {
      return res.status(400).json({ success: false, error: '无效的书籍ID' });
    }
    await deleteBook(bookId, req.userId!);
    res.json({ success: true, message: '书籍已删除' });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === '书籍不存在') {
      return res.status(404).json({ success: false, error: error.message });
    }
    next(error);
  }
});

export default router;
