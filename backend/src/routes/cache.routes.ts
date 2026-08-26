import { Router } from 'express';
import { cacheService } from '../services/cache.service';
import { deduplicationService } from '../services/deduplication.service';
import { fileStorageService } from '../services/file-storage.service';
import { assertBookAccess } from '../services/book.service';

const router = Router();

// ========== Cache Statistics & Monitoring ==========

/**
 * GET /api/cache/stats
 * Return cache performance metrics
 */
router.get('/stats', async (req, res, next) => {
  try {
    const stats = cacheService.getStats();
    const exported = cacheService.exportStats();

    res.json({
      success: true,
      data: {
        ...exported,
        memoryStats: stats,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cache/storage
 * Return file storage statistics
 */
router.get('/storage', async (req, res, next) => {
  try {
    const storageStats = fileStorageService.getStorageStats();

    res.json({
      success: true,
      data: storageStats,
    });
  } catch (error) {
    next(error);
  }
});

// ========== Cache Management ==========

/**
 * POST /api/cache/clear
 * Clear in-memory cache
 */
router.post('/clear', async (req, res, next) => {
  try {
    cacheService.clearMemoryCache();

    res.json({
      success: true,
      message: '内存缓存已清空',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/cache/clear-by-book/:bookId
 * Clear cache for a specific book
 */
router.post('/clear-by-book/:bookId', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);

    if (isNaN(bookId)) {
      return res.status(400).json({ error: '书籍 ID 无效' });
    }
    assertBookAccess(req.userId!, bookId);

    cacheService.clearByBookId(bookId);

    res.json({
      success: true,
      message: `书籍 ${bookId} 的缓存已清空`,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/cache/cleanup
 * Clean up old cache entries
 */
router.post('/cleanup', async (req, res, next) => {
  try {
    const olderThanDays = req.body.olderThanDays || 30;
    const deletedCount = await cacheService.cleanupOldCache(olderThanDays);

    res.json({
      success: true,
      message: `已清理 ${deletedCount} 条过期缓存`,
      data: {
        deletedCount,
        olderThanDays,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/cache/optimize
 * Optimize database (VACUUM and ANALYZE)
 */
router.post('/optimize', async (req, res, next) => {
  try {
    await cacheService.optimizeDatabase();

    res.json({
      success: true,
      message: '数据库优化完成',
    });
  } catch (error) {
    next(error);
  }
});

// ========== Deduplication ==========

/**
 * GET /api/cache/dedup/stats
 * Return deduplication statistics
 */
router.get('/dedup/stats', async (req, res, next) => {
  try {
    const stats = await deduplicationService.getDeduplicationStats(req.userId!);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/cache/dedup/hash-unhashed
 * Hash all pages that don't have hashes yet
 */
router.post('/dedup/hash-unhashed', async (req, res, next) => {
  try {
    const result = await deduplicationService.hashUnhashedPages(req.userId!);

    res.json({
      success: result.error ? false : true,
      message: result.error || `已为 ${result.hashed} 页生成哈希`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cache/dedup/opportunities
 * Get optimization opportunities
 */
router.get('/dedup/opportunities', async (req, res, next) => {
  try {
    const minDuplicates = req.query.minDuplicates ? parseInt(req.query.minDuplicates as string) : 2;
    const opportunities = await deduplicationService.findOptimizationOpportunities(minDuplicates, req.userId!);

    res.json({
      success: true,
      data: {
        count: opportunities.length,
        opportunities,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/cache/dedup/conflicts
 * Find hash conflicts (validation)
 */
router.get('/dedup/conflicts', async (req, res, next) => {
  try {
    const conflicts = await deduplicationService.findHashConflicts(req.userId!);

    res.json({
      success: true,
      data: {
        count: conflicts.length,
        conflicts,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/cache/dedup/apply/:pageHash
 * Apply cached translation to all duplicate pages
 */
router.post('/dedup/apply/:pageHash', async (req, res, next) => {
  try {
    const pageHash = req.params.pageHash;

    const result = await deduplicationService.applyTranslationToDuplicates(pageHash, req.userId!);

    res.json({
      success: result.error ? false : true,
      message: result.error || `已将译文应用到 ${result.updated} 个重复页面`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// ========== File Storage ==========

/**
 * POST /api/cache/storage/cleanup
 * Clean up unused files
 */
router.post('/storage/cleanup', async (req, res, next) => {
  try {
    const result = await fileStorageService.cleanupUnusedFiles();

    res.json({
      success: result.error ? false : true,
      message: result.error || `已删除 ${result.deleted} 个未使用文件`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/cache/storage/migrate-to-blob/:bookId
 * Migrate file from disk to BLOB storage
 */
router.post('/storage/migrate-to-blob/:bookId', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);

    if (isNaN(bookId)) {
      return res.status(400).json({ error: '书籍 ID 无效' });
    }
    assertBookAccess(req.userId!, bookId);

    const result = await fileStorageService.migrateToBlob(bookId);

    res.json({
      success: result.success,
      message: result.error || `书籍 ${bookId} 已迁移到数据库 BLOB 存储`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/cache/storage/migrate-to-disk/:bookId
 * Migrate file from BLOB back to disk storage
 */
router.post('/storage/migrate-to-disk/:bookId', async (req, res, next) => {
  try {
    const bookId = parseInt(req.params.bookId);

    if (isNaN(bookId)) {
      return res.status(400).json({ error: '书籍 ID 无效' });
    }
    assertBookAccess(req.userId!, bookId);

    const result = await fileStorageService.migrateToDisk(bookId);

    res.json({
      success: result.success,
      message: result.error || `书籍 ${bookId} 已迁移回磁盘存储`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
