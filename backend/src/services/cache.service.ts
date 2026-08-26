import NodeCache from 'node-cache';
import { db } from '../config/database';

interface CacheEntry {
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  translationFingerprint: string;
  cachedAt: Date;
}

interface CacheStats {
  memoryHits: number;
  databaseHits: number;
  misses: number;
  hitRate: number;
  cacheSize: number;
  memoryUsage: number;
}

class CacheService {
  private cache: NodeCache;
  private initialized = false;
  private stats: CacheStats = {
    memoryHits: 0,
    databaseHits: 0,
    misses: 0,
    hitRate: 0,
    cacheSize: 0,
    memoryUsage: 0,
  };

  constructor() {
    const cacheTtl = parseInt(process.env.CACHE_TTL || '3600'); // 1 hour default
    const cacheMaxEntries = parseInt(process.env.CACHE_MAX_ENTRIES || '1000');

    this.cache = new NodeCache({
      stdTTL: cacheTtl,
      checkperiod: Math.floor(cacheTtl / 10),
      maxKeys: cacheMaxEntries,
    });

  }

  initialize(): void {
    if (this.initialized) return;
    this.loadStatsFromDatabase();
    this.initialized = true;
  }

  /**
   * Generate cache key from page hash and language pair
   */
  private generateCacheKey(
    pageHash: string,
    sourceLang: string,
    targetLang: string,
    translationFingerprint: string = 'legacy'
  ): string {
    return `${pageHash}:${sourceLang}:${targetLang}:${translationFingerprint}`;
  }

  /**
   * Get translation from cache (memory first, then database)
   */
  async getTranslation(
    pageHash: string,
    sourceLang: string,
    targetLang: string,
    translationFingerprint: string = 'legacy'
  ): Promise<CacheEntry | null> {
    const cacheKey = this.generateCacheKey(pageHash, sourceLang, targetLang, translationFingerprint);

    // Try memory cache first
    const memoryEntry = this.cache.get<CacheEntry>(cacheKey);
    if (memoryEntry) {
      this.stats.memoryHits++;
      this.updateCacheStats();
      return memoryEntry;
    }

    // Try database cache
    try {
      const query = db.prepare(`
        SELECT translated_text, source_lang, target_lang, translation_fingerprint, created_at
        FROM page_cache
        WHERE page_hash = ? AND source_lang = ? AND target_lang = ? AND translation_fingerprint = ?
        LIMIT 1
      `);

      const result = query.get(pageHash, sourceLang, targetLang, translationFingerprint) as any;

      if (result) {
        const entry: CacheEntry = {
          translatedText: result.translated_text,
          sourceLang: result.source_lang,
          targetLang: result.target_lang,
          translationFingerprint: result.translation_fingerprint,
          cachedAt: new Date(result.created_at),
        };

        // Populate memory cache from database
        this.cache.set(cacheKey, entry);
        this.stats.databaseHits++;
        this.updateCacheStats();
        return entry;
      }
    } catch (error) {
      console.error('Error fetching from database cache:', error);
    }

    // Cache miss
    this.stats.misses++;
    this.updateCacheStats();
    return null;
  }

  /**
   * Set translation in both memory and database cache
   */
  async setTranslation(
    pageHash: string,
    sourceLang: string,
    targetLang: string,
    translatedText: string,
    translationFingerprint: string = 'legacy'
  ): Promise<void> {
    const cacheKey = this.generateCacheKey(pageHash, sourceLang, targetLang, translationFingerprint);

    const entry: CacheEntry = {
      translatedText,
      sourceLang,
      targetLang,
      translationFingerprint,
      cachedAt: new Date(),
    };

    // Store in memory cache
    this.cache.set(cacheKey, entry);

    // Store in database cache
    try {
      db.prepare(`
        INSERT INTO page_cache (page_hash, source_lang, target_lang, translation_fingerprint, translated_text, created_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(page_hash, source_lang, target_lang, translation_fingerprint)
        DO UPDATE SET translated_text = ?, updated_at = CURRENT_TIMESTAMP
      `).run(pageHash, sourceLang, targetLang, translationFingerprint, translatedText, translatedText);

      // Update cache metadata
      db.prepare(`
        UPDATE cache_metadata
        SET total_cached_pages = (SELECT COUNT(*) FROM page_cache),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run();
    } catch (error) {
      console.error('Error saving to database cache:', error);
    }

    this.updateCacheStats();
  }

  /**
   * Invalidate cache entry (remove from memory and mark for refresh in DB)
   */
  invalidate(pageHash: string): void {
    // Remove all entries with this page hash
    const keys = this.cache.keys();
    keys.forEach((key) => {
      if (key.startsWith(`${pageHash}:`)) {
        this.cache.del(key);
      }
    });
  }

  /**
   * Clear entire memory cache
   */
  clearMemoryCache(): void {
    this.cache.flushAll();
    console.log('Memory cache cleared');
  }

  /**
   * Clear cache by book ID (remove all pages from this book)
   */
  clearByBookId(bookId: number): void {
    try {
      // Get all page hashes for this book
      const pages = db.prepare(`
        SELECT DISTINCT page_hash FROM pages WHERE book_id = ? AND page_hash IS NOT NULL
      `).all(bookId) as any[];

      pages.forEach((page) => {
        if (page.page_hash) {
          this.invalidate(page.page_hash);
        }
      });

      console.log(`Cache cleared for book ${bookId}`);
    } catch (error) {
      console.error('Error clearing cache by book ID:', error);
    }
  }

  /**
   * Get current cache statistics
   */
  getStats(): CacheStats {
    return {
      ...this.stats,
      cacheSize: this.cache.keys().length,
      memoryUsage: this.getMemoryUsage(),
    };
  }

  /**
   * Get memory usage (rough estimate)
   */
  private getMemoryUsage(): number {
    const keys = this.cache.keys();
    let totalSize = 0;

    keys.forEach((key) => {
      const value = this.cache.get(key);
      if (value && typeof value === 'object') {
        totalSize += JSON.stringify(value).length;
      }
    });

    return totalSize;
  }

  /**
   * Update cache statistics in database
   */
  private updateCacheStats(): void {
    const total = this.stats.memoryHits + this.stats.databaseHits + this.stats.misses;
    this.stats.hitRate = total > 0 ? (this.stats.memoryHits + this.stats.databaseHits) / total : 0;

    try {
      db.prepare(`
        UPDATE cache_metadata
        SET cache_hits = ?, cache_misses = ?, hit_rate = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run(this.stats.memoryHits + this.stats.databaseHits, this.stats.misses, this.stats.hitRate);
    } catch (error) {
      console.error('Error updating cache metadata:', error);
    }
  }

  /**
   * Load cache statistics from database
   */
  private loadStatsFromDatabase(): void {
    try {
      const metadata = db.prepare(`
        SELECT cache_hits, cache_misses, hit_rate FROM cache_metadata WHERE id = 1
      `).get() as any;

      if (metadata) {
        this.stats.memoryHits = Math.ceil((metadata.cache_hits * metadata.hit_rate) / (metadata.hit_rate + 0.001));
        this.stats.databaseHits = metadata.cache_hits - this.stats.memoryHits;
        this.stats.misses = metadata.cache_misses;
        this.stats.hitRate = metadata.hit_rate;
      }
    } catch (error) {
      console.error('Error loading cache metadata:', error);
    }
  }

  /**
   * Clean up old cache entries (run periodically)
   */
  async cleanupOldCache(olderThanDays: number = 30): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const result = db.prepare(`
        DELETE FROM page_cache
        WHERE created_at < ?
      `).run(cutoffDate.toISOString());

      const deletedCount = (result as any).changes || 0;

      // Update metadata
      db.prepare(`
        UPDATE cache_metadata
        SET total_cached_pages = (SELECT COUNT(*) FROM page_cache),
            last_cleaned_at = CURRENT_TIMESTAMP
        WHERE id = 1
      `).run();

      console.log(`Cleaned up ${deletedCount} old cache entries (older than ${olderThanDays} days)`);
      return deletedCount;
    } catch (error) {
      console.error('Error cleaning up old cache:', error);
      return 0;
    }
  }

  /**
   * Optimize database (VACUUM and ANALYZE)
   */
  async optimizeDatabase(): Promise<void> {
    try {
      db.exec('VACUUM');
      db.exec('ANALYZE');
      console.log('Database optimized successfully');
    } catch (error) {
      console.error('Error optimizing database:', error);
    }
  }

  /**
   * Export cache statistics for monitoring
   */
  exportStats(): {
    totalHits: number;
    totalMisses: number;
    hitRate: string;
    cacheSize: number;
    memoryUsage: string;
  } {
    const stats = this.getStats();
    return {
      totalHits: stats.memoryHits + stats.databaseHits,
      totalMisses: stats.misses,
      hitRate: (stats.hitRate * 100).toFixed(2) + '%',
      cacheSize: stats.cacheSize,
      memoryUsage: (stats.memoryUsage / 1024).toFixed(2) + ' KB',
    };
  }
}

// Singleton instance
export const cacheService = new CacheService();

let cleanupScheduled = false;

export function initializeCacheService(): void {
  cacheService.initialize();
  if (cleanupScheduled || process.env.CACHE_CLEANUP_ENABLED === 'false') return;
  cleanupScheduled = true;

  const cleanupHour = parseInt(process.env.CACHE_CLEANUP_HOUR || '2');
  const cleanupIntervalMs = 24 * 60 * 60 * 1000; // 24 hours

  // Calculate time until next cleanup
  const now = new Date();
  const nextCleanup = new Date();
  nextCleanup.setHours(cleanupHour, 0, 0, 0);
  if (nextCleanup < now) {
    nextCleanup.setDate(nextCleanup.getDate() + 1);
  }

  const msUntilNextCleanup = nextCleanup.getTime() - now.getTime();

  setTimeout(() => {
    const retentionDays = parseInt(process.env.CACHE_RETENTION_DAYS || '30');
    cacheService.cleanupOldCache(retentionDays);

    // Schedule for daily execution
    setInterval(() => {
      cacheService.cleanupOldCache(retentionDays);
    }, cleanupIntervalMs);
  }, msUntilNextCleanup);
}
